'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = [
  'src/background/service-worker.js',
  'src/background/service-worker.part1.js',
  'src/background/service-worker.part2.js',
  'src/background/service-worker.part3.js',
  'src/background/service-worker.part4.js',
  'src/background/service-worker.part5.js',
  'src/content/content.part1.js',
  'src/content/content.part2.js',
  'src/content/content.part3.js',
  'src/shared/core.js',
  'src/shared/storage-policy.js',
  'src/ui/history.js'
];
const source = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
assert.ok(!/\bfetch\s*\(/.test(source), 'unexpected fetch');
assert.ok(!/\bXMLHttpRequest\b/.test(source), 'unexpected XHR');
assert.ok(!/\bWebSocket\b/.test(source), 'unexpected WebSocket');
assert.ok(!/\beval\s*\(/.test(source), 'unexpected eval');
assert.ok(!/new\s+Function\s*\(/.test(source), 'unexpected Function constructor');
assert.ok(source.includes("sender.id !== chrome.runtime.id"), 'sender id validation missing');
assert.ok(source.includes("sender.frameId !== 0"), 'top-frame validation missing');
assert.ok(source.includes("url.protocol !== 'https:'"), 'HTTPS sender validation missing');

const content = ['content.part1.js','content.part2.js','content.part3.js']
  .map(f => fs.readFileSync(path.join(root, 'src/content', f), 'utf8')).join('\n');
assert.ok(!content.includes('NC_HISTORY_GET'), 'content script must not request historical plaintext');
assert.ok(!content.includes('navigator.clipboard'), 'content script must not copy historical plaintext');

const sw = ['service-worker.part1.js','service-worker.part2.js','service-worker.part3.js','service-worker.part4.js','service-worker.part5.js']
  .map(f => fs.readFileSync(path.join(root, 'src/background', f), 'utf8')).join('\n');
assert.ok(!/lastText\s*:/.test(sw), 'articleMeta should not persist plaintext lastText');
assert.ok(sw.includes('lastFingerprint'), 'fingerprint metadata expected');
assert.ok(sw.includes('sourceSessionId'), 'multi-tab snapshot provenance expected');
assert.ok(sw.includes('chrome.alarms'), 'periodic GC should use alarms');
console.log('security tests: OK');
