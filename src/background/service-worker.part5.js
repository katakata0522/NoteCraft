'use strict';
async function handleMessage(msg, sender) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('NC_') !== 0) {
    throw new Error('invalid message');
  }

  if (msg.type.indexOf('NC_HISTORY_') === 0) {
    switch (msg.type) {
      case 'NC_HISTORY_LIST':
        return listSnapshotsForHistory(sender, msg.token);
      case 'NC_HISTORY_GET':
        return getSnapshotForHistory(sender, msg.token, msg.ts);
      case 'NC_HISTORY_STORAGE':
        return storageInfoForHistory(sender, msg.token);
      case 'NC_HISTORY_DELETE_ALL':
        return deleteArticleHistoryForHistory(sender, msg.token);
      case 'NC_HISTORY_CLOSE':
        return closeHistorySession(sender, msg.token);
      default:
        throw new Error('unknown history message type');
    }
  }

  var ctx = senderContext(sender);
  scheduleDraftGc().catch(function () {});

  switch (msg.type) {
    case 'NC_GET_TEMP_ID':
      return getOrCreateTempArticleId(ctx);
    case 'NC_CLAIM_DRAFT':
      return claimRecentDraft(ctx, msg.articleId, msg.text);
    case 'NC_LIST_SNAPS':
      return listSnapshots(ctx, msg.articleId);
    case 'NC_OPEN_HISTORY':
      return openHistoryPage(ctx, msg.articleId);
    case 'NC_SAVE_SNAP':
      return saveSnapshot(ctx, msg.articleId, msg.text, msg.mode);
    case 'NC_GET_DAYBASE':
      return getDayBase(ctx, msg.articleId, msg.dateKey);
    case 'NC_ENSURE_DAYBASE':
      return ensureDayBase(ctx, msg.articleId, msg.dateKey, msg.baseText);
    default:
      throw new Error('unknown message type');
  }
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

scheduleDraftGc().catch(function () {});
