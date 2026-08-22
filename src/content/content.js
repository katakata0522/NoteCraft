(function () {
  'use strict';

  var Core = globalThis.NoteCraftCore;
  if (!Core) return;
  if (window.__notecraft_v07_loaded) return;
  window.__notecraft_v07_loaded = true;

  var SNAPSHOT_INTERVAL_MS = 60000;
  var EDIT_IDLE_SAVE_MS = 5000;
  var ROUTE_POLL_MS = 250;
  var ROUTE_SETTLE_MS = 650;
  var EDITOR_CONFIRM_MS = 250;
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
  var candidateEditor = null;
  var candidateSince = 0;
  var resolvingAttach = false;

  function send(message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('保存処理がタイムアウトしました。拡張機能またはnoteタブを再読み込みしてください'));
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
    saveSnapshot: function (articleId, text, mode) { return send({ type: 'NC_SAVE_SNAP', articleId: articleId, text: text, mode: mode }); },
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
      ':host{all:initial}',
      '*{box-sizing:border-box}',
      '.panel{position:fixed;top:76px;right:18px;width:300px;max-width:calc(100vw - 24px);max-height:76vh;overflow:auto;z-index:2147483000;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif;',
      'color:#1f2523;background:#fff;border:1px solid rgba(23,32,29,.12);border-radius:14px;box-shadow:0 12px 34px rgba(17,29,25,.16)}',
      '.panel.left{right:auto;left:18px}',
      '.head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px 8px;border-bottom:1px solid #edf0ef}',
      '.brand{font-size:12px;font-weight:750;letter-spacing:.01em}.badge{font-size:10px;color:#65716d;margin-left:6px}',
      '.head-actions{display:flex;align-items:center;gap:2px}.ghost{appearance:none;border:0;background:transparent;color:#67736f;font-size:11px;cursor:pointer;padding:5px 6px;border-radius:6px}',
      '.body{padding:11px 12px 12px}',
      '.count{font-size:28px;line-height:1.05;font-weight:760;letter-spacing:-.03em}',
      '.sub{font-size:11px;color:#7a8581;margin-top:5px}',
      '.status-row{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:stretch;margin-top:9px}',
      '.status{padding:7px 8px;border-radius:9px;background:#f3f7f5;font-size:11px;color:#4f5b57;min-width:0}',
      '.status.warn{background:#fff7e7;color:#805b13}.status.error{background:#fff0ef;color:#9b322d}',
      '.save-now{appearance:none;border:1px solid #dce5e1;background:#fff;color:#3d4b46;border-radius:9px;padding:0 8px;font-size:10px;font-weight:650;cursor:pointer;white-space:nowrap}.save-now:disabled{opacity:.42;cursor:default}',
      '.trace{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}',
      '.metric{padding:8px;border:1px solid #edf0ef;border-radius:10px}.metric-label{font-size:10px;color:#7d8884}.metric-value{margin-top:2px;font-size:14px;font-weight:700}',
      '.section{margin-top:12px}.section-title{font-size:11px;font-weight:750;color:#4e5a56;margin-bottom:4px}',
      '.history{display:flex;flex-direction:column;gap:3px}',
      '.row{display:block;padding:6px 4px;border-radius:7px}',
      '.row:hover{background:#f7f9f8}.time{font-size:11px;color:#59645f;min-width:0}.time small{display:block;color:#929b98;font-size:9.5px;margin-top:1px}',
      '.history-open{width:100%;margin-top:9px;border:0;border-radius:9px;background:#16856f;color:#fff;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer}',
      '.history-open:disabled{opacity:.38;cursor:default}',
      '.empty{font-size:11px;color:#8a9490;padding:5px 0}',
      '.foot{font-size:9.5px;line-height:1.45;color:#929a97;margin-top:10px}',
      'button:focus-visible,input:focus-visible{outline:2px solid #16856f;outline-offset:2px}',
      '</style>',
      '<div class="panel" id="panel" role="region" aria-label="NoteCraft 本文保護">',
      '  <div class="head"><div><span class="brand">NoteCraft</span><span class="badge">Spike v0.7</span></div><div class="head-actions"><button class="ghost" id="side" type="button" aria-label="パネルを反対側へ移動">左右</button><button class="ghost" id="toggle" type="button" aria-expanded="true">最小化</button></div></div>',
      '  <div class="body" id="body">',
      '    <div class="count" id="count">—</div>',
      '    <div class="sub">現在の本文テキスト文字数</div>',
      '    <div class="status-row"><div class="status" id="status" role="status" aria-live="polite">エディタを確認しています…</div><button class="save-now" id="saveNow" type="button" disabled>今すぐ保護</button></div>',
      '    <div class="trace">',
      '      <div class="metric"><div class="metric-label">追加（本日初回観測比）</div><div class="metric-value" id="added">+0字</div></div>',
      '      <div class="metric"><div class="metric-label">削除（本日初回観測比）</div><div class="metric-value" id="removed">-0字</div></div>',
      '    </div>',
      '    <div class="section"><div class="section-title">本文履歴 <span style="font-weight:400;color:#909995">最大5世代</span></div><div class="history" id="history"></div></div>',
      '    <button class="history-open" id="historyOpen" type="button" disabled>安全な履歴画面を開く</button>',
      '    <div class="foot">保護対象は本文テキストのみです。過去本文・コピー・差分はnoteページから分離した拡張機能専用画面で扱います。外部送信・note本文への書き戻しは行いません。</div>',
      '  </div>',
      '</div>'
    ].join('');
    document.documentElement.appendChild(host);

    ui.panel = shadow.getElementById('panel');
    ui.body = shadow.getElementById('body');
    ui.count = shadow.getElementById('count');
    ui.status = shadow.getElementById('status');
    ui.added = shadow.getElementById('added');
    ui.removed = shadow.getElementById('removed');
    ui.history = shadow.getElementById('history');
    ui.historyOpen = shadow.getElementById('historyOpen');

    shadow.getElementById('toggle').addEventListener('click', function () {
      var hidden = ui.body.style.display === 'none';
      ui.body.style.display = hidden ? '' : 'none';
      this.textContent = hidden ? '最小化' : '開く';
      this.setAttribute('aria-expanded', hidden ? 'true' : 'false');
    });
    shadow.getElementById('side').addEventListener('click', function () { ui.panel.classList.toggle('left'); });
    var saveNow = shadow.getElementById('saveNow');
    ui.saveNow = saveNow;
    saveNow.addEventListener('click', async function () {
      saveNow.disabled = true;
      try { await takeSnapshot('手動', attached, 'checkpoint'); } finally { saveNow.disabled = false; }
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

  function setStatus(text, kind) {
    if (!host) return;
    ui.status.textContent = text;
    ui.status.className = kind === 'error' ? 'status error' : (kind === 'warn' ? 'status warn' : 'status');
  }

  function friendlyError(error) {
    var detail = error && error.message ? error.message : String(error || '不明なエラー');
    if (/context invalidated|Receiving end does not exist|Extension context/i.test(detail)) return '拡張機能が更新された可能性があります。noteタブを再読み込みしてください';
    if (/安全上限|256MB/.test(detail)) return 'ローカル保存が安全上限に達しました。履歴画面から不要な履歴を削除してください';
    if (/大きすぎ|500,000/.test(detail)) return '本文が技術検証版の保護上限（500,000文字）を超えています';
    if (/blocked|ブロック/.test(detail)) return '保存領域が別タブの処理待ちです。noteタブを再読み込みしてください';
    if (/article mismatch|draft mapping mismatch|access denied|route/i.test(detail)) return '記事切替を検知したため、この保存は安全のため見送りました';
    if (/timeout|タイムアウト/.test(detail)) return '保存処理が応答しませんでした。noteタブを再読み込みしてください';
    return 'ローカル保存で問題が発生しました。noteタブを再読み込みして再確認してください';
  }

  function showError(prefix, error) {
    console.warn('[NoteCraft]', prefix, error);
    setStatus(prefix + ': ' + friendlyError(error), 'error');
  }

  function findEditor() {
    var primary = Array.prototype.slice.call(document.querySelectorAll('div.ProseMirror[contenteditable="true"]'));
    primary = primary.filter(function (el) { return document.documentElement.contains(el); });
    if (primary.length === 1) return primary[0];
    if (primary.length > 1) {
      var rolePrimary = primary.filter(function (el) { return el.getAttribute('role') === 'textbox'; });
      if (rolePrimary.length === 1) return rolePrimary[0];
      return null;
    }
    var fallback = Array.prototype.slice.call(document.querySelectorAll('div[contenteditable="true"][role="textbox"]'));
    fallback = fallback.filter(function (el) { return document.documentElement.contains(el); });
    return fallback.length === 1 ? fallback[0] : null;
  }

  function currentRoute() { return Core.parseNoteRoute(location.href); }

  function isAttachedCurrent() {
    if (!attached) return false;
    var route = currentRoute();
    if (!route || route.routeKey !== attached.routeKey) return false;
    if (!document.documentElement.contains(attached.editor)) return false;
    return findEditor() === attached.editor;
  }

  function detach(reason) {
    generation++;
    if (observer) observer.disconnect();
    observer = null;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = null;
    if (traceTimer) clearTimeout(traceTimer);
    traceTimer = null;
    if (editSaveTimer) clearTimeout(editSaveTimer);
    editSaveTimer = null;
    attached = null;
    candidateEditor = null;
    candidateSince = 0;
    resolvingAttach = false;
    if (host) {
      ui.count.textContent = '—';
      ui.added.textContent = '+0字';
      ui.removed.textContent = '-0字';
      ui.history.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '記事を確認しています…';
      ui.history.appendChild(empty);
      ui.historyOpen.disabled = true;
      ui.saveNow.disabled = true;
      if (reason) setStatus(reason);
    }
  }

  async function resolveArticleId(route, editorText, gen) {
    var migrationWarning = null;
    if (route.kind === 'article') {
      if (editorText) {
        try {
          var migration = await store.claimDraft(route.articleId, editorText);
          if (migration && migration.migrated === false && migration.reason && migration.reason !== 'no exact draft match') migrationWarning = '一時履歴を安全に引き継げませんでした';
        } catch (_) { migrationWarning = '一時履歴の引き継ぎに失敗しました'; }
      }
      if (gen !== generation) return null;
      return { articleId: route.articleId, migrationWarning: migrationWarning };
    }
    var tempId = await store.getTempId();
    if (gen !== generation) return null;
    return { articleId: tempId, migrationWarning: null };
  }

  async function attachEditor(route, editor) {
    var gen = generation;
    resolvingAttach = true;
    try {
      var resolved = await resolveArticleId(route, editor.innerText, gen);
      if (!resolved || gen !== generation) return;
      var current = currentRoute();
      if (!current || current.routeKey !== route.routeKey || editor !== findEditor()) return;
      attached = { gen: gen, articleId: resolved.articleId, routeKey: route.routeKey, editor: editor, migrationWarning: resolved.migrationWarning, dayBaseDateKey: null, dayBaseText: null };
      observer = new MutationObserver(onEditorMutation);
      observer.observe(editor, { childList: true, subtree: true, characterData: true });
      buildUI();
      ui.saveNow.disabled = false;
      updateCount();
      await initializeAttached(attached);
    } catch (error) {
      if (gen === generation) showError('初期化エラー', error);
    } finally {
      if (gen === generation) resolvingAttach = false;
    }
  }

  function onEditorMutation() {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function () { if (isAttachedCurrent()) updateCount(); }, MUTATION_DEBOUNCE_MS);
    if (traceTimer) clearTimeout(traceTimer);
    var traceCtx = attached;
    traceTimer = setTimeout(function () { updateToday(traceCtx); }, TRACE_DEBOUNCE_MS);
    if (editSaveTimer) clearTimeout(editSaveTimer);
    var ctx = attached;
    editSaveTimer = setTimeout(function () { takeSnapshot('編集後', ctx, 'rolling'); }, EDIT_IDLE_SAVE_MS);
  }

  function updateCount() {
    if (!isAttachedCurrent()) return;
    ui.count.textContent = Core.countChars(attached.editor.innerText).toLocaleString() + '字';
  }

  async function initializeAttached(ctx) {
    var text = ctx.editor.innerText;
    var saveResult;
    try { saveResult = await store.saveSnapshot(ctx.articleId, text, 'checkpoint'); }
    catch (error) { if (isSameContext(ctx)) showError('保存エラー', error); return; }
    if (!isSameContext(ctx)) return;
    var snaps;
    try { snaps = await store.listSnapshots(ctx.articleId); }
    catch (error) { if (isSameContext(ctx)) showError('履歴読込エラー', error); return; }
    if (!isSameContext(ctx)) return;
    renderHistory(snaps);
    var shownTs = saveResult && saveResult.ts ? saveResult.ts : (snaps.length ? snaps[snaps.length - 1].ts : null);
    setStatus((saveResult && saveResult.saved ? '本文テキスト保護済み ' : '変更なし · 保護済み ') + (shownTs ? Core.fmtTime(shownTs) : '—') + ' · 初期');
    var dateKey = Core.localDateKey();
    try {
      var base = await store.ensureDayBase(ctx.articleId, dateKey, text);
      if (isSameContext(ctx) && base) { ctx.dayBaseDateKey = dateKey; ctx.dayBaseText = base.baseText || ''; }
    } catch (_) {}
    if (!isSameContext(ctx)) return;
    await updateToday(ctx);
    if (ctx.migrationWarning && isSameContext(ctx)) setStatus('現在の原稿は保存済み · ' + ctx.migrationWarning, 'warn');
  }

  function isSameContext(ctx) {
    return !!attached && attached.gen === ctx.gen && attached.articleId === ctx.articleId && attached.editor === ctx.editor && isAttachedCurrent();
  }

  async function updateToday(ctx) {
    ctx = ctx || attached;
    if (!ctx || !isSameContext(ctx)) return;
    try {
      var dateKey = Core.localDateKey();
      if (ctx.dayBaseDateKey !== dateKey || ctx.dayBaseText === null) {
        var rec = await store.getDayBase(ctx.articleId, dateKey);
        if (!isSameContext(ctx)) return;
        if (!rec) { rec = await store.ensureDayBase(ctx.articleId, dateKey, ctx.editor.innerText); if (!isSameContext(ctx)) return; }
        ctx.dayBaseDateKey = dateKey;
        ctx.dayBaseText = rec ? (rec.baseText || '') : '';
      }
      var stats = Core.computeDeltaStats(ctx.dayBaseText || '', ctx.editor.innerText);
      ui.added.textContent = '+' + stats.added.toLocaleString() + '字';
      ui.removed.textContent = '-' + stats.removed.toLocaleString() + '字';
    } catch (_) {}
  }

  async function takeSnapshot(reason, ctx, mode) {
    ctx = ctx || attached;
    mode = mode || 'rolling';
    if (!ctx || !isSameContext(ctx)) return;
    var route = currentRoute();
    if (!route || route.routeKey !== ctx.routeKey) return;
    var text = ctx.editor.innerText;
    try {
      var result = await store.saveSnapshot(ctx.articleId, text, mode);
      if (!isSameContext(ctx)) return;
      var shownTs = result && result.ts ? result.ts : null;
      var statusPrefix = result && result.saved ? (result.replaced ? '本文テキスト保護済み（最新世代更新） ' : '本文テキスト保護済み ') : (result && result.promoted ? 'チェックポイント確定 ' : '変更なし · 保護済み ');
      setStatus(statusPrefix + (shownTs ? Core.fmtTime(shownTs) : '—') + (reason ? ' · ' + reason : ''));
      if (result && (result.saved || result.promoted)) {
        var snaps = await store.listSnapshots(ctx.articleId);
        if (isSameContext(ctx)) renderHistory(snaps);
      }
      updateToday(ctx);
    } catch (error) { if (isSameContext(ctx)) showError('保存エラー', error); }
  }

  function renderHistory(snaps) {
    ui.history.innerHTML = '';
    ui.historyOpen.disabled = true;
    if (!snaps || !snaps.length) { ui.history.innerHTML = '<div class="empty">まだ本文履歴がありません</div>'; return; }
    var rows = snaps.slice().sort(function (a, b) { return b.ts - a.ts; });
    rows.forEach(function (snap) {
      var row = document.createElement('div'); row.className = 'row';
      var time = document.createElement('div'); time.className = 'time';
      var kindLabel = snap.kind === 'rolling' ? '自動保護' : 'チェックポイント';
      time.textContent = Core.fmtDateTime(snap.ts);
      var meta = document.createElement('small'); meta.textContent = Number(snap.charCount || 0).toLocaleString() + '字 · ' + kindLabel;
      time.appendChild(meta); row.appendChild(time); ui.history.appendChild(row);
    });
    ui.historyOpen.disabled = false;
  }

  function routeTick() {
    if (location.href !== lastHref) { lastHref = location.href; routeStableSince = performance.now(); detach('ページ遷移を確認中…'); return; }
    var route = currentRoute();
    if (!route) { if (attached) detach('note編集画面でのみ動作します'); if (host) host.style.display = 'none'; return; }
    buildUI(); host.style.display = '';
    if (attached) {
      if (!isAttachedCurrent()) { detach('エディタの更新を確認中…'); routeStableSince = performance.now(); return; }
      return;
    }
    if (resolvingAttach) return;
    if (performance.now() - routeStableSince < ROUTE_SETTLE_MS) return;
    var editor = findEditor();
    if (!editor) { candidateEditor = null; candidateSince = 0; setStatus('本文エディタを待っています…'); return; }
    if (editor !== candidateEditor) { candidateEditor = editor; candidateSince = performance.now(); return; }
    if (performance.now() - candidateSince < EDITOR_CONFIRM_MS) return;
    attachEditor(route, editor);
  }

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !message || message.type !== 'NC_INTERNAL_HISTORY_RESET') return false;
    var ctx = attached;
    if (!ctx || message.articleId !== ctx.articleId || !isSameContext(ctx)) return false;
    ctx.dayBaseDateKey = null;
    ctx.dayBaseText = null;
    renderHistory([]);
    ui.added.textContent = '+0字';
    ui.removed.textContent = '-0字';
    setStatus('過去履歴をリセットしました · 自動保護は継続中');
    return false;
  });

  setInterval(routeTick, ROUTE_POLL_MS);
  setInterval(function () { takeSnapshot('60秒', attached, 'checkpoint'); }, SNAPSHOT_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') takeSnapshot('非表示前', attached, 'rolling'); });
  window.addEventListener('pagehide', function () { takeSnapshot('ページ離脱前', attached, 'rolling'); });
  routeTick();
})();
