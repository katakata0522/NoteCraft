'use strict';

async function cleanupExpiredHistorySessions() {
  var db = await openDB();
  var tx = db.transaction('historySessions', 'readwrite');
  var done = txComplete(tx);
  var req = tx.objectStore('historySessions').index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()));
  req.onerror = function () { try { tx.abort(); } catch (_) {} };
  req.onsuccess = function () {
    var cursor = req.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await done;
}

function dayBaseFreshness(row) {
  if (!row) return 0;
  if (Number.isFinite(row.createdAt)) return row.createdAt;
  if (validDateKey(row.dateKey)) {
    var parsed = Date.parse(row.dateKey + 'T00:00:00Z');
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function deleteDraftIfStale(articleId, cutoff) {
  if (!isDraftId(articleId)) return false;
  var db = await openDB();
  var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases', 'tabDrafts'], 'readwrite');
  var done = txComplete(tx);
  var snapshots = tx.objectStore('snapshots');
  var metas = tx.objectStore('articleMeta');
  var bases = tx.objectStore('dayBases');
  var drafts = tx.objectStore('tabDrafts');

  var values = await Promise.all([
    reqPromise(metas.get(articleId)),
    reqPromise(drafts.index('articleId').getAll(articleId)),
    reqPromise(snapshots.index('articleId').getAll(articleId)),
    reqPromise(bases.index('articleId').getAll(articleId))
  ]);
  var meta = values[0] || null;
  var mappings = values[1] || [];
  var snapRows = values[2] || [];
  var baseRows = values[3] || [];
  var lastActive = meta && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0;
  mappings.forEach(function (row) { if (Number.isFinite(row.updatedAt)) lastActive = Math.max(lastActive, row.updatedAt); });
  snapRows.forEach(function (row) { if (Number.isFinite(row.ts)) lastActive = Math.max(lastActive, row.ts); });
  baseRows.forEach(function (row) { lastActive = Math.max(lastActive, dayBaseFreshness(row)); });

  if (lastActive >= cutoff) {
    await done;
    return false;
  }
  snapRows.forEach(function (row) { snapshots.delete([articleId, row.ts]); });
  baseRows.forEach(function (row) { bases.delete([articleId, row.dateKey]); });
  mappings.forEach(function (row) { drafts.delete(row.key); });
  metas.delete(articleId);
  await done;
  storageEstimateCache.checkedAt = 0;
  return true;
}

async function collectDraftPayloadFreshness() {
  var db = await openDB();
  var tx = db.transaction(['snapshots', 'dayBases'], 'readonly');
  var done = txComplete(tx);
  var values = await Promise.all([
    reqPromise(tx.objectStore('snapshots').getAllKeys()),
    reqPromise(tx.objectStore('dayBases').getAllKeys())
  ]);
  await done;
  var freshness = new Map();
  (values[0] || []).forEach(function (key) {
    if (!Array.isArray(key) || !isDraftId(key[0])) return;
    var ts = Number.isFinite(key[1]) ? key[1] : 0;
    freshness.set(key[0], Math.max(freshness.get(key[0]) || 0, ts));
  });
  (values[1] || []).forEach(function (key) {
    if (!Array.isArray(key) || !isDraftId(key[0]) || !validDateKey(key[1])) return;
    var parsed = Date.parse(key[1] + 'T00:00:00Z');
    var ts = Number.isFinite(parsed) ? parsed : 0;
    freshness.set(key[0], Math.max(freshness.get(key[0]) || 0, ts));
  });
  return freshness;
}

async function cleanupExcessDayBases() {
  var db = await openDB();
  var tx = db.transaction('dayBases', 'readwrite');
  var done = txComplete(tx);
  var store = tx.objectStore('dayBases');
  var keys = await reqPromise(store.getAllKeys());
  var groups = new Map();
  (keys || []).forEach(function (key) {
    if (!Array.isArray(key) || !validArticleId(key[0]) || !validDateKey(key[1])) return;
    if (!groups.has(key[0])) groups.set(key[0], []);
    groups.get(key[0]).push(key[1]);
  });
  groups.forEach(function (dateKeys, articleId) {
    dateKeys.sort(function (a, b) { return String(b).localeCompare(String(a)); });
    dateKeys.slice(MAX_DAY_BASES_PER_ARTICLE).forEach(function (dateKey) { store.delete([articleId, dateKey]); });
  });
  await done;
}

async function runGc() {
  if (gcPromise) return gcPromise;
  gcPromise = (async function () {
    var db = await openDB();
    var tx = db.transaction(['articleMeta', 'tabDrafts'], 'readonly');
    var done = txComplete(tx);
    var values = await Promise.all([
      reqPromise(tx.objectStore('articleMeta').getAll()),
      reqPromise(tx.objectStore('tabDrafts').getAll())
    ]);
    await done;
    var metas = values[0] || [];
    var mappings = values[1] || [];
    var cutoff = Date.now() - DRAFT_RETENTION_MS;
    var ids = new Set();
    var known = new Set();
    metas.forEach(function (row) {
      if (!isDraftId(row.articleId)) return;
      known.add(row.articleId);
      if (!Number.isFinite(row.updatedAt) || row.updatedAt < cutoff) ids.add(row.articleId);
    });
    mappings.forEach(function (row) {
      if (!isDraftId(row.articleId)) return;
      known.add(row.articleId);
      if (!Number.isFinite(row.updatedAt) || row.updatedAt < cutoff) ids.add(row.articleId);
    });
    var payloadFreshness = await collectDraftPayloadFreshness();
    payloadFreshness.forEach(function (lastSeen, articleId) {
      if (!known.has(articleId) && lastSeen < cutoff) ids.add(articleId);
    });
    for (var articleId of ids) await deleteDraftIfStale(articleId, cutoff);
    await cleanupExcessDayBases();
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
  handleMessage(msg, sender).then(function (result) {
    sendResponse({ ok: true, result: result });
  }).catch(function (error) {
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
  });
  return true;
});
