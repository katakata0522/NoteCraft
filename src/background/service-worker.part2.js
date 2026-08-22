'use strict';
async function saveSnapshot(ctx, articleId, text, mode, sessionId) {
  if (!validArticleId(articleId) || !validText(text) || !validMode(mode) || !validSessionId(sessionId)) throw new Error('invalid snapshot input');
  var draft = isDraftId(articleId);
  if (ctx.route.kind === 'article' && (draft || articleId !== ctx.route.articleId)) throw new Error('article mismatch');
  if (ctx.route.kind === 'new' && !draft) throw new Error('draft article required');
  var atLimit = await storageAtLimit();
  var db = await openDB();

  return new Promise(function (resolve, reject) {
    var stores = draft ? ['snapshots', 'articleMeta', 'tabDrafts'] : ['snapshots', 'articleMeta'];
    var tx = db.transaction(stores, 'readwrite');
    var snaps = tx.objectStore('snapshots');
    var metas = tx.objectStore('articleMeta');
    var failure = null;
    var decision = null;

    function fail(message) { failure = message; try { tx.abort(); } catch (_) {} }
    function proceed() {
      var metaReq = metas.get(articleId);
      var allReq = snaps.index('articleId').getAll(articleId);
      var meta = null;
      var rows = null;
      var pending = 2;
      metaReq.onerror = function () { fail('snapshot metadata read failed'); };
      allReq.onerror = function () { fail('snapshot list read failed'); };
      metaReq.onsuccess = function () { meta = metaReq.result || null; if (--pending === 0) apply(); };
      allReq.onsuccess = function () { rows = allReq.result || []; if (--pending === 0) apply(); };

      function apply() {
        if (failure) return;
        rows.sort(function (a, b) { return a.ts - b.ts; });
        var now = Date.now();
        var latest = meta && Number.isFinite(meta.lastTs) ? rows.find(function (r) { return r.ts === meta.lastTs; }) : null;
        var same = !!latest && meta.lastFingerprint === Policy.fingerprintText(text) && latest.text === text;
        if (same) {
          var currentKind = latest.kind === 'rolling' ? 'rolling' : 'checkpoint';
          if (mode === 'checkpoint' && currentKind === 'rolling') {
            latest.kind = 'checkpoint';
            snaps.put(latest);
            metas.put({ articleId: articleId, lastFingerprint: meta.lastFingerprint, lastTs: latest.ts, lastKind: 'checkpoint', lastSessionId: sessionId, updatedAt: now, isDraft: draft });
            decision = { saved: false, replaced: false, promoted: true, ts: latest.ts, kind: 'checkpoint' };
          } else {
            metas.put({ articleId: articleId, lastFingerprint: meta.lastFingerprint, lastTs: latest.ts, lastKind: currentKind, lastSessionId: meta.lastSessionId || null, updatedAt: now, isDraft: draft });
            decision = { saved: false, replaced: false, promoted: false, ts: latest.ts, kind: currentKind };
          }
          return;
        }

        var sameSessionRolling = null;
        for (var ri = rows.length - 1; ri >= 0; ri--) {
          if (Policy.shouldReplaceRolling(rows[ri], mode, sessionId, now, ROLLING_COALESCE_MS)) { sameSessionRolling = rows[ri]; break; }
        }
        var replaceRolling = !!sameSessionRolling;
        var deleteRows = [];
        if (sameSessionRolling) deleteRows.push(sameSessionRolling);
        var remainingCount = rows.length - deleteRows.length;
        if (remainingCount >= MAX_SNAPSHOTS) {
          var oldest = rows.find(function (r) { return !deleteRows.some(function (d) { return d.ts === r.ts; }); });
          if (oldest) deleteRows.push(oldest);
        }
        if (!Policy.canWriteAtSafetyLimit(atLimit, text, deleteRows.map(function (r) { return r.text || ''; }))) {
          fail('ローカル保存の安全上限（256MB）に達しました。古い履歴を削除してください');
          return;
        }

        deleteRows.forEach(function (r) { snaps.delete([articleId, r.ts]); });
        var previousTs = rows.reduce(function (max, r) { return Math.max(max, Number.isFinite(r.ts) ? r.ts : 0); }, 0);
        var ts = Math.max(now, previousTs + 1);
        var row = { articleId: articleId, ts: ts, text: text, charCount: Core.countChars(text), kind: mode, sourceSessionId: sessionId };
        snaps.put(row);
        metas.put({ articleId: articleId, lastFingerprint: Policy.fingerprintText(text), lastTs: ts, lastKind: mode, lastSessionId: sessionId, updatedAt: now, isDraft: draft });
        decision = { saved: true, replaced: !!replaceRolling, promoted: false, ts: ts, kind: mode };
      }
    }

    if (draft) {
      var mappingReq = tx.objectStore('tabDrafts').get(ctx.key);
      mappingReq.onerror = function () { fail('draft mapping read failed'); };
      mappingReq.onsuccess = function () {
        var mapping = mappingReq.result;
        if (!mapping || mapping.articleId !== articleId) return fail('draft mapping mismatch');
        mapping.updatedAt = Date.now();
        tx.objectStore('tabDrafts').put(mapping);
        proceed();
      };
    } else proceed();

    tx.oncomplete = function () { storageEstimateCache.checkedAt = 0; resolve(decision || { saved: false, replaced: false, promoted: false, ts: null, kind: mode }); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'snapshot transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'snapshot transaction aborted')); };
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

async function ensureDayBase(ctx, articleId, dateKey, baseText) {
  if (!validArticleId(articleId) || !validDateKey(dateKey) || !validText(baseText)) throw new Error('invalid day base input');
  var draft = isDraftId(articleId);
  if (ctx.route.kind === 'article' && (draft || articleId !== ctx.route.articleId)) throw new Error('article mismatch');
  if (ctx.route.kind === 'new' && !draft) throw new Error('draft article required');
  var atLimit = await storageAtLimit();
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var stores = draft ? ['dayBases', 'tabDrafts'] : ['dayBases'];
    var tx = db.transaction(stores, 'readwrite');
    var bases = tx.objectStore('dayBases');
    var failure = null;
    var result = null;
    function fail(message) { failure = message; try { tx.abort(); } catch (_) {} }
    function proceed() {
      var existingReq = bases.get([articleId, dateKey]);
      existingReq.onerror = function () { fail('day base read failed'); };
      existingReq.onsuccess = function () {
        if (existingReq.result) { result = existingReq.result; return; }
        var allReq = bases.index('articleId').getAll(articleId);
        allReq.onerror = function () { fail('day base list failed'); };
        allReq.onsuccess = function () {
          var rows = allReq.result || [];
          rows.sort(function (a, b) { return String(a.dateKey).localeCompare(String(b.dateKey)); });
          var deleteRows = rows.length >= MAX_DAY_BASES_PER_ARTICLE ? rows.slice(0, rows.length - MAX_DAY_BASES_PER_ARTICLE + 1) : [];
          if (!Policy.canWriteAtSafetyLimit(atLimit, baseText, deleteRows.map(function (r) { return r.baseText || ''; }))) return fail('TRACE保存の安全上限に達しました');
          deleteRows.forEach(function (r) { bases.delete([articleId, r.dateKey]); });
          result = { articleId: articleId, dateKey: dateKey, baseText: baseText, createdAt: Date.now() };
          bases.put(result);
        };
      };
    }
    if (draft) {
      var mappingReq = tx.objectStore('tabDrafts').get(ctx.key);
      mappingReq.onerror = function () { fail('draft mapping read failed'); };
      mappingReq.onsuccess = function () {
        if (!mappingReq.result || mappingReq.result.articleId !== articleId) return fail('draft mapping mismatch');
        proceed();
      };
    } else proceed();
    tx.oncomplete = function () { storageEstimateCache.checkedAt = 0; resolve(result); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'day base transaction aborted')); };
  });
}
