'use strict';

var Core = globalThis.NoteCraftCore;
if (!Core || window.__notecraft_v08_loaded) return;
window.__notecraft_v08_loaded = true;

var SNAPSHOT_INTERVAL_MS = 60000;
var EDIT_IDLE_SAVE_MS = 5000;
var ROUTE_POLL_MS = 500;
var ROUTE_SETTLE_MS = 650;
var EDITOR_CONFIRM_MS = 250;
var EDITOR_IDENTITY_CHECK_MS = 2000;
var MUTATION_DEBOUNCE_MS = 350;
var TRACE_DEBOUNCE_MS = 1200;
var MESSAGE_TIMEOUT_MS = 12000;

var host = null;
var shadow = null;
var ui = {};
var generation = 0;
var attached = null;
var observer = null;
var mutationTimer = null;
var traceTimer = null;
var editSaveTimer = null;
var lastHref = location.href;
var routeStableSince = performance.now();
var lastEditorIdentityCheckAt = 0;
var candidateEditor = null;
var candidateSince = 0;
var resolvingAttach = false;

function send(message) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('保存処理がタイムアウトしました'));
    }, MESSAGE_TIMEOUT_MS);
    chrome.runtime.sendMessage(message, function (response) {
      var runtimeError = chrome.runtime.lastError;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (!response || !response.ok) return reject(new Error(response && response.error ? response.error : 'no response'));
      resolve(response.result);
    });
  });
}

var store = {
  getTempId: function () { return send({ type: 'NC_GET_TEMP_ID' }); },
  claimDraft: function (articleId, text) { return send({ type: 'NC_CLAIM_DRAFT', articleId: articleId, text: text }); },
  listSnapshots: function (articleId) { return send({ type: 'NC_LIST_SNAPS', articleId: articleId }); },
  openHistory: function (articleId) { return send({ type: 'NC_OPEN_HISTORY', articleId: articleId }); },
  saveSnapshot: function (articleId, text, mode, sessionId) { return send({ type: 'NC_SAVE_SNAP', articleId: articleId, text: text, mode: mode, sessionId: sessionId }); },
  getDayBase: function (articleId, dateKey) { return send({ type: 'NC_GET_DAYBASE', articleId: articleId, dateKey: dateKey }); },
  ensureDayBase: function (articleId, dateKey, baseText) { return send({ type: 'NC_ENSURE_DAYBASE', articleId: articleId, dateKey: dateKey, baseText: baseText }); }
};

function buildUI() {
  if (host && document.documentElement.contains(host)) return;
  host = document.createElement('div');
  host.id = 'notecraft-spike-host';
  shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = [
    '<style>',
    ':host{all:initial}*{box-sizing:border-box}',
    '.panel{position:fixed;top:76px;right:18px;width:300px;max-width:calc(100vw - 24px);max-height:76vh;overflow:auto;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif;color:#1f2523;background:#fff;border:1px solid rgba(23,32,29,.12);border-radius:14px;box-shadow:0 12px 34px rgba(17,29,25,.16)}',
    '.panel.left{right:auto;left:18px}.head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px 8px;border-bottom:1px solid #edf0ef}',
    '.brand{font-size:13px;font-weight:750}.badge{font-size:11px;color:#596560;margin-left:6px}.head-actions{display:flex;gap:2px}.ghost{appearance:none;border:0;background:transparent;color:#53605b;font-size:12px;cursor:pointer;padding:5px 6px;border-radius:6px}',
    '.body{padding:11px 12px 12px}.count{font-size:28px;line-height:1.05;font-weight:760;letter-spacing:-.03em}.sub{font-size:12px;color:#66716d;margin-top:5px}',
    '.status-row{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:stretch;margin-top:9px}.status{padding:8px 9px;border-radius:9px;background:#f3f7f5;font-size:12px;color:#46534e;min-width:0}.status.warn{background:#fff7e7;color:#755313}.status.error{background:#fff0ef;color:#91302b}',
    '.save-now{appearance:none;border:1px solid #dce5e1;background:#fff;color:#34423d;border-radius:9px;padding:0 9px;font-size:11px;font-weight:650;cursor:pointer;white-space:nowrap}.save-now:disabled{opacity:.42;cursor:default}',
    '.trace{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.metric{padding:8px;border:1px solid #e5ebe8;border-radius:10px}.metric-label{font-size:11px;color:#68736f}.metric-value{margin-top:2px;font-size:14px;font-weight:700}.trace-note{font-size:10.5px;color:#6f7a76;margin-top:5px;min-height:1.4em}',
    '.section{margin-top:12px}.section-title{font-size:12px;font-weight:750;color:#45514d;margin-bottom:4px}.history{display:flex;flex-direction:column;gap:3px}.row{display:block;padding:6px 4px;border-radius:7px}.row:hover{background:#f7f9f8}.time{font-size:12px;color:#4e5a55}.time small{display:block;color:#69746f;font-size:11px;margin-top:1px}',
    '.history-open{width:100%;margin-top:9px;border:0;border-radius:9px;background:#16856f;color:#fff;padding:9px 10px;font-size:12px;font-weight:700;cursor:pointer}.history-open:disabled{opacity:.38;cursor:default}.empty{font-size:12px;color:#737e79;padding:5px 0}.foot{font-size:11px;line-height:1.5;color:#68736f;margin-top:10px}',
    '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    'button:focus-visible{outline:2px solid #16856f;outline-offset:2px}',
    '</style>',
    '<div class="panel" id="panel" role="region" aria-label="NoteCraft 本文保護">',
    '<div class="head"><div><span class="brand">NoteCraft</span><span class="badge">Spike v0.8</span></div><div class="head-actions"><button class="ghost" id="side" type="button" aria-label="パネルを反対側へ移動">左右</button><button class="ghost" id="toggle" type="button" aria-expanded="true">最小化</button></div></div>',
    '<div class="body" id="body"><div class="count" id="count">—</div><div class="sub">現在の本文テキスト文字数</div>',
    '<div class="status-row"><div class="status" id="status">エディタを確認しています…</div><button class="save-now" id="saveNow" type="button" disabled>今すぐ保護</button></div>',
    '<div class="trace"><div class="metric"><div class="metric-label">追加差分</div><div class="metric-value" id="added">—</div></div><div class="metric"><div class="metric-label">削除差分</div><div class="metric-value" id="removed">—</div></div></div><div class="trace-note" id="traceNote">本日初回観測時点との本文差分</div>',
    '<div class="section"><div class="section-title">本文履歴 <span style="font-weight:400;color:#69746f">最大5世代</span></div><div class="history" id="history"></div></div>',
    '<button class="history-open" id="historyOpen" type="button" disabled>安全な履歴画面を開く</button>',
    '<div class="foot">保護対象は本文テキストのみ。過去本文・コピー・差分は拡張機能専用画面で扱います。外部送信・note本文への書き戻しは行いません。</div></div>',
    '<div id="announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div></div>'
  ].join('');
  document.documentElement.appendChild(host);
  ['panel','body','count','status','added','removed','traceNote','history','historyOpen','saveNow','announcer'].forEach(function (id) { ui[id] = shadow.getElementById(id); });

  shadow.getElementById('toggle').addEventListener('click', function () {
    var hidden = ui.body.style.display === 'none';
    ui.body.style.display = hidden ? '' : 'none';
    this.textContent = hidden ? '最小化' : '開く';
    this.setAttribute('aria-expanded', hidden ? 'true' : 'false');
  });
  shadow.getElementById('side').addEventListener('click', function () { ui.panel.classList.toggle('left'); });
  ui.saveNow.addEventListener('click', async function () {
    ui.saveNow.disabled = true;
    try { await takeSnapshot('手動', attached, 'checkpoint', true); } finally { if (attached) ui.saveNow.disabled = false; }
  });
  ui.historyOpen.addEventListener('click', async function () {
    var ctx = attached;
    if (!ctx || !isSameContext(ctx)) return;
    ui.historyOpen.disabled = true;
    try { await store.openHistory(ctx.articleId); }
    catch (error) { if (isSameContext(ctx)) showError('履歴画面エラー', error); }
    finally { if (isSameContext(ctx)) ui.historyOpen.disabled = false; }
  });
}

function announce(text) {
  if (!ui.announcer) return;
  ui.announcer.textContent = '';
  setTimeout(function () { if (ui.announcer) ui.announcer.textContent = text; }, 0);
}
function setStatus(text, kind, shouldAnnounce) {
  if (!host) return;
  ui.status.textContent = text;
  ui.status.className = kind === 'error' ? 'status error' : (kind === 'warn' ? 'status warn' : 'status');
  if (shouldAnnounce) announce(text);
}
function friendlyError(error) {
  var detail = error && error.message ? error.message : String(error || '不明なエラー');
  if (/context invalidated|Receiving end does not exist|Extension context/i.test(detail)) return '拡張機能が更新された可能性があります。noteタブを再読み込みしてください';
  if (/256MB|安全上限/.test(detail)) return 'ローカル保存が安全上限に達しました。履歴画面から不要な履歴を削除してください';
  if (/invalid snapshot input|500000/.test(detail)) return '本文が技術検証版の保護上限を超えています';
  if (/article mismatch|draft mapping mismatch|access denied|route/i.test(detail)) return '記事切替を検知したため、この保存は安全のため見送りました';
  if (/timeout|タイムアウト/.test(detail)) return '保存処理が応答しませんでした。noteタブを再読み込みしてください';
  return 'ローカル保存で問題が発生しました。noteタブを再読み込みして再確認してください';
}
function showError(prefix, error) { console.warn('[NoteCraft]', prefix, error); setStatus(prefix + ': ' + friendlyError(error), 'error', true); }

function findEditor() {
  var primary = Array.prototype.slice.call(document.querySelectorAll('div.ProseMirror[contenteditable="true"]')).filter(function (el) { return document.documentElement.contains(el); });
  if (primary.length === 1) return primary[0];
  if (primary.length > 1) {
    var rolePrimary = primary.filter(function (el) { return el.getAttribute('role') === 'textbox'; });
    return rolePrimary.length === 1 ? rolePrimary[0] : null;
  }
  var fallback = Array.prototype.slice.call(document.querySelectorAll('div[contenteditable="true"][role="textbox"]')).filter(function (el) { return document.documentElement.contains(el); });
  return fallback.length === 1 ? fallback[0] : null;
}
function currentRoute() { return Core.parseNoteRoute(location.href); }
function sameRouteAndNode(ctx) {
  if (!ctx || generation !== ctx.gen) return false;
  var route = currentRoute();
  return !!route && route.routeKey === ctx.routeKey && document.documentElement.contains(ctx.editor);
}
function isSameContext(ctx) { return !!attached && attached === ctx && sameRouteAndNode(ctx); }

function detach(reason) {
  generation++;
  if (observer) observer.disconnect(); observer = null;
  if (mutationTimer) clearTimeout(mutationTimer); mutationTimer = null;
  if (traceTimer) clearTimeout(traceTimer); traceTimer = null;
  if (editSaveTimer) clearTimeout(editSaveTimer); editSaveTimer = null;
  attached = null; candidateEditor = null; candidateSince = 0; resolvingAttach = false;
  if (host) {
    ui.count.textContent = '—'; ui.added.textContent = '—'; ui.removed.textContent = '—'; ui.traceNote.textContent = '本日初回観測時点との本文差分';
    ui.history.textContent = ''; var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '記事を確認しています…'; ui.history.appendChild(empty);
    ui.historyOpen.disabled = true; ui.saveNow.disabled = true; if (reason) setStatus(reason);
  }
}

async function resolveArticleId(route, editorText, gen) {
  var warning = null;
  if (route.kind === 'article') {
    if (editorText) {
      try { var migration = await store.claimDraft(route.articleId, editorText); if (migration && migration.migrated === false && migration.reason && migration.reason !== 'no exact draft match') warning = '一時履歴を安全に引き継げませんでした'; }
      catch (_) { warning = '一時履歴の引き継ぎに失敗しました'; }
    }
    return gen === generation ? { articleId: route.articleId, migrationWarning: warning } : null;
  }
  var tempId = await store.getTempId();
  return gen === generation ? { articleId: tempId, migrationWarning: null } : null;
}
