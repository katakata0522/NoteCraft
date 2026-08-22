# NoteCraft Spike v0.7 — Architecture

## 1. 原則

1. **SAVE優先**: TRACEやUIが壊れてもsnapshot保存を巻き込まない
2. **Fail closed**: 記事IDに確信が持てなければ保存・移行しない
3. **Content scriptを信頼しない**: privileged data accessはService Worker側で再認可
4. **Local only**: 本文を外部ネットワークへ送らない
5. **No editor writes**: note本文を自動書き換えしない
6. **Spike scope**: 本文テキストの技術検証に限定

## 2. 構成

```text
note editor DOM
    ↓ read only
content script
    ↓ chrome.runtime.sendMessage
service worker
    ↓
extension-origin IndexedDB
```

### Content script

- ProseMirror検知
- Shadow DOM UI
- route/DOM安定待ち
- generation/contextチェック
- MutationObserver
- 5秒idle / 60秒 / visibility/pagehide snapshotトリガー
- diff表示
- TRACE表示

### Service Worker

- sender認証
- route-bound authorization
- IndexedDB保存
- DB-level dedupe
- monotonic snapshot timestamp
- transaction内世代trim
- draft mapping
- safe draft claim / atomic migration
- orphan draft GC

## 3. IndexedDB

### snapshots

key: `[articleId, ts]`

```js
{
  articleId,
  ts,
  text
}
```

index:

- `articleId`

### articleMeta

```js
{
  articleId,
  lastText,
  lastTs,
  updatedAt,
  isDraft
}
```

`lastText` はsnapshot重複排除をtransaction内で完全一致判定するために保持します。Spikeでは容量効率より誤判定回避を優先します。

### dayBases

key: `[articleId, dateKey]`

TRACEの「本日初回観測時点比」算出用。

### tabDrafts

新規記事が正式articleIdを持つ前の一時mapping。

indexes:

- `articleId`
- `tabId`

### housekeeping

GCの最終実行時刻などを保存。

## 4. SAVEのatomicity

snapshot保存時は `snapshots + articleMeta` を同じreadwrite transactionで扱います。

draftの場合は `tabDrafts` も同じtransactionへ含めます。

これにより:

- 同一本文の並行SAVE
- migration直後のstale draft SAVE
- tab/page遷移競合

で孤児snapshotを作りにくくします。

snapshot追加と「最大5世代」trimも同じtransactionです。

## 5. SPA / 非同期race対策

Content側:

- URL変化を検知したtickでは再attachしない
- route settle待ち
- editor候補を一定時間再確認
- generation tokenでstale callback破棄
- async完了時にroute + editor identityを再確認

Service Worker側:

- MessageSenderの現在routeとarticleIdを再照合
- stale contentから別記事IDへのSAVEを拒否

## 6. Cross-origin draft claim

新規作成ページと正式editorが別documentになる場合、content scriptのメモリ状態を引き継げません。

そこで正式記事attach時に:

1. 同tabIdの直近draft mappingを候補化
2. `articleMeta.lastText === current editor text` の完全一致を要求
3. migration transaction内でも同じ一致条件を再確認
4. 合わなければmigrationしない

誤移行のfalse positiveを避ける設計です。

## 7. Draft GC

- 30日以上活動のない `draft:*` を対象
- 24時間に最大1回
- snapshots / meta / dayBases / mappingを削除
- Service Worker内ではGC promiseを共有して多重scanを防止

## 8. データ精度

### 文字数

NFKCは使いません。

`Ⅳ → IV` のように互換正規化で文字数そのものが変わるためです。

現状:

- zero-width文字を除外
- 改行を除外
- Unicode code point単位

### diff

LCSはUnicode code point単位で処理し、絵文字のsurrogate pairを分割しません。

### TRACE

「今日タイプした総量」ではなく、**本日初回観測時点の本文と現在本文との差**です。

## 9. Known limitations

- 本文テキストのみ
- title / formatting / image / embed未保存
- exact note character-count semantics未検証
- pagehide/visibility SAVEはbest-effort
- 5世代のみ
- 実note E2E未検証
