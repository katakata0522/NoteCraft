'use strict';
async function claimRecentDraft(ctx, targetArticleId, currentText) {
  if (ctx.route.kind !== 'article' || targetArticleId !== ctx.route.articleId) {
    throw new Error('draft claim target mismatch');
  }
  if (!validText(currentText)) throw new Error('invalid claim text');

  var candidateResult = await findRecentDraftCandidate(ctx, currentText);
  if (!candidateResult || !candidateResult.match) {
    return { migrated: false, reason: candidateResult && candidateResult.ambiguous ? 'ambiguous exact draft match' : 'no exact draft match' };
  }
  var candidate = candidateResult.match;
  return migrateTempArticle(ctx, candidate.key, candidate.articleId, targetArticleId, currentText);
}

function migrateTempArticle(ctx, mappingKey, sourceArticleId, targetArticleId, expectedText) {
  if (ctx.route.kind !== 'article' || targetArticleId !== ctx.route.articleId) {
    return Promise.reject(new Error('migration target mismatch'));
  }
  if (typeof mappingKey !== 'string' || !mappingKey || !isDraftId(sourceArticleId) || !validArticleId(targetArticleId) || !validText(expectedText)) {
    return Promise.resolve({ migrated: false, reason: 'invalid migration pair' });
  }

  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases', 'tabDrafts'], 'readwrite');
      var snapsStore = tx.objectStore('snapshots');
      var metaStore = tx.objectStore('articleMeta');
      var basesStore = tx.objectStore('dayBases');
      var draftsStore = tx.objectStore('tabDrafts');
      var failure = null;
      var result = { migrated: false };
      var data = {};
      var pending = 7;
      var applied = false;

      function fail(message) {
        if (failure) return;
        failure = message;
        try { tx.abort(); } catch (_) { /* already inactive */ }
      }

      function collect(name, req) {
        req.onerror = function () { fail('migration read failed: ' + name); };
        req.onsuccess = function () {
          data[name] = req.result;
          pending--;
          if (pending === 0) applyMigration();
        };
      }

      collect('mapping', draftsStore.get(mappingKey));
      collect('sourceSnaps', snapsStore.index('articleId').getAll(sourceArticleId));
      collect('targetSnaps', snapsStore.index('articleId').getAll(targetArticleId));
      collect('sourceMeta', metaStore.get(sourceArticleId));
      collect('targetMeta', metaStore.get(targetArticleId));
      collect('sourceBases', basesStore.index('articleId').getAll(sourceArticleId));
      collect('targetBases', basesStore.index('articleId').getAll(targetArticleId));

      function applyMigration() {
        if (applied || failure) return;
        applied = true;

        var mapping = data.mapping;
        var sourceMeta = data.sourceMeta;
        var now = Date.now();
        if (!mapping || mapping.articleId !== sourceArticleId || mapping.tabId !== ctx.tabId) {
          result = { migrated: false, reason: 'mapping mismatch' };
          return;
        }
        if (!Number.isFinite(mapping.updatedAt) || now - mapping.updatedAt > DRAFT_CLAIM_WINDOW_MS) {
          result = { migrated: false, reason: 'draft claim expired' };
          return;
        }
        if (!sourceMeta || sourceMeta.lastText !== expectedText) {
          result = { migrated: false, reason: 'draft content changed' };
          return;
        }

        var sourceSnaps = (data.sourceSnaps || []).slice().sort(function (a, b) { return a.ts - b.ts; });
        var targetSnaps = (data.targetSnaps || []).slice().sort(function (a, b) { return a.ts - b.ts; });
        if (data.targetMeta || targetSnaps.length || (data.targetBases || []).length) {
          result = { migrated: false, reason: 'target already has NoteCraft history' };
          return;
        }
        var usedTs = new Set(targetSnaps.map(function (row) { return row.ts; }));
        var moved = sourceSnaps.map(function (row) {
          var ts = row.ts;
          while (usedTs.has(ts)) ts++;
          usedTs.add(ts);
          return {
            articleId: targetArticleId,
            ts: ts,
            text: row.text,
            charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''),
            kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint'
          };
        });

        var combined = targetSnaps.map(function (row) {
          return {
            articleId: targetArticleId,
            ts: row.ts,
            text: row.text,
            charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''),
            kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint'
          };
        }).concat(moved).sort(function (a, b) { return a.ts - b.ts; });

        var deduped = [];
        combined.forEach(function (row) {
          var prev = deduped[deduped.length - 1];
          if (prev && prev.text === row.text) deduped[deduped.length - 1] = row;
          else deduped.push(row);
        });
        var keep = deduped.slice(-MAX_SNAPSHOTS);

        sourceSnaps.forEach(function (row) { snapsStore.delete([sourceArticleId, row.ts]); });
        targetSnaps.forEach(function (row) { snapsStore.delete([targetArticleId, row.ts]); });
        keep.forEach(function (row) { snapsStore.put(row); });

        var latest = keep[keep.length - 1];
        if (latest) {
          metaStore.put({
            articleId: targetArticleId,
            lastText: latest.text,
            lastTs: latest.ts,
            lastKind: latest.kind === 'rolling' ? 'rolling' : 'checkpoint',
            updatedAt: now,
            isDraft: false
          });
        } else if (data.targetMeta) {
          var preservedMeta = data.targetMeta;
          preservedMeta.articleId = targetArticleId;
          preservedMeta.isDraft = false;
          preservedMeta.updatedAt = now;
          metaStore.put(preservedMeta);
        }
        metaStore.delete(sourceArticleId);

        var baseByDate = new Map();
        (data.targetBases || []).concat(data.sourceBases || []).forEach(function (row) {
          var existing = baseByDate.get(row.dateKey);
          if (!existing || (row.createdAt || 0) < (existing.createdAt || 0)) baseByDate.set(row.dateKey, row);
        });
        (data.targetBases || []).forEach(function (row) { basesStore.delete([targetArticleId, row.dateKey]); });
        (data.sourceBases || []).forEach(function (row) { basesStore.delete([sourceArticleId, row.dateKey]); });
        Array.from(baseByDate.values())
          .sort(function (a, b) { return String(b.dateKey).localeCompare(String(a.dateKey)); })
          .slice(0, MAX_DAY_BASES_PER_ARTICLE)
          .forEach(function (row) {
            basesStore.put({
              articleId: targetArticleId,
              dateKey: row.dateKey,
              baseText: row.baseText,
              createdAt: row.createdAt
            });
          });

        draftsStore.delete(mappingKey);
        result = { migrated: true, from: sourceArticleId, to: targetArticleId, snapshots: keep.length };
      }

      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'migration transaction failed')); };
      tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'migration transaction aborted')); };
    });
  });
}
