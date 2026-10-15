'use strict';
// persona pass: 編集中の表示・版表示
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const p1 = fs.readFileSync(path.join(__dirname, '../src/content/content.part1.js'), 'utf8');
const p2 = fs.readFileSync(path.join(__dirname, '../src/content/content.part2.js'), 'utf8');
assert.ok(!p1.includes('Preview v0.9<'), '版を固定文字列で表示しない');
assert.ok(p1.includes("Preview v' + manifestVersion() + '"), 'manifestの版を表示');
const mut = p2.slice(p2.indexOf('function onEditorMutation()'), p2.indexOf('function onEditorMutation()') + 400);
assert.ok(mut.includes('setStatus(EDITING_STATUS'), '保存前の編集中は「保護済み」と表示し続けない');
assert.ok(mut.includes("indexOf('error') === -1"), 'エラー表示は編集で上書きしない');
console.log('content-ux tests passed');
// 履歴画面: 案内は赤い帯だけ。空欄は中立の一文のみ（二重表示しない）
const hist = fs.readFileSync(path.join(__dirname, '../src/ui/history.js'), 'utf8');
assert.ok(!hist.includes("renderEmpty('履歴を表示できません'"), '空欄に「表示できません」を重ねない');
console.log('history empty-state test passed');
const histHtml = fs.readFileSync(path.join(__dirname, '../src/ui/history.html'), 'utf8');
assert.ok(histHtml.includes('<html lang="ja" translate="no">') && histHtml.includes('content="notranslate"'), '翻訳バブルを出さない');
console.log('notranslate test passed');
