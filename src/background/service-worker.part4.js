'use strict';
function historySenderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.documentId) throw new Error('unauthorized history sender');
  var url = new URL(sender.url || '');
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id || url.pathname !== '/src/ui/history.html') throw new Error('unauthorized history page');
  return { tabId: sender.tab.id, documentId: sender.documentId };
}
function validHistoryToken(v) { return typeof v === 'string' && /^[0-9a-f-]{30,60}$/i.test(v); }

async function putHistorySession(articleId, sourceTabId) {
  var db = await openDB(); var now = Date.now(); var token = crypto.randomUUID();
  var tx = db.transaction('historySessions', 'readwrite'); var done = txComplete(tx); var store = tx.objectStore('historySessions');
  var rows = await reqPromise(store.index('sourceTabId').getAll(sourceTabId));
  (rows || []).forEach(function (r) { if (!r.expiresAt || r.expiresAt <= now) store.delete(r.token); });
  var active = (rows || []).filter(function (r) { return r.expiresAt > now; });
  if (active.length >= 3) { try { tx.abort(); } catch (_) {} throw new Error('履歴画面は同じnoteタブから3つまで開けます'); }
  store.put({ token: token, articleId: articleId, sourceTabId: sourceTabId, historyTabId: null, historyDocumentId: null, createdAt: now, expiresAt: now + HISTORY_SESSION_TTL_MS });
  await done; return token;
}

async function openHistoryPage(ctx, articleId) {
  await authorizeRead(ctx, articleId);
  var now = Date.now(); var last = historyOpenCooldown.get(ctx.key) || 0;
  if (now - last < 3000) throw new Error('history window open throttled');
  historyOpenCooldown.set(ctx.key, now);
  var token = await putHistorySession(articleId, ctx.tabId);
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/history.html#' + token) }); } catch (e) { await deleteHistorySession(token).catch(function () {}); throw e; }
  return { opened: true };
}

async function deleteHistorySession(token) {
  if (!validHistoryToken(token)) return;
  var db = await openDB(); var tx = db.transaction('historySessions', 'readwrite'); var done = txComplete(tx); tx.objectStore('historySessions').delete(token); await done;
}

async function authorizeHistorySession(sender, token) {
  var ctx = historySenderContext(sender); if (!validHistoryToken(token)) throw new Error('invalid history token');
  var db = await openDB(); var tx = db.transaction('historySessions', 'readwrite'); var done = txComplete(tx); var store = tx.objectStore('historySessions'); var row = await reqPromise(store.get(token));
  if (!row || row.expiresAt < Date.now()) { if (row) store.delete(token); await done; throw new Error('history session expired'); }
  if (row.historyTabId == null) { row.historyTabId = ctx.tabId; row.historyDocumentId = ctx.documentId; }
  else if (row.historyTabId !== ctx.tabId || row.historyDocumentId !== ctx.documentId) { try { tx.abort(); } catch (_) {} throw new Error('history session is bound to another tab'); }
  row.expiresAt = Date.now() + HISTORY_SESSION_TTL_MS; store.put(row); await done; return row;
}

async function listSnapshotsForHistory(sender, token) { var s = await authorizeHistorySession(sender, token); return (await getSnapshotsRaw(s.articleId)).map(function (r) { return { ts: r.ts, charCount: r.charCount, kind: r.kind }; }); }
async function getSnapshotForHistory(sender, token, ts) { var s = await authorizeHistorySession(sender, token); if (!validTimestamp(ts)) throw new Error('invalid timestamp'); var db = await openDB(); var tx = db.transaction('snapshots', 'readonly'); var done = txComplete(tx); var r = await reqPromise(tx.objectStore('snapshots').get([s.articleId, ts])); await done; if (!r) throw new Error('snapshot not found'); return r; }
async function storageInfoForHistory(sender, token) { await authorizeHistorySession(sender, token); return getStorageInfo(); }
async function closeHistorySession(sender, token) { historySenderContext(sender); await deleteHistorySession(token); return { closed: true }; }

async function deleteArticleHistoryForHistory(sender, token) {
  var session = await authorizeHistorySession(sender, token); var articleId = session.articleId; var db = await openDB();
  var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases'], 'readwrite'); var done = txComplete(tx); var snaps = tx.objectStore('snapshots'); var bases = tx.objectStore('dayBases');
  var snapRows = await reqPromise(snaps.index('articleId').getAll(articleId)); var baseRows = await reqPromise(bases.index('articleId').getAll(articleId));
  snapRows.forEach(function (r) { snaps.delete([articleId, r.ts]); }); baseRows.forEach(function (r) { bases.delete([articleId, r.dateKey]); }); tx.objectStore('articleMeta').delete(articleId); await done; storageEstimateCache.checkedAt = 0;
  try { await chrome.tabs.sendMessage(session.sourceTabId, { type: 'NC_INTERNAL_HISTORY_RESET', articleId: articleId }); } catch (_) {}
  return { deleted: true, snapshots: snapRows.length };
}
