'use strict';
var Core = self.NoteCraftCore;
var Policy = self.NoteCraftStoragePolicy;
var DB_NAME = 'notecraft-spike';
var DB_VERSION = 8;
var MAX_SNAPSHOTS = 5;
var MAX_TEXT_CODE_UNITS = 500000;
var MAX_DAY_BASES_PER_ARTICLE = 2;
var MAX_EXTENSION_USAGE_BYTES = 256 * 1024 * 1024;
var STORAGE_ESTIMATE_CACHE_MS = 30000;
var DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var DRAFT_CLAIM_WINDOW_MS = 2 * 60 * 1000;
var ROLLING_COALESCE_MS = 60 * 1000;
var HISTORY_SESSION_TTL_MS = 30 * 60 * 1000;
var GC_ALARM = 'notecraft-daily-gc';
var historyOpenCooldown = new Map();
var dbPromise = null;
var gcPromise = null;
var storageEstimateCache = { checkedAt: 0, usage: 0 };

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

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      var tx = req.transaction;
      var snapshots = db.objectStoreNames.contains('snapshots') ? tx.objectStore('snapshots') : db.createObjectStore('snapshots', { keyPath: ['articleId', 'ts'] });
      if (!snapshots.indexNames.contains('articleId')) snapshots.createIndex('articleId', 'articleId', { unique: false });
      var meta = db.objectStoreNames.contains('articleMeta') ? tx.objectStore('articleMeta') : db.createObjectStore('articleMeta', { keyPath: 'articleId' });
      var bases = db.objectStoreNames.contains('dayBases') ? tx.objectStore('dayBases') : db.createObjectStore('dayBases', { keyPath: ['articleId', 'dateKey'] });
      if (!bases.indexNames.contains('articleId')) bases.createIndex('articleId', 'articleId', { unique: false });
      var drafts = db.objectStoreNames.contains('tabDrafts') ? tx.objectStore('tabDrafts') : db.createObjectStore('tabDrafts', { keyPath: 'key' });
      if (!drafts.indexNames.contains('articleId')) drafts.createIndex('articleId', 'articleId', { unique: false });
      if (!drafts.indexNames.contains('tabId')) drafts.createIndex('tabId', 'tabId', { unique: false });
      var sessions = db.objectStoreNames.contains('historySessions') ? tx.objectStore('historySessions') : db.createObjectStore('historySessions', { keyPath: 'token' });
      if (!sessions.indexNames.contains('expiresAt')) sessions.createIndex('expiresAt', 'expiresAt', { unique: false });
      if (!sessions.indexNames.contains('sourceTabId')) sessions.createIndex('sourceTabId', 'sourceTabId', { unique: false });
      if (!db.objectStoreNames.contains('housekeeping')) db.createObjectStore('housekeeping', { keyPath: 'key' });

      if (req.oldVersion < 8) {
        sessions.clear();
        var cursorReq = meta.openCursor();
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (!cursor) return;
          var row = cursor.value || {};
          if (typeof row.lastText === 'string') row.lastFingerprint = Policy.fingerprintText(row.lastText);
          delete row.lastText;
          if (!row.lastSessionId) row.lastSessionId = null;
          cursor.update(row);
          cursor.continue();
        };
      }
    };
    req.onsuccess = function () {
      var db = req.result;
      db.onversionchange = function () { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = function () { dbPromise = null; reject(req.error || new Error('IndexedDB open failed')); };
    req.onblocked = function () { dbPromise = null; reject(new Error('保存領域の更新がブロックされています。noteタブを再読み込みしてください')); };
  });
  return dbPromise;
}

function validArticleId(v) { return typeof v === 'string' && v.length >= 1 && v.length <= 180 && !/[\u0000-\u001F\u007F]/.test(v); }
function validText(v) { return typeof v === 'string' && v.length <= MAX_TEXT_CODE_UNITS; }
function validDateKey(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function validTimestamp(v) { return Number.isSafeInteger(v) && v > 0; }
function validMode(v) { return v === 'checkpoint' || v === 'rolling'; }
function validSessionId(v) { return typeof v === 'string' && /^[0-9a-f-]{30,60}$/i.test(v); }
function isDraftId(v) { return typeof v === 'string' && v.indexOf('draft:') === 0; }

async function storageAtLimit() {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return false;
  var now = Date.now();
  if (now - storageEstimateCache.checkedAt < STORAGE_ESTIMATE_CACHE_MS) return storageEstimateCache.usage >= MAX_EXTENSION_USAGE_BYTES;
  var estimate = await navigator.storage.estimate();
  var usage = Number.isFinite(estimate && estimate.usage) ? estimate.usage : 0;
  storageEstimateCache = { checkedAt: now, usage: usage };
  return usage >= MAX_EXTENSION_USAGE_BYTES;
}

async function getStorageInfo() {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return { usage: null, quota: null, safetyLimit: MAX_EXTENSION_USAGE_BYTES };
  var estimate = await navigator.storage.estimate();
  var usage = Number.isFinite(estimate && estimate.usage) ? estimate.usage : null;
  var quota = Number.isFinite(estimate && estimate.quota) ? estimate.quota : null;
  if (usage !== null) storageEstimateCache = { checkedAt: Date.now(), usage: usage };
  return { usage: usage, quota: quota, safetyLimit: MAX_EXTENSION_USAGE_BYTES };
}

function senderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) throw new Error('unauthorized sender');
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error('missing sender tab');
  if (sender.frameId !== 0) throw new Error('top frame required');
  if (typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('missing documentId');
  var url;
  try { url = new URL(sender.url || ''); } catch (_) { throw new Error('invalid sender URL'); }
  if (url.protocol !== 'https:' || (url.hostname !== 'note.com' && url.hostname !== 'editor.note.com')) throw new Error('unauthorized sender URL');
  var route = Core.parseNoteRoute(url);
  if (!route) throw new Error('sender is not on a note editor route');
  return { tabId: sender.tab.id, documentId: sender.documentId, key: String(sender.tab.id) + ':' + sender.documentId, route: route };
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
  if (ctx.route.kind === 'article' && articleId === ctx.route.articleId) return;
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
  return rows.map(function (row) { return { ts: row.ts, charCount: Number.isFinite(row.charCount) ? row.charCount : Core.countChars(row.text || ''), kind: row.kind === 'rolling' ? 'rolling' : 'checkpoint' }; });
}
