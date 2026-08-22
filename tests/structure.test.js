'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

assert.strictEqual(manifest.manifest_version, 3);
assert.strictEqual(manifest.version, '0.0.7');
assert.deepStrictEqual(manifest.permissions, ['unlimitedStorage']);
assert.strictEqual(manifest.incognito, 'not_allowed');
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));

const contentMatches = manifest.content_scripts[0].matches;
assert.ok(!contentMatches.includes('https://note.com/*'), 'content script scope must not be broad');
assert.ok(contentMatches.includes('https://note.com/notes/*'));
assert.ok(contentMatches.includes('https://editor.note.com/notes/*'));

const required = [
  'src/background/service-worker.js',
  'src/background/service-worker.part1.js',
  'src/background/service-worker.part2.js',
  'src/background/service-worker.part3.js',
  'src/background/service-worker.part4.js',
  'src/background/service-worker.part5.js',
  'src/content/content.js',
  'src/shared/core.js',
  'src/ui/history.html',
  'src/ui/history.css',
  'src/ui/history.js'
];
for (const rel of required) assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);

const swEntry = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
for (let i = 1; i <= 5; i++) assert.ok(swEntry.includes(`service-worker.part${i}.js`));

const allSource = required
  .filter(x => x.endsWith('.js'))
  .map(x => fs.readFileSync(path.join(root, x), 'utf8'))
  .join('\n');
assert.ok(!/\bfetch\s*\(/.test(allSource), 'unexpected fetch usage');
assert.ok(!/\bXMLHttpRequest\b/.test(allSource), 'unexpected XMLHttpRequest usage');
assert.ok(!/\bWebSocket\b/.test(allSource), 'unexpected WebSocket usage');
assert.ok(!/\beval\s*\(/.test(allSource), 'unexpected eval usage');

console.log('structure tests: OK');
