# NoteCraft Spike v0.8 — Architecture

## 原則

1. SAVE優先: TRACE/UI障害でsnapshot保存を巻き込まない
2. Fail closed: 記事IDやdraft対応に確信がなければ保存・移行しない
3. Content scriptを低信頼境界として扱う
4. Local only / no editor writes
5. 障害時に「0」「保存済み」など誤解を招く状態を表示しない

## 保存モデル

`snapshots`: `[articleId, ts]`。本文、charCount、kind、`sourceSessionId`を保存。

`articleMeta`: 最新timestamp / kind / session / fingerprintのみ。本文全文は重複保持しない。

`dayBases`: TRACE用。1記事最大2日。

`tabDrafts`: 新規記事の一時ID mapping。

`historySessions`: extension-origin履歴画面用の短命capability。

## Multi-tab

各attachで`crypto.randomUUID()`によるeditor session IDを生成。rolling coalesceは同じ`sourceSessionId`のrollingだけを対象にする。別タブのrollingを削除しない。

## 容量上限

`navigator.storage.estimate()`で256MB以上なら新規増加を原則停止。ただし、同一session rolling置換や5世代trim等で解放される本文サイズ以上に増えない書き込みは許可する。dayBaseも同様。

## TRACE

小規模な変更領域はLCSでadded/removedを算出。差分中央部が大きい場合はprefix/suffixベースへfallbackし、UIに`≈`を表示して概算であることを明示する。

## GC

`chrome.alarms`で日次実行。MV3 Service Workerのidle終了に定期GCを依存させない。

## DB migration

DB v8で旧`articleMeta.lastText`をfingerprintへ変換後削除。history capabilityはschema/security変更時に持ち越さない。

## Browser script validation

content scriptはNodeのCommonJSとしてではなくChromeのclassic scriptとして実行される。`node --check`だけではトップレベル`return`等を見逃し得るため、CIでは`vm.Script`でも全extension scriptをparseする。

## GCの壊れ方への耐性

通常のdraft mapping/metaだけでなく、旧版・クラッシュ等でsnapshot/dayBaseだけ残った`draft:*`もkey-only scanで検出する。削除直前にはpayload timestampも含めてfreshnessを再評価し、最近のpayloadを誤削除しない。

## 容量ガードの意味

256MBはChrome quotaそのものではなくNoteCraft側の保守的なsoft guard。上限到達時でも、同一session rolling置換や5世代trimで解放する本文payload以上に増えない書き込みは許可する。
