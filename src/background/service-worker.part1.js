'use strict';
var Core = self.NoteCraftCore;
var DB_NAME = 'notecraft-spike';
var DB_VERSION = 7;
var MAX_SNAPSHOTS = 5;
var MAX_TEXT_LENGTH = 500000;
var MAX_DAY_BASES_PER_ARTICLE = 2;
var MAX_EXTENSION_USAGE_BYTES = 256 * 1024 * 1024;
var STORAGE_ESTIMATE_CACHE_MS = 30000;
var DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
var DRAFT_CLAIM_WINDOW_MS = 2 * 60 * 1000;
var ROLLING_COALESCE_MS = 60 * 1000;
var DB_OPEN_TIMEOUT_MS = 8000;
var HISTORY_SESSION_TTL_MS = 30 * 60 * 1000;
var historyOpenCooldown = new Map();
var dbPromise = null;
var gcPromise = null;
var nextGcMemoryCheckAt = 0;
var storageEstimateCache = { checkedAt: 0, usage: 0 };

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    var settled = false;
    var blockedTimer = null;

    function finishReject(error) {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      dbPromise = null;
      reject(error);
    }

    req.onupgradeneeded = function () {
      var db = req.result;
      var upgradeTx = req.transaction;

      var snapshots;
      if (!db.objectStoreNames.contains('snapshots')) {
        snapshots = db.createObjectStore('snapshots', { keyPath: ['articleId', 'ts'] });
      } else {
        snapshots = upgradeTx.objectStore('snapshots');
      }
      if (!snapshots.indexNames.contains('articleId')) {
        snapshots.createIndex('articleId', 'articleId', { unique: false });
      }

      if (!db.objectStoreNames.contains('articleMeta')) {
        db.createObjectStore('articleMeta', { keyPath: 'articleId' });
      }

      var dayBases;
      if (!db.objectStoreNames.contains('dayBases')) {
        dayBases = db.createObjectStore('dayBases', { keyPath: ['articleId', 'dateKey'] });
      } else {
        dayBases = upgradeTx.objectStore('dayBases');
      }
      if (!dayBases.indexNames.contains('articleId')) {
        dayBases.createIndex('articleId', 'articleId', { unique: false });
      }

      var drafts;
      if (!db.objectStoreNames.contains('tabDrafts')) {
        drafts = db.createObjectStore('tabDrafts', { keyPath: 'key' });
      } else {
        drafts = upgradeTx.objectStore('tabDrafts');
      }
      if (!drafts.indexNames.contains('articleId')) {
        drafts.createIndex('articleId', 'articleId', { unique: false });
      }
      if (!drafts.indexNames.contains('tabId')) {
        drafts.createIndex('tabId', 'tabId', { unique: false });
      }

      var historySessions;
      if (!db.objectStoreNames.contains('historySessions')) {
        historySessions = db.createObjectStore('historySessions', { keyPath: 'token' });
      } else {
        historySessions = upgradeTx.objectStore('historySessions');
      }
      if (!historySessions.indexNames.contains('expiresAt')) {
        historySessions.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
      if (!historySessions.indexNames.contains('sourceTabId')) {
        historySessions.createIndex('sourceTabId', 'sourceTabId', { unique: false });
      }
      // Capability sessions are ephemeral by design. Never carry old tokens across
      // a schema/security upgrade where authorization semantics may have changed.
      if (req.oldVersion < 7) historySessions.clear();

      if (!db.objectStoreNames.contains('housekeeping')) {
        db.createObjectStore('housekeeping', { keyPath: 'key' });
      }
    };

    req.onsuccess = function () {
      var db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      db.onversionchange = function () {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = function () {
      finishReject(req.error || new Error('IndexedDB open failed'));
    };
    req.onblocked = function () {
      if (blockedTimer) return;
      blockedTimer = setTimeout(function () {
        finishReject(new Error('保存領域の更新が他のタブでブロックされています。noteタブまたは拡張機能を再読み込みしてください'));
      }, DB_OPEN_TIMEOUT_MS);
    };
  });

  return dbPromise;
}

function reqPromise(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB request failed')); };
  });
}

function txComplete(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
    tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
  });
}

async function storageSafetyLimitReached() {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return false;
  var now = Date.now();
  if (now - storageEstimateCache.checkedAt < STORAGE_ESTIMATE_CACHE_MS) {
    return storageEstimateCache.usage >= MAX_EXTENSION_USAGE_BYTES;
  }
  var estimate = await navigator.storage.estimate();
  var usage = Number.isFinite(estimate && estimate.usage) ? estimate.usage : 0;
  storageEstimateCache = { checkedAt: now, usage: usage };
  return usage >= MAX_EXTENSION_USAGE_BYTES;
}

async function getStorageInfo() {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return { usage: null, quota: null, safetyLimit: MAX_EXTENSION_USAGE_BYTES };
  }
  var estimate = await navigator.storage.estimate();
  var usage = Number.isFinite(estimate && estimate.usage) ? estimate.usage : null;
  var quota = Number.isFinite(estimate && estimate.quota) ? estimate.quota : null;
  if (usage !== null) storageEstimateCache = { checkedAt: Date.now(), usage: usage };
  return { usage: usage, quota: quota, safetyLimit: MAX_EXTENSION_USAGE_BYTES };
}

function isDraftId(articleId) {
  return typeof articleId === 'string' && articleId.indexOf('draft:') === 0;
}

function validArticleId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 180 && !/[\u0000-\u001F\u007F]/.test(value);
}

function validText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function validDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validSaveMode(value) {
  return value === 'checkpoint' || value === 'rolling';
}

function senderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) throw new Error('unauthorized sender');
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error('missing sender tab');
  if (sender.frameId !== 0) throw new Error('top frame required');
  if (typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('missing documentId');

  var url;
  try {
    url = new URL(sender.url || '');
  } catch (_) {
    throw new Error('invalid sender URL');
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'note.com' && url.hostname !== 'editor.note.com')) {
    throw new Error('unauthorized sender URL');
  }

  var route = Core.parseNoteRoute(url);
  if (!route) throw new Error('sender is not on a note editor route');

  return {
    tabId: sender.tab.id,
    documentId: sender.documentId,
    key: String(sender.tab.id) + ':' + sender.documentId,
    route: route
  };
}

async function getDraftMapping(ctx) {
  var db = await openDB();
  var tx = db.transaction('tabDrafts', 'readonly');
  var done = txComplete(tx);
  var row = await reqPromise(tx.objectStore('tabDrafts').get(ctx.key));
  await done;
  return row || null;
}

async function authorizeRead(ctx, articleId) {
  if (!validArticleId(articleId)) throw new Error('invalid articleId');
  if (ctx.route.kind === 'article') {
    if (articleId !== ctx.route.articleId) throw new Error('article mismatch');
    return;
  }
  if (ctx.route.kind === 'new' && isDraftId(articleId)) {
    var mapping = await getDraftMapping(ctx);
    if (mapping && mapping.articleId === articleId) return;
  }
  throw new Error('article access denied');
}

async function getSnapshotsRaw(articleId) {
  var db = await openDB();
  var tx = db.transaction('snapshots', 'readonly');
  var done = txComplete(tx);
  var rows = await reqPromise(tx.objectStore('snapshots').index('articleId').getAll(articleId));
  await done;
  rows.sort(function (a, b) { return a.ts - b.ts; });
  return rows;
}

async function listSnapshots(ctx, articleId) {
  await authorizeRead(ctx, articleId);
  var rows = await getSnapshotsRaw(articleId);
  return rows.map(function (row) {
    return {
      ts: row.ts,
      charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''),
      kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint'
    };
  });
}

async function getSnapshotRaw(articleId, ts) {
  if (!validTimestamp(ts)) throw new Error('invalid snapshot timestamp');
  var db = await openDB();
  var tx = db.transaction('snapshots', 'readonly');
  var done = txComplete(tx);
  var row = await reqPromise(tx.objectStore('snapshots').get([articleId, ts]));
  await done;
  if (!row) throw new Error('snapshot not found');
  return {
    ts: row.ts,
    text: row.text,
    charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''),
    kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint'
  };
}

function validHistoryToken(value) {
  return typeof value === 'string' && /^[0-9a-f-]{30,60}$/i.test(value);
}

function historySenderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) throw new Error('unauthorized history sender');
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error('missing history tab');
  if (sender.frameId !== 0) throw new Error('top frame required');
  if (typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('missing history documentId');
  var url;
  try { url = new URL(sender.url || ''); } catch (_) { throw new Error('invalid history sender URL'); }
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id || url.pathname !== '/src/ui/history.html') {
    throw new Error('unauthorized history page');
  }
  return { tabId: sender.tab.id, documentId: sender.documentId, url: url };
}

function deleteHistorySession(token) {
  if (!validHistoryToken(token)) return Promise.resolve();
  return openDB().then(function (db) {
    var tx = db.transaction('historySessions', 'readwrite');
    var done = txComplete(tx);
    tx.objectStore('historySessions').delete(token);
    return done;
  });
}

async function putHistorySession(articleId, sourceTabId) {
  var db = await openDB();
  var now = Date.now();
  var token = crypto.randomUUID();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('historySessions', 'readwrite');
    var store = tx.objectStore('historySessions');
    var failure = null;
    var rowToPut = null;
    var req = store.index('sourceTabId').getAll(sourceTabId);

    function fail(message) {
      failure = message;
      try { tx.abort(); } catch (_) {}
    }

    req.onerror = function () { fail('history session read failed'); };
    req.onsuccess = function () {
      var active = [];
      (req.result || []).forEach(function (row) {
        if (!row || !Number.isFinite(row.expiresAt) || row.expiresAt <= now) {
          if (row && row.token) store.delete(row.token);
          return;
        }
        active.push(row);
      });
      if (active.some(function (row) { return Number.isFinite(row.createdAt) && now - row.createdAt < 5000; })) {
        fail('history window open throttled');
        return;
      }
      if (active.length >= 3) {
        fail('履歴画面は同じnoteタブから3つまで開けます。不要な履歴画面を閉じてください');
        return;
      }
      rowToPut = {
        token: token,
        articleId: articleId,
        sourceTabId: sourceTabId,
        historyTabId: null,
        historyDocumentId: null,
        createdAt: now,
        expiresAt: now + HISTORY_SESSION_TTL_MS
      };
      store.put(rowToPut);
    };
    tx.oncomplete = function () { resolve(token); };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'history session transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'history session transaction aborted')); };
  });
}

async function openHistoryPage(ctx, articleId) {
  await authorizeRead(ctx, articleId);
  var now = Date.now();
  var lastOpen = historyOpenCooldown.get(ctx.key) || 0;
  if (now - lastOpen < 3000) throw new Error('history window open throttled');
  historyOpenCooldown.set(ctx.key, now);

  var token = await putHistorySession(articleId, ctx.tabId);
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/history.html#' + encodeURIComponent(token)) });
  } catch (error) {
    await deleteHistorySession(token).catch(function () {});
    throw error;
  }
  // The low-trust content script never receives the capability token.
  return { opened: true };
}

async function authorizeHistorySession(sender, token) {
  var historyCtx = historySenderContext(sender);
  if (!validHistoryToken(token)) throw new Error('invalid history token');
  var db = await openDB();
  var tx = db.transaction('historySessions', 'readwrite');
  var done = txComplete(tx);
  var store = tx.objectStore('historySessions');
  var row = await reqPromise(store.get(token));
  if (!row || !validArticleId(row.articleId) || !Number.isFinite(row.expiresAt) || row.expiresAt < Date.now()) {
    if (row) store.delete(token);
    await done;
    throw new Error('history session expired');
  }

  if (row.historyTabId === null || row.historyTabId === undefined) {
    row.historyTabId = historyCtx.tabId;
    row.historyDocumentId = historyCtx.documentId;
  } else if (row.historyTabId !== historyCtx.tabId || row.historyDocumentId !== historyCtx.documentId) {
    try { tx.abort(); } catch (_) {}
    throw new Error('history session is bound to another tab');
  }

  row.expiresAt = Date.now() + HISTORY_SESSION_TTL_MS;
  store.put(row);
  await done;
  return row;
}

async function closeHistorySession(sender, token) {
  var historyCtx = historySenderContext(sender);
  if (!validHistoryToken(token)) return { closed: false };
  var db = await openDB();
  var tx = db.transaction('historySessions', 'readwrite');
  var done = txComplete(tx);
  var store = tx.objectStore('historySessions');
  var row = await reqPromise(store.get(token));
  if (row && (row.historyTabId === null || (row.historyTabId === historyCtx.tabId && row.historyDocumentId === historyCtx.documentId))) {
    store.delete(token);
  }
  await done;
  return { closed: !!row };
}

async function listSnapshotsForHistory(sender, token) {
  var session = await authorizeHistorySession(sender, token);
  var rows = await getSnapshotsRaw(session.articleId);
  return rows.map(function (row) {
    return {
      ts: row.ts,
      charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''),
      kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint'
    };
  });
}

async function getSnapshotForHistory(sender, token, ts) {
  var session = await authorizeHistorySession(sender, token);
  return getSnapshotRaw(session.articleId, ts);
}

async function storageInfoForHistory(sender, token) {
  await authorizeHistorySession(sender, token);
  return getStorageInfo();
}

async function deleteArticleHistoryForHistory(sender, token) {
  var session = await authorizeHistorySession(sender, token);
  var articleId = session.articleId;
  var db = await openDB();
  var result = await new Promise(function (resolve, reject) {
    var tx = db.transaction(['snapshots', 'articleMeta', 'dayBases'], 'readwrite');
    var snapshots = tx.objectStore('snapshots');
    var metaStore = tx.objectStore('articleMeta');
    var bases = tx.objectStore('dayBases');
    var failure = null;
    var deletedSnapshots = 0;
    var pendingCursors = 2;

    function fail(message) {
      failure = message;
      try { tx.abort(); } catch (_) {}
    }
    function cursorDelete(index, range) {
      var req = index.openCursor(range);
      req.onerror = function () { fail('history delete cursor failed'); };
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) { pendingCursors--; return; }
        if (index.name === 'articleId' && cursor.source.objectStore.name === 'snapshots') deletedSnapshots++;
        cursor.delete();
        cursor.continue();
      };
    }

    cursorDelete(snapshots.index('articleId'), IDBKeyRange.only(articleId));
    cursorDelete(bases.index('articleId'), IDBKeyRange.only(articleId));
    metaStore.delete(articleId);

    tx.oncomplete = function () {
      storageEstimateCache.checkedAt = 0;
      resolve({ deleted: true, snapshots: deletedSnapshots });
    };
    tx.onerror = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'history delete transaction failed')); };
    tx.onabort = function () { reject(new Error(failure || (tx.error && tx.error.message) || 'history delete transaction aborted')); };
  });
  try {
    await chrome.tabs.sendMessage(session.sourceTabId, { type: 'NC_INTERNAL_HISTORY_RESET', articleId: articleId });
  } catch (_) {
    // The source note tab may already be closed or navigated away.
  }
  return result;
}

async function cleanupExpiredHistorySessions() {
  var db = await openDB();
  var tx = db.transaction('historySessions', 'readwrite');
  var done = txComplete(tx);
  var store = tx.objectStore('historySessions');
  var req = store.index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()));
  req.onsuccess = function () {
    var cursor = req.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await done;
}
