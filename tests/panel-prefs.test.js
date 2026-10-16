'use strict';
// round4: パネルの最小化・左右を拡張機能内IndexedDBに保存し、最小化中も保存状態を見せる
const assert=require('assert');const fs=require('fs');const path=require('path');const vm=require('vm');const {indexedDB,IDBKeyRange}=require('fake-indexeddb');const {webcrypto}=require('crypto');
const root=path.resolve(__dirname,'..');
const sandbox={console,setTimeout,clearTimeout,TextEncoder,URL,indexedDB,IDBKeyRange,crypto:webcrypto,navigator:{storage:{estimate:async()=>({usage:0,quota:1<<30})}}};
sandbox.self=sandbox;sandbox.globalThis=sandbox;
sandbox.chrome={runtime:{id:'x',getURL:p=>p,onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},tabs:{create:async()=>({})},alarms:{get:async()=>null,create:async()=>{},onAlarm:{addListener(){}}}};
sandbox.importScripts=(...rels)=>{for(const rel of rels){const abs=path.resolve(root,'src/background',rel);vm.runInContext(fs.readFileSync(abs,'utf8'),sandbox,{filename:abs});}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8'),sandbox);
(async()=>{
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await sandbox.getPanelPrefs())),{minimized:false,side:'right'},'初期値は右・展開');
  await sandbox.setPanelPrefs({minimized:true,side:'left',text:'本文'});
  const got=JSON.parse(JSON.stringify(await sandbox.getPanelPrefs()));
  assert.deepStrictEqual(got,{minimized:true,side:'left'},'保存した状態を返す');
  await sandbox.setPanelPrefs({minimized:'yes',side:'top'});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await sandbox.getPanelPrefs())),{minimized:false,side:'right'},'不正値は既定値にそろえる');
  const db=await sandbox.openDB();const tx=db.transaction('housekeeping','readonly');
  const row=await sandbox.reqPromise(tx.objectStore('housekeeping').get('panelPrefs'));
  assert.ok(!('text' in row),'本文などは保存しない');
  const p1=fs.readFileSync(path.join(root,'src/content/content.part1.js'),'utf8');
  assert.ok(p1.includes('updateMiniStatus(text, kind)'),'状態表示を最小化中の見出しにも反映');
  assert.ok(p1.includes('.panel.minimized .mini-status{display:inline-flex}'),'最小化中だけ短い状態を表示');
  assert.ok(p1.includes('id="toggle" type="button" aria-controls="body"'),'round5: 最小化ボタンがどこを開閉するか読み上げに伝える');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.deepStrictEqual(manifest.permissions,['unlimitedStorage','alarms'],'新しい権限を足さない');
  console.log('panel-prefs tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
