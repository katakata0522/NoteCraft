'use strict';
const assert = require('assert');
const Core = require('../src/shared/core.js');

assert.strictEqual(Core.countChars('abc\n'), 3);
assert.strictEqual(Core.countChars('😀'), 1);
assert.strictEqual(Core.countChars('Ⅳ'), 1, 'NFKC must not expand compatibility characters');
assert.strictEqual(Core.countChars('a\u200Bb'), 2, 'zero-width characters are excluded');

assert.deepStrictEqual(Core.computeDeltaStats('abc', 'abXYZc'), { removed: 0, added: 3 });
assert.deepStrictEqual(Core.computeDeltaStats('abXYZc', 'abc'), { removed: 3, added: 0 });

const diff = Core.computeDisplayDiff('A😀C', 'A😺C', 1200);
assert.ok(diff.some(x => x.type === 'del' && x.text.includes('😀')));
assert.ok(diff.some(x => x.type === 'add' && x.text.includes('😺')));

assert.deepStrictEqual(
  Core.parseNoteRoute('https://editor.note.com/notes/n123abc/edit'),
  { kind: 'article', articleId: 'n123abc', routeKey: 'article:n123abc' }
);
assert.deepStrictEqual(
  Core.parseNoteRoute('https://note.com/notes/new'),
  { kind: 'new', articleId: null, routeKey: 'new' }
);
assert.strictEqual(Core.parseNoteRoute('https://example.com/notes/new'), null);

console.log('core tests: OK');
