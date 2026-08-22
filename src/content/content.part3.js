'use strict';
function routeTick() {
  if (location.href !== lastHref) { lastHref = location.href; routeStableSince = performance.now(); detach('ページ遷移を確認中…'); return; }
  var route = currentRoute();
  if (!route) { if (attached) detach('note編集画面でのみ動作します'); if (host) host.style.display = 'none'; return; }
  buildUI(); host.style.display = '';
  if (attached) {
    if (!sameRouteAndNode(attached)) { detach('エディタの更新を確認中…'); routeStableSince = performance.now(); return; }
    if (performance.now() - lastEditorIdentityCheckAt >= EDITOR_IDENTITY_CHECK_MS) {
      lastEditorIdentityCheckAt = performance.now();
      if (findEditor() !== attached.editor) { detach('エディタの更新を確認中…'); routeStableSince = performance.now(); return; }
    }
    return;
  }
  if (resolvingAttach || performance.now() - routeStableSince < ROUTE_SETTLE_MS) return;
  var editor = findEditor();
  if (!editor) { candidateEditor = null; candidateSince = 0; setStatus('本文エディタを待っています…'); return; }
  if (editor !== candidateEditor) { candidateEditor = editor; candidateSince = performance.now(); return; }
  if (performance.now() - candidateSince < EDITOR_CONFIRM_MS) return;
  attachEditor(route, editor);
}

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!sender || sender.id !== chrome.runtime.id || !message || message.type !== 'NC_INTERNAL_HISTORY_RESET') return false;
  var ctx = attached;
  if (!ctx || message.articleId !== ctx.articleId || !isSameContext(ctx)) return false;
  reseedAfterReset(ctx);
  return false;
});

setInterval(routeTick, ROUTE_POLL_MS);
setInterval(function () { takeSnapshot('60秒', attached, 'checkpoint', false); }, SNAPSHOT_INTERVAL_MS);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') takeSnapshot('非表示前', attached, 'rolling', false); });
window.addEventListener('pagehide', function () { takeSnapshot('ページ離脱前', attached, 'rolling', false); });
routeTick();
