'use strict';
async function getOrCreateTempArticleId(ctx) {
  if (ctx.route.kind !== 'new') throw new Error('temporary article only available on new route');
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('tabDrafts', 'readwrite');
    var store = tx.objectStore('tabDrafts');
    var row = null;
    var req = store.get(ctx.key);
    req.onsuccess = function () {
      var now = Date.now();
      row = req.result || { key: ctx.key, tabId: ctx.tabId, documentId: ctx.documentId, articleId: 'draft:' + crypto.randomUUID(), createdAt: now, updatedAt: now };
      row.updatedAt = now;
      store.put(row);
    };
    req.onerror = function () { try { tx.abort(); } catch (_) {} };
    tx.oncomplete = function () { resolve(row.articleId); };
    tx.onerror = function () { reject(tx.error || new Error('draft mapping transaction failed')); };
    tx.onabort = function () { reject(tx.error || new Error('draft mapping transaction aborted')); };
  });
}

async function findRecentDraftCandidate(ctx, currentText) {
  if (!validText(currentText) || !currentText) return { match: null, ambiguous: false };
  var db = await openDB();
  var tx = db.transaction(['tabDrafts', 'articleMeta', 'snapshots'], 'readonly');
  var done = txComplete(tx);
  var mappings = await reqPromise(tx.objectStore('tabDrafts').index('tabId').getAll(ctx.tabId));
  var cutoff = Date.now() - DRAFT_CLAIM_WINDOW_MS;
  var candidates = (mappings || []).filter(function (m) { return isDraftId(m.articleId) && Number.isFinite(m.updatedAt) && m.updatedAt >= cutoff; });
  var matches = [];
  for (var i = 0; i < candidates.length; i++) {
    var meta = await reqPromise(tx.objectStore('articleMeta').get(candidates[i].articleId));
    if (!meta || meta.lastFingerprint !== Policy.fingerprintText(currentText) || !Number.isFinite(meta.lastTs)) continue;
    var snap = await reqPromise(tx.objectStore('snapshots').get([candidates[i].articleId, meta.lastTs]));
    if (snap && snap.text === currentText) matches.push(candidates[i]);
  }
  await done;
  return matches.length === 1 ? { match: matches[0], ambiguous: false } : { match: null, ambiguous: matches.length > 1 };
}

async function claimRecentDraft(ctx, targetArticleId, currentText) {
  if (ctx.route.kind !== 'article' || targetArticleId !== ctx.route.articleId) throw new Error('draft claim target mismatch');
  var candidateResult = await findRecentDraftCandidate(ctx, currentText);
  if (!candidateResult.match) return { migrated: false, reason: candidateResult.ambiguous ? 'ambiguous exact draft match' : 'no exact draft match' };
  return migrateTempArticle(ctx, candidateResult.match.key, candidateResult.match.articleId, targetArticleId, currentText);
}

async function migrateTempArticle(ctx, mappingKey, sourceArticleId, targetArticleId, expectedText) {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases', 'tabDrafts'], 'readwrite');
    var snaps = tx.objectStore('snapshots'); var metas = tx.objectStore('articleMeta'); var bases = tx.objectStore('dayBases'); var drafts = tx.objectStore('tabDrafts');
    var failure = null; var result = { migrated: false }; var data = {}; var pending = 7;
    function fail(m) { failure = m; try { tx.abort(); } catch (_) {} }
    function collect(name, req) { req.onerror = function () { fail('migration read failed'); }; req.onsuccess = function () { data[name] = req.result; if (--pending === 0) apply(); }; }
    collect('mapping', drafts.get(mappingKey)); collect('sourceSnaps', snaps.index('articleId').getAll(sourceArticleId)); collect('targetSnaps', snaps.index('articleId').getAll(targetArticleId)); collect('sourceMeta', metas.get(sourceArticleId)); collect('targetMeta', metas.get(targetArticleId)); collect('sourceBases', bases.index('articleId').getAll(sourceArticleId)); collect('targetBases', bases.index('articleId').getAll(targetArticleId));
    function apply() {
      if (failure) return;
      var mapping = data.mapping; var sourceRows = (data.sourceSnaps || []).slice().sort(function (a, b) { return a.ts - b.ts; }); var sourceMeta = data.sourceMeta; var latest = sourceMeta && Number.isFinite(sourceMeta.lastTs) ? sourceRows.find(function (r) { return r.ts === sourceMeta.lastTs; }) : null;
      if (!mapping || mapping.articleId !== sourceArticleId || mapping.tabId !== ctx.tabId) { result.reason = 'mapping mismatch'; return; }
      if (Date.now() - mapping.updatedAt > DRAFT_CLAIM_WINDOW_MS) { result.reason = 'draft claim expired'; return; }
      if (!latest || latest.text !== expectedText) { result.reason = 'draft content changed'; return; }
      if (data.targetMeta || (data.targetSnaps || []).length || (data.targetBases || []).length) { result.reason = 'target already has NoteCraft history'; return; }
      var keep = sourceRows.slice(-MAX_SNAPSHOTS).map(function (r) { return { articleId: targetArticleId, ts: r.ts, text: r.text, charCount: r.charCount, kind: r.kind, sourceSessionId: r.sourceSessionId || null }; });
      sourceRows.forEach(function (r) { snaps.delete([sourceArticleId, r.ts]); }); keep.forEach(function (r) { snaps.put(r); });
      if (keep.length) { var l = keep[keep.length - 1]; metas.put({ articleId: targetArticleId, lastFingerprint: Policy.fingerprintText(l.text), lastTs: l.ts, lastKind: l.kind, lastSessionId: l.sourceSessionId || null, updatedAt: Date.now(), isDraft: false }); }
      metas.delete(sourceArticleId);
      (data.sourceBases || []).forEach(function (r) { bases.delete([sourceArticleId, r.dateKey]); });
      (data.sourceBases || []).slice().sort(function (a, b) { return String(b.dateKey).localeCompare(String(a.dateKey)); }).slice(0, MAX_DAY_BASES_PER_ARTICLE).forEach(function (r) { bases.put({ articleId: targetArticleId, dateKey: r.dateKey, baseText: r.baseText, createdAt: r.createdAt }); });
      drafts.delete(mappingKey); result = { migrated: true, snapshots: keep.length };
    }
    tx.oncomplete = function () { resolve(result); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'migration transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'migration transaction aborted')); };
  });
}
