'use strict';
async function cleanupExpiredHistorySessions() {
  var db = await openDB(); var tx = db.transaction('historySessions', 'readwrite'); var done = txComplete(tx); var req = tx.objectStore('historySessions').index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()));
  req.onsuccess = function () { var c = req.result; if (!c) return; c.delete(); c.continue(); }; await done;
}

async function deleteDraftIfStale(articleId, cutoff) {
  if (!isDraftId(articleId)) return;
  var db = await openDB(); var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases', 'tabDrafts'], 'readwrite'); var done = txComplete(tx);
  var meta = await reqPromise(tx.objectStore('articleMeta').get(articleId)); var mappings = await reqPromise(tx.objectStore('tabDrafts').index('articleId').getAll(articleId));
  var last = meta && meta.updatedAt || 0; mappings.forEach(function (m) { last = Math.max(last, m.updatedAt || 0); }); if (last >= cutoff) { await done; return; }
  var sr = await reqPromise(tx.objectStore('snapshots').index('articleId').getAll(articleId)); var br = await reqPromise(tx.objectStore('dayBases').index('articleId').getAll(articleId));
  sr.forEach(function (r) { tx.objectStore('snapshots').delete([articleId, r.ts]); }); br.forEach(function (r) { tx.objectStore('dayBases').delete([articleId, r.dateKey]); }); mappings.forEach(function (m) { tx.objectStore('tabDrafts').delete(m.key); }); tx.objectStore('articleMeta').delete(articleId); await done;
}

async function runGc() {
  if (gcPromise) return gcPromise;
  gcPromise = (async function () {
    var db = await openDB(); var tx = db.transaction(['articleMeta', 'tabDrafts'], 'readonly'); var done = txComplete(tx); var metas = await reqPromise(tx.objectStore('articleMeta').getAll()); var mappings = await reqPromise(tx.objectStore('tabDrafts').getAll()); await done;
    var cutoff = Date.now() - DRAFT_RETENTION_MS; var ids = new Set();
    metas.forEach(function (m) { if (isDraftId(m.articleId) && (!m.updatedAt || m.updatedAt < cutoff)) ids.add(m.articleId); }); mappings.forEach(function (m) { if (isDraftId(m.articleId) && (!m.updatedAt || m.updatedAt < cutoff)) ids.add(m.articleId); });
    for (var id of ids) await deleteDraftIfStale(id, cutoff);
    await cleanupExpiredHistorySessions();
  })().finally(function () { gcPromise = null; });
  return gcPromise;
}

async function ensureGcAlarm() {
  var existing = await chrome.alarms.get(GC_ALARM);
  if (!existing) await chrome.alarms.create(GC_ALARM, { delayInMinutes: 5, periodInMinutes: 1440 });
}
chrome.runtime.onInstalled.addListener(function () { ensureGcAlarm().catch(function () {}); });
chrome.runtime.onStartup.addListener(function () { ensureGcAlarm().catch(function () {}); });
chrome.alarms.onAlarm.addListener(function (alarm) { if (alarm && alarm.name === GC_ALARM) runGc().catch(function () {}); });
ensureGcAlarm().catch(function () {});

async function handleMessage(msg, sender) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('NC_') !== 0) throw new Error('invalid message');
  if (msg.type.indexOf('NC_HISTORY_') === 0) {
    if (msg.type === 'NC_HISTORY_LIST') return listSnapshotsForHistory(sender, msg.token);
    if (msg.type === 'NC_HISTORY_GET') return getSnapshotForHistory(sender, msg.token, msg.ts);
    if (msg.type === 'NC_HISTORY_STORAGE') return storageInfoForHistory(sender, msg.token);
    if (msg.type === 'NC_HISTORY_DELETE_ALL') return deleteArticleHistoryForHistory(sender, msg.token);
    if (msg.type === 'NC_HISTORY_CLOSE') return closeHistorySession(sender, msg.token);
    throw new Error('unknown history message type');
  }
  var ctx = senderContext(sender);
  if (msg.type === 'NC_GET_TEMP_ID') return getOrCreateTempArticleId(ctx);
  if (msg.type === 'NC_CLAIM_DRAFT') return claimRecentDraft(ctx, msg.articleId, msg.text);
  if (msg.type === 'NC_LIST_SNAPS') return listSnapshots(ctx, msg.articleId);
  if (msg.type === 'NC_OPEN_HISTORY') return openHistoryPage(ctx, msg.articleId);
  if (msg.type === 'NC_SAVE_SNAP') return saveSnapshot(ctx, msg.articleId, msg.text, msg.mode, msg.sessionId);
  if (msg.type === 'NC_GET_DAYBASE') return getDayBase(ctx, msg.articleId, msg.dateKey);
  if (msg.type === 'NC_ENSURE_DAYBASE') return ensureDayBase(ctx, msg.articleId, msg.dateKey, msg.baseText);
  throw new Error('unknown message type');
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('NC_') !== 0) return false;
  handleMessage(msg, sender).then(function (result) { sendResponse({ ok: true, result: result }); }).catch(function (error) { sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }); });
  return true;
});
