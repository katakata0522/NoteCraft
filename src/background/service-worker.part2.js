'use strict';
async function saveSnapshot(ctx, articleId, text, mode) {
  if (!validArticleId(articleId)) throw new Error('invalid articleId');
  if (!validText(text)) throw new Error('本文が大きすぎます（最大500,000文字）');
  if (!validSaveMode(mode)) throw new Error('invalid save mode');
  var storageAtLimit = await storageSafetyLimitReached();

  var draft = isDraftId(articleId);
  if (ctx.route.kind === 'article') {
    if (draft || articleId !== ctx.route.articleId) return Promise.reject(new Error('article mismatch'));
  } else if (ctx.route.kind === 'new') {
    if (!draft) return Promise.reject(new Error('draft article required'));
  } else {
    return Promise.reject(new Error('invalid editor route'));
  }

  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var stores = draft ? ['snapshots', 'articleMeta', 'tabDrafts'] : ['snapshots', 'articleMeta'];
      var tx = db.transaction(stores, 'readwrite');
      var snapshots = tx.objectStore('snapshots');
      var metaStore = tx.objectStore('articleMeta');
      var failure = null;
      var decision = null;

      function fail(message) {
        failure = message;
        try { tx.abort(); } catch (_) { /* already inactive */ }
      }

      function proceed() {
        var metaReq = metaStore.get(articleId);
        metaReq.onerror = function () { fail('snapshot metadata read failed'); };
        metaReq.onsuccess = function () {
          var now = Date.now();
          var meta = metaReq.result || null;

          if (meta && meta.lastText === text && Number.isFinite(meta.lastTs)) {
            var currentKind = meta.lastKind === 'rolling' ? 'rolling' : 'checkpoint';
            if (mode === 'checkpoint' && currentKind === 'rolling' && Number.isFinite(meta.lastTs)) {
              var promoteReq = snapshots.get([articleId, meta.lastTs]);
              promoteReq.onerror = function () { fail('snapshot checkpoint promotion failed'); };
              promoteReq.onsuccess = function () {
                var row = promoteReq.result;
                if (row) {
                  row.kind = 'checkpoint';
                  if (!Number.isFinite(row.charCount)) row.charCount = Core.countChars(row.text || '');
                  snapshots.put(row);
                  metaStore.put({
                    articleId: articleId,
                    lastText: meta.lastText,
                    lastTs: meta.lastTs,
                    lastKind: 'checkpoint',
                    updatedAt: now,
                    isDraft: draft
                  });
                  decision = { saved: false, replaced: false, promoted: true, ts: meta.lastTs, kind: 'checkpoint' };
                } else {
                  var repairTs = Math.max(now, meta.lastTs + 1);
                  snapshots.put({
                    articleId: articleId,
                    ts: repairTs,
                    text: text,
                    charCount: Core.countChars(text),
                    kind: 'checkpoint'
                  });
                  metaStore.put({
                    articleId: articleId,
                    lastText: text,
                    lastTs: repairTs,
                    lastKind: 'checkpoint',
                    updatedAt: now,
                    isDraft: draft
                  });
                  decision = { saved: true, replaced: false, promoted: false, ts: repairTs, kind: 'checkpoint' };
                  var repairTrimReq = snapshots.index('articleId').getAll(articleId);
                  repairTrimReq.onerror = function () { fail('snapshot repair trim read failed'); };
                  repairTrimReq.onsuccess = function () {
                    var repairRows = repairTrimReq.result || [];
                    repairRows.sort(function (a, b) { return a.ts - b.ts; });
                    repairRows.slice(0, Math.max(0, repairRows.length - MAX_SNAPSHOTS)).forEach(function (oldRow) {
                      snapshots.delete([articleId, oldRow.ts]);
                    });
                  };
                }
              };
              return;
            }

            metaStore.put({
              articleId: articleId,
              lastText: meta.lastText,
              lastTs: meta.lastTs || null,
              lastKind: currentKind,
              updatedAt: now,
              isDraft: draft
            });
            decision = { saved: false, replaced: false, promoted: false, ts: meta.lastTs || null, kind: currentKind };
            return;
          }

          if (storageAtLimit) {
            fail('ローカル保存の安全上限（256MB）に達しました。不要な履歴を削除してください');
            return;
          }

          var previousTs = meta && Number.isFinite(meta.lastTs) ? meta.lastTs : null;
          var actualTs = Math.max(now, previousTs ? previousTs + 1 : now);
          var replaceRolling = mode === 'rolling' && meta && meta.lastKind === 'rolling' && previousTs && (now - previousTs) < ROLLING_COALESCE_MS;
          var charCount = Core.countChars(text);

          if (replaceRolling) snapshots.delete([articleId, previousTs]);
          snapshots.put({ articleId: articleId, ts: actualTs, text: text, charCount: charCount, kind: mode });
          metaStore.put({ articleId: articleId, lastText: text, lastTs: actualTs, lastKind: mode, updatedAt: now, isDraft: draft });
          decision = { saved: true, replaced: !!replaceRolling, promoted: false, ts: actualTs, kind: mode };

          var allReq = snapshots.index('articleId').getAll(articleId);
          allReq.onerror = function () { fail('snapshot trim read failed'); };
          allReq.onsuccess = function () {
            var rows = allReq.result || [];
            rows.sort(function (a, b) { return a.ts - b.ts; });
            if (rows.length > MAX_SNAPSHOTS) {
              rows.slice(0, rows.length - MAX_SNAPSHOTS).forEach(function (row) {
                snapshots.delete([articleId, row.ts]);
              });
            }
          };
        };
      }

      if (draft) {
        var mappingReq = tx.objectStore('tabDrafts').get(ctx.key);
        mappingReq.onerror = function () { fail('draft mapping read failed'); };
        mappingReq.onsuccess = function () {
          var mapping = mappingReq.result;
          if (!mapping || mapping.articleId !== articleId) {
            fail('draft mapping mismatch');
            return;
          }
          mapping.updatedAt = Date.now();
          tx.objectStore('tabDrafts').put(mapping);
          proceed();
        };
      } else {
        proceed();
      }

      tx.oncomplete = function () { resolve(decision || { saved: false, replaced: false, promoted: false, ts: null, kind: mode }); };
      tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'snapshot transaction failed')); };
      tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'snapshot transaction aborted')); };
    });
  });
}

async function getDayBase(ctx, articleId, dateKey) {
  if (!validDateKey(dateKey)) throw new Error('invalid dateKey');
  await authorizeRead(ctx, articleId);
  var db = await openDB();
  var tx = db.transaction('dayBases', 'readonly');
  var done = txComplete(tx);
  var row = await reqPromise(tx.objectStore('dayBases').get([articleId, dateKey]));
  await done;
  return row || null;
}

function ensureDayBase(ctx, articleId, dateKey, baseText) {
  if (!validArticleId(articleId)) return Promise.reject(new Error('invalid articleId'));
  if (!validDateKey(dateKey)) return Promise.reject(new Error('invalid dateKey'));
  if (!validText(baseText)) return Promise.reject(new Error('invalid baseText'));

  var draft = isDraftId(articleId);
  if (ctx.route.kind === 'article') {
    if (draft || articleId !== ctx.route.articleId) return Promise.reject(new Error('article mismatch'));
  } else if (ctx.route.kind === 'new') {
    if (!draft) return Promise.reject(new Error('draft article required'));
  } else {
    return Promise.reject(new Error('invalid editor route'));
  }

  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var stores = draft ? ['dayBases', 'tabDrafts'] : ['dayBases'];
      var tx = db.transaction(stores, 'readwrite');
      var baseStore = tx.objectStore('dayBases');
      var failure = null;
      var row = null;

      function fail(message) {
        failure = message;
        try { tx.abort(); } catch (_) { /* already inactive */ }
      }

      function proceed() {
        var req = baseStore.get([articleId, dateKey]);
        req.onerror = function () { fail('day base read failed'); };
        req.onsuccess = function () {
          row = req.result || {
            articleId: articleId,
            dateKey: dateKey,
            baseText: baseText,
            createdAt: Date.now()
          };
          if (!req.result) baseStore.put(row);

          var allReq = baseStore.index('articleId').getAll(articleId);
          allReq.onerror = function () { fail('day base trim read failed'); };
          allReq.onsuccess = function () {
            var rows = allReq.result || [];
            rows.sort(function (a, b) { return String(b.dateKey).localeCompare(String(a.dateKey)); });
            rows.slice(MAX_DAY_BASES_PER_ARTICLE).forEach(function (oldRow) {
              baseStore.delete([articleId, oldRow.dateKey]);
            });
          };
        };
      }

      if (draft) {
        var mappingReq = tx.objectStore('tabDrafts').get(ctx.key);
        mappingReq.onerror = function () { fail('draft mapping read failed'); };
        mappingReq.onsuccess = function () {
          var mapping = mappingReq.result;
          if (!mapping || mapping.articleId !== articleId) {
            fail('draft mapping mismatch');
            return;
          }
          proceed();
        };
      } else {
        proceed();
      }

      tx.oncomplete = function () { resolve(row); };
      tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base transaction failed')); };
      tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base transaction aborted')); };
    });
  });
}

async function getOrCreateTempArticleId(ctx) {
  if (ctx.route.kind !== 'new') throw new Error('temporary article only available on new editor route');

  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('tabDrafts', 'readwrite');
    var store = tx.objectStore('tabDrafts');
    var row = null;
    var req = store.get(ctx.key);

    req.onerror = function () { try { tx.abort(); } catch (_) {} };
    req.onsuccess = function () {
      var now = Date.now();
      row = req.result || {
        key: ctx.key,
        tabId: ctx.tabId,
        documentId: ctx.documentId,
        articleId: 'draft:' + crypto.randomUUID(),
        createdAt: now,
        updatedAt: now
      };
      row.updatedAt = now;
      store.put(row);
    };
    tx.oncomplete = function () { resolve(row.articleId); };
    tx.onerror = function () { reject(tx.error || new Error('draft mapping transaction failed')); };
    tx.onabort = function () { reject(tx.error || new Error('draft mapping transaction aborted')); };
  });
}

function findRecentDraftCandidate(ctx, currentText) {
  if (!validText(currentText) || currentText.length === 0) return Promise.resolve(null);

  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['tabDrafts', 'articleMeta'], 'readonly');
      var drafts = tx.objectStore('tabDrafts');
      var metas = tx.objectStore('articleMeta');
      var cutoff = Date.now() - DRAFT_CLAIM_WINDOW_MS;
      var candidates = [];
      var matchedArticleIds = new Set();
      var failure = null;

      var mappingsReq = drafts.index('tabId').getAll(ctx.tabId);
      mappingsReq.onerror = function () {
        failure = 'draft candidate read failed';
        try { tx.abort(); } catch (_) {}
      };
      mappingsReq.onsuccess = function () {
        candidates = (mappingsReq.result || []).filter(function (mapping) {
          return isDraftId(mapping.articleId) && Number.isFinite(mapping.updatedAt) && mapping.updatedAt >= cutoff;
        }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

        candidates.forEach(function (mapping) {
          var metaReq = metas.get(mapping.articleId);
          metaReq.onerror = function () {
            failure = 'draft candidate metadata read failed';
            try { tx.abort(); } catch (_) {}
          };
          metaReq.onsuccess = function () {
            var meta = metaReq.result;
            if (meta && meta.lastText === currentText) matchedArticleIds.add(mapping.articleId);
          };
        });
      };

      tx.oncomplete = function () {
        var matches = candidates.filter(function (mapping) { return matchedArticleIds.has(mapping.articleId); });
        if (matches.length === 1) resolve({ match: matches[0], ambiguous: false });
        else resolve({ match: null, ambiguous: matches.length > 1 });
      };
      tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'draft candidate transaction failed')); };
      tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'draft candidate transaction aborted')); };
    });
  });
}
