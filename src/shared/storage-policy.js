(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NoteCraftStoragePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fingerprintText(text) {
    text = String(text == null ? '' : text);
    var hash = 2166136261 >>> 0;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return text.length + ':' + hash.toString(16).padStart(8, '0');
  }

  function byteSize(text) {
    text = String(text == null ? '' : text);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    return text.length * 2;
  }

  function shouldReplaceRolling(row, mode, sessionId, now, windowMs) {
    return !!row && mode === 'rolling' && row.kind === 'rolling' &&
      row.sourceSessionId === sessionId && Number.isFinite(row.ts) &&
      now - row.ts >= 0 && now - row.ts < windowMs;
  }

  function canWriteAtSafetyLimit(atLimit, newText, freedTexts) {
    if (!atLimit) return true;
    var incoming = byteSize(newText);
    var freed = (freedTexts || []).reduce(function (sum, text) { return sum + byteSize(text); }, 0);
    return incoming <= freed;
  }

  return {
    fingerprintText: fingerprintText,
    byteSize: byteSize,
    shouldReplaceRolling: shouldReplaceRolling,
    canWriteAtSafetyLimit: canWriteAtSafetyLimit
  };
});
