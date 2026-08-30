'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

assert.strictEqual(manifest.manifest_version, 3);
assert.strictEqual(manifest.version, '0.0.9');
assert.strictEqual(manifest.name, 'KakuSave - note本文バックアップ');
assert.deepStrictEqual(manifest.permissions, ['unlimitedStorage', 'alarms']);
assert.deepStrictEqual(manifest.externally_connectable, { ids: [] });
assert.strictEqual(manifest.incognito, 'not_allowed');
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
assert.ok(manifest.content_security_policy.extension_pages.includes("img-src 'self'"));

for (const size of [16, 32, 48, 128]) {
  const rel = manifest.icons[String(size)];
  assert.ok(rel, `missing manifest icon ${size}`);
  assert.ok(fs.existsSync(path.join(root, rel)), `missing icon file ${rel}`);
}

const matches = manifest.content_scripts[0].matches;
assert.ok(!matches.includes('https://note.com/*'), 'content script scope must not be broad');
assert.ok(matches.includes('https://note.com/notes/*'));
assert.ok(matches.includes('https://editor.note.com/notes/*'));
const expectedContent = [
  'src/shared/core.js',
  'src/shared/storage-policy.js',
  'src/content/content.part1.js',
  'src/content/content.part2.js',
  'src/content/content.part3.js'
];
assert.deepStrictEqual(manifest.content_scripts[0].js, expectedContent);

const required = [
  'src/background/service-worker.js',
  'src/background/service-worker.part1.js',
  'src/background/service-worker.part2.js',
  'src/background/service-worker.part3.js',
  'src/background/service-worker.part4.js',
  'src/background/service-worker.part5.js',
  ...expectedContent,
  'src/ui/history.html',
  'src/ui/history.css',
  'src/ui/history.js'
];
for (const rel of required) assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);

const swEntry = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
assert.ok(swEntry.includes("../shared/storage-policy.js"));
for (let i = 1; i <= 5; i++) assert.ok(swEntry.includes(`service-worker.part${i}.js`));
assert.ok(!manifest.content_scripts[0].js.includes('src/content/content.js'), 'legacy content.js must not be loaded');

console.log('structure tests: OK');
