'use strict';
async function attachEditor(route, editor) {
  var gen = generation;
  resolvingAttach = true;
  try {
    var resolved = await resolveArticleId(route, editor.innerText, gen);
    if (!resolved || gen !== generation) return;
    var current = currentRoute();
    if (!current || current.routeKey !== route.routeKey || editor !== findEditor()) return;
    attached = { gen: gen, articleId: resolved.articleId, routeKey: route.routeKey, editor: editor, sessionId: crypto.randomUUID(), migrationWarning: resolved.migrationWarning, dayBaseDateKey: null, dayBaseText: null };
    observer = new MutationObserver(onEditorMutation);
    observer.observe(editor, { childList: true, subtree: true, characterData: true });
    buildUI(); ui.saveNow.disabled = false; ui.historyOpen.disabled = false; updateCount(); await initializeAttached(attached);
  } catch (error) { if (gen === generation) showError('初期化エラー', error); }
  finally { if (gen === generation) resolvingAttach = false; }
}

function onEditorMutation() {
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(function () { if (attached && sameRouteAndNode(attached)) updateCount(); }, MUTATION_DEBOUNCE_MS);
  if (traceTimer) clearTimeout(traceTimer);
  var traceCtx = attached; traceTimer = setTimeout(function () { updateToday(traceCtx); }, TRACE_DEBOUNCE_MS);
  if (editSaveTimer) clearTimeout(editSaveTimer);
  var saveCtx = attached; editSaveTimer = setTimeout(function () { takeSnapshot('編集後', saveCtx, 'rolling', false); }, EDIT_IDLE_SAVE_MS);
}

function updateCount() { if (attached && sameRouteAndNode(attached)) ui.count.textContent = Core.countChars(attached.editor.innerText).toLocaleString() + '字'; }

async function initializeAttached(ctx) {
  var text = ctx.editor.innerText;
  var saveResult = null;
  var saveError = null;
  try { saveResult = await store.saveSnapshot(ctx.articleId, text, 'checkpoint', ctx.sessionId); }
  catch (error) { saveError = error; }
  if (!isSameContext(ctx)) return;

  var snaps = [];
  try { snaps = await store.listSnapshots(ctx.articleId); renderHistory(snaps); }
  catch (error) { showError('履歴読込エラー', error); }
  if (!isSameContext(ctx)) return;
  ui.historyOpen.disabled = false;

  if (saveError) {
    var lastTs = snaps.length ? snaps[snaps.length - 1].ts : null;
    setStatus('新しい保存に失敗 · ' + (lastTs ? '最終成功 ' + Core.fmtTime(lastTs) : '保存履歴なし'), 'error', true);
  } else {
    var shownTs = saveResult && saveResult.ts ? saveResult.ts : (snaps.length ? snaps[snaps.length - 1].ts : null);
    setStatus((saveResult && saveResult.saved ? '本文テキスト保護済み ' : '変更なし · 保護済み ') + (shownTs ? Core.fmtTime(shownTs) : '—') + ' · 初期');
  }

  var dateKey = Core.localDateKey();
  try {
    var base = await store.ensureDayBase(ctx.articleId, dateKey, text);
    if (isSameContext(ctx) && base) { ctx.dayBaseDateKey = dateKey; ctx.dayBaseText = base.baseText || ''; }
  } catch (error) { markTraceUnavailable(error); }
  if (!isSameContext(ctx)) return;
  await updateToday(ctx);
  if (ctx.migrationWarning && isSameContext(ctx)) setStatus('現在の原稿は保存済み · ' + ctx.migrationWarning, 'warn');
}

function markTraceUnavailable(error) {
  ui.added.textContent = '—'; ui.removed.textContent = '—'; ui.traceNote.textContent = 'TRACEを取得できません';
  if (error) console.warn('[NoteCraft] TRACE', error);
}

async function updateToday(ctx) {
  ctx = ctx || attached;
  if (!ctx || !isSameContext(ctx)) return;
  try {
    var dateKey = Core.localDateKey();
    if (ctx.dayBaseDateKey !== dateKey || ctx.dayBaseText === null) {
      var rec = await store.getDayBase(ctx.articleId, dateKey);
      if (!isSameContext(ctx)) return;
      if (!rec) rec = await store.ensureDayBase(ctx.articleId, dateKey, ctx.editor.innerText);
      if (!isSameContext(ctx)) return;
      ctx.dayBaseDateKey = dateKey; ctx.dayBaseText = rec ? (rec.baseText || '') : '';
    }
    var stats = Core.computeDeltaStats(ctx.dayBaseText || '', ctx.editor.innerText);
    ui.added.textContent = (stats.approximate ? '≈+' : '+') + stats.added.toLocaleString() + '字';
    ui.removed.textContent = (stats.approximate ? '≈-' : '-') + stats.removed.toLocaleString() + '字';
    ui.traceNote.textContent = stats.approximate ? '大きな差分のため概算 · 本日初回観測時点比' : '本日初回観測時点との本文差分';
  } catch (error) { if (isSameContext(ctx)) markTraceUnavailable(error); }
}

async function takeSnapshot(reason, ctx, mode, shouldAnnounce) {
  ctx = ctx || attached; mode = mode || 'rolling';
  if (!ctx || !isSameContext(ctx)) return;
  var text = ctx.editor.innerText;
  try {
    var result = await store.saveSnapshot(ctx.articleId, text, mode, ctx.sessionId);
    if (!isSameContext(ctx)) return;
    var prefix = result && result.saved ? (result.replaced ? '本文テキスト保護済み（最新世代更新） ' : '本文テキスト保護済み ') : (result && result.promoted ? 'チェックポイント確定 ' : '変更なし · 保護済み ');
    setStatus(prefix + (result && result.ts ? Core.fmtTime(result.ts) : '—') + (reason ? ' · ' + reason : ''), null, !!shouldAnnounce);
    if (result && (result.saved || result.promoted)) { var snaps = await store.listSnapshots(ctx.articleId); if (isSameContext(ctx)) renderHistory(snaps); }
    updateToday(ctx);
  } catch (error) { if (isSameContext(ctx)) showError('保存エラー', error); }
}

function renderHistory(snaps) {
  ui.history.textContent = '';
  if (!snaps || !snaps.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'まだ本文履歴がありません'; ui.history.appendChild(empty); return; }
  snaps.slice().sort(function (a, b) { return b.ts - a.ts; }).forEach(function (snap) {
    var row = document.createElement('div'); row.className = 'row'; var time = document.createElement('div'); time.className = 'time'; time.textContent = Core.fmtDateTime(snap.ts);
    var meta = document.createElement('small'); meta.textContent = Number(snap.charCount || 0).toLocaleString() + '字 · ' + (snap.kind === 'rolling' ? '自動保護' : 'チェックポイント');
    time.appendChild(meta); row.appendChild(time); ui.history.appendChild(row);
  });
}

async function reseedAfterReset(ctx) {
  if (!ctx || !isSameContext(ctx)) return;
  ctx.dayBaseDateKey = null; ctx.dayBaseText = null; renderHistory([]); markTraceUnavailable();
  var text = ctx.editor.innerText; var dateKey = Core.localDateKey();
  try {
    var base = await store.ensureDayBase(ctx.articleId, dateKey, text);
    if (!isSameContext(ctx)) return;
    ctx.dayBaseDateKey = dateKey; ctx.dayBaseText = base ? (base.baseText || '') : text;
    await takeSnapshot('履歴リセット後', ctx, 'checkpoint', false);
    if (isSameContext(ctx)) { ui.added.textContent = '+0字'; ui.removed.textContent = '-0字'; ui.traceNote.textContent = '本日初回観測時点との本文差分'; setStatus('過去履歴をリセットしました · 現在本文から保護を再開', null, true); }
  } catch (error) { if (isSameContext(ctx)) showError('保護再開エラー', error); }
}
