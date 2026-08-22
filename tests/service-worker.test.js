'use strict';
const assert=require('assert');const fs=require('fs');const path=require('path');const vm=require('vm');const {indexedDB,IDBKeyRange}=require('fake-indexeddb');const {webcrypto}=require('crypto');
const root=path.resolve(__dirname,'..');
const sandbox={console,setTimeout,clearTimeout,TextEncoder,URL,indexedDB,IDBKeyRange,crypto:webcrypto,navigator:{storage:{estimate:async()=>({usage:0,quota:1024*1024*1024})}},self:null,globalThis:null};
sandbox.self=sandbox;sandbox.globalThis=sandbox;
const listeners={};
sandbox.chrome={runtime:{id:'abcdefghijklmnopabcdefghijklmnop',getURL:p=>'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'+p,onInstalled:{addListener:fn=>listeners.installed=fn},onStartup:{addListener:fn=>listeners.startup=fn},onMessage:{addListener:fn=>listeners.message=fn}},tabs:{create:async()=>({id:99}),sendMessage:async()=>{}},alarms:{get:async()=>null,create:async()=>{},onAlarm:{addListener:fn=>listeners.alarm=fn}}};
sandbox.importScripts=(...rels)=>{for(const rel of rels){const abs=path.resolve(root,'src/background',rel);vm.runInContext(fs.readFileSync(abs,'utf8'),sandbox,{filename:abs});}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8'),sandbox,{filename:'service-worker.js'});

(async()=>{
  await new Promise((resolve,reject)=>{
    const req=indexedDB.open('notecraft-spike',7);
    req.onupgradeneeded=()=>{
      const db=req.result;
      const meta=db.createObjectStore('articleMeta',{keyPath:'articleId'});
      meta.put({articleId:'legacy',lastText:'legacy body',lastTs:1,lastKind:'checkpoint',updatedAt:1,isDraft:false});
    };
    req.onsuccess=()=>{req.result.close();resolve();};
    req.onerror=()=>reject(req.error);
  });
  const upgraded=await sandbox.openDB();
  {
    const tx=upgraded.transaction('articleMeta','readonly');
    const legacy=await sandbox.reqPromise(tx.objectStore('articleMeta').get('legacy'));
    await sandbox.txComplete(tx);
    assert.ok(legacy.lastFingerprint,'v7 lastText must migrate to fingerprint');
    assert.ok(!Object.prototype.hasOwnProperty.call(legacy,'lastText'),'v8 metadata must remove plaintext lastText');
  }

  const ctxA={tabId:1,documentId:'docA',key:'1:docA',route:{kind:'article',articleId:'n1'}};
  const ctxB={tabId:2,documentId:'docB',key:'2:docB',route:{kind:'article',articleId:'n1'}};
  const sA='11111111-1111-4111-8111-111111111111';
  const sB='22222222-2222-4222-8222-222222222222';
  await sandbox.saveSnapshot(ctxA,'n1','A1','rolling',sA);
  await sandbox.saveSnapshot(ctxB,'n1','B1','rolling',sB);
  let rows=await sandbox.getSnapshotsRaw('n1');
  assert.strictEqual(rows.length,2,'different tabs must not overwrite each other rolling saves');
  await sandbox.saveSnapshot(ctxA,'n1','A2','rolling',sA);
  rows=await sandbox.getSnapshotsRaw('n1');
  assert.strictEqual(rows.length,2,'same-session rolling save should coalesce its own prior rolling save');
  assert.ok(rows.some(r=>r.text==='B1'));
  assert.ok(rows.some(r=>r.text==='A2'));
  await sandbox.saveSnapshot(ctxA,'n1','A2','checkpoint',sA);
  rows=await sandbox.getSnapshotsRaw('n1');
  assert.ok(rows.some(r=>r.text==='A2'&&r.kind==='checkpoint'),'checkpoint should promote identical rolling snapshot');
  for(let i=0;i<8;i++) await sandbox.saveSnapshot(ctxA,'n1','C'+i,'checkpoint',sA);
  rows=await sandbox.getSnapshotsRaw('n1');
  assert.strictEqual(rows.length,5,'snapshot retention must stay at five');

  const ctxNew={tabId:3,documentId:'draftDoc',key:'3:draftDoc',route:{kind:'new',articleId:null}};
  const draftId=await sandbox.getOrCreateTempArticleId(ctxNew);
  const draftSession='33333333-3333-4333-8333-333333333333';
  await sandbox.saveSnapshot(ctxNew,draftId,'draft body','checkpoint',draftSession);
  const ctxArticle={tabId:3,documentId:'articleDoc',key:'3:articleDoc',route:{kind:'article',articleId:'n2'}};
  const migrated=await sandbox.claimRecentDraft(ctxArticle,'n2','draft body');
  assert.strictEqual(migrated.migrated,true,'exact recent draft should migrate to formal article');
  const migratedRows=await sandbox.getSnapshotsRaw('n2');
  assert.ok(migratedRows.some(r=>r.text==='draft body'));
  assert.strictEqual((await sandbox.getSnapshotsRaw(draftId)).length,0,'source draft snapshots should be removed after migration');

  const historyToken=await sandbox.putHistorySession('n1',1);
  const historySenderA={id:sandbox.chrome.runtime.id,tab:{id:90},frameId:0,documentId:'historyA',url:sandbox.chrome.runtime.getURL('src/ui/history.html')};
  const historySenderB={id:sandbox.chrome.runtime.id,tab:{id:91},frameId:0,documentId:'historyB',url:sandbox.chrome.runtime.getURL('src/ui/history.html')};
  await sandbox.authorizeHistorySession(historySenderA,historyToken);
  await assert.rejects(()=>sandbox.closeHistorySession(historySenderB,historyToken),/bound to another tab/);
  const closeResult=await sandbox.closeHistorySession(historySenderA,historyToken);
  assert.strictEqual(closeResult.closed,true,'bound history tab should be able to close its capability session');

  {
    const db2=await sandbox.openDB();
    const tx2=db2.transaction('snapshots','readwrite');
    tx2.objectStore('snapshots').put({articleId:'draft:orphan',ts:Date.now()-31*24*60*60*1000,text:'old',charCount:3,kind:'checkpoint',sourceSessionId:null});
    await sandbox.txComplete(tx2);
  }
  await sandbox.runGc();
  assert.strictEqual((await sandbox.getSnapshotsRaw('draft:orphan')).length,0,'orphan draft payload should be collected');

  const db=await sandbox.openDB();
  const tx=db.transaction('articleMeta','readonly');const meta=await sandbox.reqPromise(tx.objectStore('articleMeta').get('n1'));await sandbox.txComplete(tx);
  assert.ok(!Object.prototype.hasOwnProperty.call(meta,'lastText'),'articleMeta must not duplicate plaintext');
  assert.ok(meta.lastFingerprint);

  console.log('service-worker tests: OK');
})().catch(err=>{console.error(err);process.exit(1);});
