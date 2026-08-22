'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const scripts = [
  'src/shared/core.js',
  'src/shared/storage-policy.js',
  'src/background/service-worker.js',
  'src/background/service-worker.part1.js',
  'src/background/service-worker.part2.js',
  'src/background/service-worker.part3.js',
  'src/background/service-worker.part4.js',
  'src/background/service-worker.part5.js',
  'src/content/content.part1.js',
  'src/content/content.part2.js',
  'src/content/content.part3.js',
  'src/ui/history.js'
];
for (const rel of scripts) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  new vm.Script(source, { filename: rel });
}
console.log('browser-script syntax tests: OK');
