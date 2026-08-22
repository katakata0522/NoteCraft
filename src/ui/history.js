(function () {
  'use strict';
  var Core = globalThis.NoteCraftCore;
  if (!Core) return;
  var MESSAGE_TIMEOUT_MS = 12000;
  var token = readToken();
  var snapshots = [];
  var selectedA = null;
  var selectedB = null;
  var statusEl = document.getElementById('status');
  var historyEl = document.getElementById('history');
  var diffEl = document.getElementById('diff');
  var compareBtn = document.getElementById('compare');
  var copySelectedBtn = document.getElementById('copySelected');
  var refreshBtn = document.getElementById('refresh');
  var selectionSummary = document.getElementById('selectionSummary');
  var storageInfoEl = document.getElementById('storageInfo');
  var deleteHistoryBtn = document.getElementById('deleteHistory');
  var deleteDialog = document.getElementById('deleteDialog');
  var confirmDeleteBtn = document.getElementById('confirmDelete');

  function readToken() {
    var raw = location.hash ? location.hash.slice(1) : '';
    var decoded = '';
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    return /^[0-9a-f-]{30,60}$/i.test(decoded) ? decoded : '';
  }
  function send(message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; reject(new Error('履歴の読み込みがタイムアウトしました')); } }, MESSAGE_TIMEOUT_MS);
      chrome.runtime.sendMessage(message, function (response) {
        var runtimeError = chrome.runtime.lastError;
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (runtimeError) return reject(new Error(runtimeError.message));
        if (!response || !response.ok) return reject(new Error(response && response.error ? response.error : 'no response'));
        resolve(response.result);
      });
    });
  }
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = kind === 'error' ? 'status error' : (kind === 'warn' ? 'status warn' : 'status'); }
  function friendlyError(error) {
    var text = error && error.message ? error.message : String(error || '');
    if (/expired|history session|token/i.test(text)) return 'この履歴画面の有効期限が切れました。note側から開き直してください。';
    if (/context invalidated|Receiving end/i.test(text)) return '拡張機能が更新された可能性があります。noteタブから開き直してください。';
    return '履歴を読み込めませんでした。note側から開き直してください。';
  }
  function kindLabel(kind) { return kind === 'rolling' ? '自動保護' : 'チェックポイント'; }
  function renderHistory() {
    historyEl.textContent = '';
    if (!snapshots.length) {
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'まだ本文履歴がありません。'; historyEl.appendChild(empty);
      compareBtn.disabled = true; copySelectedBtn.disabled = true; selectionSummary.textContent = '比較できる履歴がありません。'; return;
    }
    var rows = snapshots.slice().sort(function (a, b) { return b.ts - a.ts; });
    selectedB = selectedB && rows.some(function (r) { return r.ts === selectedB; }) ? selectedB : rows[0].ts;
    selectedA = selectedA && rows.some(function (r) { return r.ts === selectedA; }) ? selectedA : (rows[1] ? rows[1].ts : null);
    rows.forEach(function (snap) {
      var row = document.createElement('div'); row.className = 'history-row'; row.setAttribute('role', 'listitem');
      var time = document.createElement('div'); time.className = 'history-time'; time.textContent = Core.fmtDateTime(snap.ts);
      var meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = Number(snap.charCount || 0).toLocaleString() + '字 · ' + kindLabel(snap.kind);
      row.appendChild(time); row.appendChild(meta);
      var choices = document.createElement('div'); choices.className = 'choices'; choices.appendChild(makeChoice('A','compareA',snap.ts,selectedA===snap.ts,function(){selectedA=snap.ts;updateSelectionState();})); choices.appendChild(makeChoice('B','compareB',snap.ts,selectedB===snap.ts,function(){selectedB=snap.ts;updateSelectionState();})); row.appendChild(choices); historyEl.appendChild(row);
    });
    copySelectedBtn.disabled = false; updateSelectionState();
  }
  function makeChoice(labelText, groupName, ts, checked, onChange) {
    var label = document.createElement('label'); label.className = 'choice'; var input = document.createElement('input'); input.type = 'radio'; input.name = groupName; input.value = String(ts); input.checked = !!checked; input.setAttribute('aria-label','比較'+labelText+' '+Core.fmtDateTime(ts)); input.addEventListener('change',onChange); label.appendChild(input); label.appendChild(document.createTextNode('比較'+labelText)); return label;
  }
  function updateSelectionState() {
    var valid = Number.isFinite(selectedA) && Number.isFinite(selectedB) && selectedA !== selectedB; compareBtn.disabled = !valid;
    selectionSummary.textContent = valid ? 'A '+Core.fmtDateTime(selectedA)+' → B '+Core.fmtDateTime(selectedB) : (snapshots.length < 2 ? '比較には2世代以上必要です。' : '異なる2世代を選択してください。');
  }
  function formatBytes(value) { if (!Number.isFinite(value)) return '不明'; if (value < 1024*1024) return Math.max(0,Math.round(value/1024))+'KB'; return (value/(1024*1024)).toFixed(value < 10*1024*1024 ? 1 : 0)+'MB'; }
  async function loadStorageInfo() { if (!token) return; try { var info = await send({type:'NC_HISTORY_STORAGE',token:token}); storageInfoEl.textContent='NoteCraft使用量 '+formatBytes(info&&info.usage)+' / 安全上限 '+formatBytes(info&&info.safetyLimit); } catch (_) { storageInfoEl.textContent='ローカル使用量を取得できません'; } }
  async function loadList() {
    if (!token) { setStatus('この画面はnote側の「安全な履歴画面を開く」から開いてください。','error'); refreshBtn.disabled=true; return; }
    refreshBtn.disabled=true;
    try { var rows = await send({type:'NC_HISTORY_LIST',token:token}); snapshots=Array.isArray(rows)?rows:[]; renderHistory(); setStatus(snapshots.length?'本文履歴を安全な拡張機能領域で読み込みました。':'まだ本文履歴がありません。'); loadStorageInfo(); }
    catch(error){setStatus(friendlyError(error),'error');historyEl.textContent='';compareBtn.disabled=true;copySelectedBtn.disabled=true;}
    finally{refreshBtn.disabled=false;}
  }
  function getSnapshot(ts){return send({type:'NC_HISTORY_GET',token:token,ts:ts});}
  async function compareSelected(){if(compareBtn.disabled)return;compareBtn.disabled=true;diffEl.textContent='';setStatus('差分を計算しています…');try{var results=await Promise.all([getSnapshot(selectedA),getSnapshot(selectedB)]);var segs=Core.computeDisplayDiff(results[0].text||'',results[1].text||'',1200);segs.forEach(function(seg){if(!seg.text)return;var node=seg.type==='add'?document.createElement('ins'):seg.type==='del'?document.createElement('del'):document.createElement('span');node.textContent=seg.text;diffEl.appendChild(node);});setStatus('AからBへの本文テキスト差分を表示しています。');diffEl.focus({preventScroll:true});}catch(error){setStatus(friendlyError(error),'error');}finally{updateSelectionState();}}
  async function copySelected(){if(!snapshots.length)return;copySelectedBtn.disabled=true;try{if(!Number.isFinite(selectedB))throw new Error('copy target missing');var snap=await getSnapshot(selectedB);await navigator.clipboard.writeText(snap.text||'');setStatus('比較先Bの本文テキストをクリップボードへコピーしました。');}catch(error){setStatus(friendlyError(error),'error');}finally{copySelectedBtn.disabled=false;}}
  async function performDelete(){confirmDeleteBtn.disabled=true;deleteHistoryBtn.disabled=true;try{await send({type:'NC_HISTORY_DELETE_ALL',token:token});snapshots=[];selectedA=null;selectedB=null;diffEl.textContent='';renderHistory();setStatus('過去履歴をリセットしました。現在本文から保護を再開します。');await loadStorageInfo();}catch(error){setStatus(friendlyError(error),'error');}finally{confirmDeleteBtn.disabled=false;deleteHistoryBtn.disabled=false;}}

  refreshBtn.addEventListener('click',loadList);compareBtn.addEventListener('click',compareSelected);copySelectedBtn.addEventListener('click',copySelected);
  deleteHistoryBtn.addEventListener('click',function(){if(typeof deleteDialog.showModal==='function')deleteDialog.showModal();else if(confirm('過去履歴を削除しますか？'))performDelete();});
  deleteDialog.addEventListener('close',function(){if(deleteDialog.returnValue==='default')performDelete();});
  window.addEventListener('pagehide',function(){if(token){try{chrome.runtime.sendMessage({type:'NC_HISTORY_CLOSE',token:token});}catch(_){}}});
  loadList();
})();
