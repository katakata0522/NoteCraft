'use strict';
// round3: 履歴画面の案内文（差分なし・コピー失敗・削除失敗）を最小のフェイクDOMで検証する
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function el(id) {
  const listeners = {};
  return { id, textContent: '', className: '', disabled: false, children: [], returnValue: '',
    addEventListener(t, f) { listeners[t] = f; }, fire(t) { return listeners[t] && listeners[t]({}); },
    appendChild(c) { this.children.push(c); return c; }, setAttribute() {}, focus() {}, showModal() {} };
}

async function run({ snapshots, texts, clipboardFails = false, deleteFails = false }) {
  const ids = ['status','history','diff','compare','copySelected','refresh','selectionSummary','storageInfo','deleteHistory','deleteDialog','confirmDelete'];
  const nodes = Object.fromEntries(ids.map(id => [id, el(id)]));
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Number, Array, String, Math,
    location: { hash: '#' + 'a'.repeat(36), pathname: '/src/ui/history.html' },
    history: { replaceState() {} },
    document: { getElementById: id => nodes[id], createElement: t => el(t), createTextNode: t => ({ textContent: t }) },
    navigator: { clipboard: { writeText: async () => { if (clipboardFails) throw new Error('Document is not focused.'); } } },
    window: { addEventListener() {} },
    confirm: () => true,
    chrome: { runtime: { lastError: null, sendMessage(msg, cb) {
      let result;
      if (msg.type === 'NC_HISTORY_LIST') result = snapshots;
      else if (msg.type === 'NC_HISTORY_GET') result = { text: texts[msg.ts] };
      else if (msg.type === 'NC_HISTORY_STORAGE') result = { usage: 1, safetyLimit: 2 };
      else if (msg.type === 'NC_HISTORY_DELETE_ALL') { if (deleteFails) return setTimeout(() => cb({ ok: false, error: 'QuotaExceededError' })); result = {}; }
      setTimeout(() => cb({ ok: true, result }));
    } } }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared/core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/history.js'), 'utf8'), ctx);
  const wait = () => new Promise(r => setTimeout(r, 20));
  await wait();
  return { nodes, wait };
}

(async () => {
  {
    const { nodes, wait } = await run({ snapshots: [{ ts: 1, charCount: 3 }, { ts: 2, charCount: 3 }], texts: { 1: '同じ本文', 2: '同じ本文' } });
    nodes.compare.fire('click'); await wait();
    assert.match(nodes.status.textContent, /違いはありません/, '差分がないときはそう伝える');
  }
  {
    const { nodes, wait } = await run({ snapshots: [{ ts: 1 }, { ts: 2 }], texts: { 1: 'abc', 2: 'abd' } });
    nodes.compare.fire('click'); await wait();
    assert.match(nodes.status.textContent, /差分を表示/);
  }
  {
    const { nodes, wait } = await run({ snapshots: [{ ts: 1 }], texts: { 1: 'x' }, clipboardFails: true });
    nodes.copySelected.fire('click'); await wait();
    assert.match(nodes.status.textContent, /コピーできませんでした/, 'コピー失敗を「読み込めない」と誤表示しない');
  }
  {
    const { nodes, wait } = await run({ snapshots: [{ ts: 1 }], texts: { 1: 'x' }, deleteFails: true });
    nodes.deleteDialog.returnValue = 'default'; nodes.deleteDialog.fire('close'); await wait();
    assert.match(nodes.status.textContent, /削除できませんでした/);
  }
  {
    const { nodes } = await run({ snapshots: [], texts: {} });
    const empty = nodes.history.children.find(c => c.className === 'empty');
    assert.ok(empty, '履歴が0件でも一覧が空白にならない');
    assert.match(empty.children[0].textContent, /まだ保存された本文はありません/);
    assert.match(empty.children[1].textContent, /再読込/);
  }
  console.log('history-ui tests passed');
})().catch(e => { console.error(e); process.exit(1); });
