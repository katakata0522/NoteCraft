'use strict';
async function deleteDraftArticleIfStale(articleId, cutoff) {
  if (!isDraftId(articleId)) return false;
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases', 'tabDrafts'], 'readwrite');
    var snapshots = tx.objectStore('snapshots');
    var metaStore = tx.objectStore('articleMeta');
    var bases = tx.objectStore('dayBases');
    var drafts = tx.objectStore('tabDrafts');
    var failure = null;
    var deleted = false;
    var meta = null;
    var mappings = [];
    var pending = 2;

    function fail(message) {
      failure = message;
      try { tx.abort(); } catch (_) {}
    }

    function maybeDelete() {
      if (--pending !== 0 || failure) return;
      var lastActive = meta && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0;
      mappings.forEach(function (mapping) {
        if (Number.isFinite(mapping.updatedAt)) lastActive = Math.max(lastActive, mapping.updatedAt);
      });
      if (lastActive >= cutoff) return;

      function deleteByIndex(index, range) {
        var req = index.openCursor(range);
        req.onerror = function () { fail('draft GC cursor failed'); };
        req.onsuccess = function () {
          var cursor = req.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }

      deleteByIndex(snapshots.index('articleId'), IDBKeyRange.only(articleId));
      deleteByIndex(bases.index('articleId'), IDBKeyRange.only(articleId));
      deleteByIndex(drafts.index('articleId'), IDBKeyRange.only(articleId));
      metaStore.delete(articleId);
      deleted = true;
    }

    var metaReq = metaStore.get(articleId);
    metaReq.onerror = function () { fail('draft GC metadata read failed'); };
    metaReq.onsuccess = function () { meta = metaReq.result || null; maybeDelete(); };

    var mappingsReq = drafts.index('articleId').getAll(articleId);
    mappingsReq.onerror = function () { fail('draft GC mapping read failed'); };
    mappingsReq.onsuccess = function () { mappings = mappingsReq.result || []; maybeDelete(); };

    tx.oncomplete = function () { resolve(deleted); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'draft GC transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'draft GC transaction aborted')); };
  });
}

async function getPayloadFreshnessFromIndex(storeName, indexName) {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(storeName, 'readonly');
    var store = tx.objectStore(storeName);
    var freshness = new Map();
    var failure = null;
    var req = store.index(indexName).openKeyCursor();
    req.onerror = function () {
      failure = 'orphan draft index scan failed';
      try { tx.abort(); } catch (_) {}
    };
    req.onsuccess = function () {
      var cursor = req.result;
      if (!cursor) return;
      var articleId = cursor.key;
      var primary = cursor.primaryKey;
      var seenAt = 0;
      if (storeName === 'snapshots' && Array.isArray(primary) && Number.isFinite(primary[1])) {
        seenAt = primary[1];
      } else if (storeName === 'dayBases' && Array.isArray(primary) && validDateKey(primary[1])) {
        var parsed = Date.parse(primary[1] + 'T00:00:00Z');
        seenAt = Number.isFinite(parsed) ? parsed : 0;
      }
      freshness.set(articleId, Math.max(freshness.get(articleId) || 0, seenAt));
      cursor.continue();
    };
    tx.oncomplete = function () { resolve(freshness); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'orphan draft index transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'orphan draft index transaction aborted')); };
  });
}

async function cleanupExcessDayBases() {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('dayBases', 'readwrite');
    var store = tx.objectStore('dayBases');
    var groups = new Map();
    var failure = null;
    var req = store.index('articleId').openKeyCursor();

    function fail(message) {
      failure = message;
      try { tx.abort(); } catch (_) {}
    }

    req.onerror = function () { fail('day base cleanup read failed'); };
    req.onsuccess = function () {
      var cursor = req.result;
      if (!cursor) {
        groups.forEach(function (dateKeys, articleId) {
          dateKeys.sort(function (a, b) { return String(b).localeCompare(String(a)); });
          dateKeys.slice(MAX_DAY_BASES_PER_ARTICLE).forEach(function (dateKey) {
            store.delete([articleId, dateKey]);
          });
        });
        return;
      }
      var articleId = cursor.key;
      var primary = cursor.primaryKey;
      var dateKey = Array.isArray(primary) ? primary[1] : null;
      if (validArticleId(articleId) && validDateKey(dateKey)) {
        if (!groups.has(articleId)) groups.set(articleId, []);
        groups.get(articleId).push(dateKey);
      }
      cursor.continue();
    };
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base cleanup failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base cleanup aborted')); };
  });
}

async function runDraftGcIfDue() {
  var db = await openDB();
  var now = Date.now();
  var checkTx = db.transaction('housekeeping', 'readonly');
  var checkDone = txComplete(checkTx);
  var previous = await reqPromise(checkTx.objectStore('housekeeping').get('draftGcAt'));
  await checkDone;
  if (previous && now - previous.value < GC_INTERVAL_MS) return;

  var readTx = db.transaction(['articleMeta', 'tabDrafts'], 'readonly');
  var readDone = txComplete(readTx);
  var metasReq = readTx.objectStore('articleMeta').getAll();
  var mappingsReq = readTx.objectStore('tabDrafts').getAll();
  var metas = await reqPromise(metasReq);
  var mappings = await reqPromise(mappingsReq);
  await readDone;
  var payloadFreshnessMaps = await Promise.all([
    getPayloadFreshnessFromIndex('snapshots', 'articleId'),
    getPayloadFreshnessFromIndex('dayBases', 'articleId')
  ]);

  var cutoff = now - DRAFT_RETENTION_MS;
  var metaByArticle = new Map();
  (metas || []).forEach(function (meta) { metaByArticle.set(meta.articleId, meta); });
  var mappingArticleIds = new Set((mappings || []).map(function (mapping) { return mapping.articleId; }));
  var stale = new Set();

  (metas || []).forEach(function (meta) {
    if (isDraftId(meta.articleId) && (!Number.isFinite(meta.updatedAt) || meta.updatedAt < cutoff)) {
      stale.add(meta.articleId);
    }
  });
  (mappings || []).forEach(function (mapping) {
    if (!isDraftId(mapping.articleId)) return;
    var meta = metaByArticle.get(mapping.articleId);
    var lastActive = meta && Number.isFinite(meta.updatedAt) ? meta.updatedAt : mapping.updatedAt;
    if (!Number.isFinite(lastActive) || lastActive < cutoff) stale.add(mapping.articleId);
  });

  payloadFreshnessMaps.forEach(function (freshness) {
    freshness.forEach(function (lastSeen, articleId) {
      if (isDraftId(articleId) && !metaByArticle.has(articleId) && !mappingArticleIds.has(articleId) && lastSeen < cutoff) {
        stale.add(articleId);
      }
    });
  });

  for (var articleId of stale) {
    await deleteDraftArticleIfStale(articleId, cutoff);
  }
  await cleanupExcessDayBases();
  await cleanupExpiredHistorySessions();

  var writeTx = db.transaction('housekeeping', 'readwrite');
  var writeDone = txComplete(writeTx);
  writeTx.objectStore('housekeeping').put({ key: 'draftGcAt', value: now });
  await writeDone;
}

function scheduleDraftGc() {
  var now = Date.now();
  if (gcPromise) return gcPromise;
  if (now < nextGcMemoryCheckAt) return Promise.resolve();
  nextGcMemoryCheckAt = now + 60 * 60 * 1000;
  gcPromise = runDraftGcIfDue().finally(function () { gcPromise = null; });
  return gcPromise;
}
