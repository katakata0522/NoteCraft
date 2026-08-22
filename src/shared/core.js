(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NoteCraftCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
  var EXACT_DELTA_MAX_MIDDLE = 900;

  function stripZeroWidth(text) {
    return String(text == null ? '' : text).replace(ZERO_WIDTH_RE, '');
  }

  function countCodePoints(text) {
    var s = String(text == null ? '' : text);
    var count = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        var next = s.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) i++;
      }
      count++;
    }
    return count;
  }

  function countChars(text) {
    var cleaned = stripZeroWidth(text).replace(/[\r\n]/g, '');
    return countCodePoints(cleaned);
  }

  function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
  function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

  function commonEdges(a, b) {
    var start = 0;
    while (start < a.length && start < b.length && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    if (start > 0 && start < a.length && start < b.length && isHighSurrogate(a.charCodeAt(start - 1)) && isLowSurrogate(a.charCodeAt(start))) start--;

    var endA = a.length;
    var endB = b.length;
    while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
    if (endA < a.length && endB < b.length && endA > start && endB > start && isLowSurrogate(a.charCodeAt(endA)) && isHighSurrogate(a.charCodeAt(endA - 1))) {
      endA--;
      endB--;
    }
    return { start: start, endA: endA, endB: endB };
  }

  function lcsLength(aTokens, bTokens) {
    var m = bTokens.length;
    var next = new Uint16Array(m + 1);
    var cur = new Uint16Array(m + 1);
    for (var i = aTokens.length - 1; i >= 0; i--) {
      cur.fill(0);
      for (var j = m - 1; j >= 0; j--) {
        cur[j] = aTokens[i] === bTokens[j] ? next[j + 1] + 1 : Math.max(next[j], cur[j + 1]);
      }
      var tmp = next;
      next = cur;
      cur = tmp;
    }
    return next[0];
  }

  function computeDeltaStats(a, b) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    var edges = commonEdges(a, b);
    var midA = Array.from(a.slice(edges.start, edges.endA));
    var midB = Array.from(b.slice(edges.start, edges.endB));

    if (midA.length <= EXACT_DELTA_MAX_MIDDLE && midB.length <= EXACT_DELTA_MAX_MIDDLE) {
      var common = lcsLength(midA, midB);
      return { removed: midA.length - common, added: midB.length - common, approximate: false };
    }
    return { removed: midA.length, added: midB.length, approximate: true };
  }

  function lcsOps(aTokens, bTokens) {
    var n = aTokens.length;
    var m = bTokens.length;
    var width = m + 1;
    var dp = new Uint16Array((n + 1) * (m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * width + j] = aTokens[i] === bTokens[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    var ops = [];
    var i2 = 0;
    var j2 = 0;
    while (i2 < n && j2 < m) {
      if (aTokens[i2] === bTokens[j2]) { ops.push({ type: 'same', ch: aTokens[i2++] }); j2++; }
      else if (dp[(i2 + 1) * width + j2] >= dp[i2 * width + j2 + 1]) ops.push({ type: 'del', ch: aTokens[i2++] });
      else ops.push({ type: 'add', ch: bTokens[j2++] });
    }
    while (i2 < n) ops.push({ type: 'del', ch: aTokens[i2++] });
    while (j2 < m) ops.push({ type: 'add', ch: bTokens[j2++] });
    return ops;
  }

  function pushSegment(segments, type, text) {
    if (!text) return;
    var prev = segments[segments.length - 1];
    if (prev && prev.type === type) prev.text += text;
    else segments.push({ type: type, text: text });
  }

  function computeDisplayDiff(a, b, maxMiddle) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    maxMiddle = Number(maxMiddle || 1200);
    var segments = [];
    var edges = commonEdges(a, b);
    pushSegment(segments, 'same', a.slice(0, edges.start));
    var midA = Array.from(a.slice(edges.start, edges.endA));
    var midB = Array.from(b.slice(edges.start, edges.endB));
    if (midA.length <= maxMiddle && midB.length <= maxMiddle) {
      var ops = lcsOps(midA, midB);
      for (var k = 0; k < ops.length; k++) pushSegment(segments, ops[k].type, ops[k].ch);
    } else {
      if (midA.length) pushSegment(segments, 'del', midA.slice(0, 400).join('') + (midA.length > 400 ? '\n…（削除差分を省略）' : ''));
      if (midB.length) pushSegment(segments, 'add', midB.slice(0, 400).join('') + (midB.length > 400 ? '\n…（追加差分を省略）' : ''));
    }
    pushSegment(segments, 'same', a.slice(edges.endA));
    return segments;
  }

  function parseNoteRoute(input) {
    var url;
    try { url = input instanceof URL ? input : new URL(String(input)); } catch (_) { return null; }
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'note.com' && url.hostname !== 'editor.note.com') return null;
    var path = url.pathname.replace(/\/+$/, '') || '/';
    var edit = path.match(/^\/notes\/([^/]+)\/edit$/i);
    if (edit && edit[1] !== 'new') return { kind: 'article', articleId: edit[1], routeKey: 'article:' + edit[1] };
    if (path === '/notes/new' || path === '/new') return { kind: 'new', articleId: null, routeKey: 'new' };
    return null;
  }

  function fmtTime(ts) {
    var d = new Date(ts); var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDateTime(ts) {
    var d = new Date(ts); var p = function (n) { return String(n).padStart(2, '0'); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function localDateKey(ts) {
    var d = ts ? new Date(ts) : new Date(); var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  return {
    stripZeroWidth: stripZeroWidth,
    countCodePoints: countCodePoints,
    countChars: countChars,
    computeDeltaStats: computeDeltaStats,
    computeDisplayDiff: computeDisplayDiff,
    parseNoteRoute: parseNoteRoute,
    fmtTime: fmtTime,
    fmtDateTime: fmtDateTime,
    localDateKey: localDateKey
  };
});
