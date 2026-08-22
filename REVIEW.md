# NoteCraft v0.5 → v0.7 辛口レビュー記録

## P0 / P1で修正したもの

### 1. draft migrationがdocumentId連続性に依存

**問題:** `note.com` → `editor.note.com` のようなcross-origin navigationではdocumentが変わり得るため、同一content lifecycle前提のmigrationは弱い。

**修正:** 同tabの直近draft + 最新本文完全一致でclaim。migration transaction内でも再検証。

### 2. migrationが複数transaction

**問題:** migrationの読み取りと書き込みの間にstale SAVEが挟まり、source draftを再生成し得る。

**修正:** snapshots/meta/dayBases/tabDraftsを1 readwrite transactionへ統合。draft SAVEもtabDraftsを同一transactionで検証するためmigrationと直列化。

### 3. orphan draft GCなし

**修正:** 30日TTL、24時間単位のGC。多重GCもcoalesce。

### 4. MAX_SNAPSHOTSが仕様5→10へ逸脱

**修正:** 5へ復帰。UI/DBとも統一。

### 5. SAVEとTRACEをPromise.all

**問題:** TRACE用dayBase失敗を「保存失敗」と誤表示し得る。

**修正:** snapshot SAVEを先に独立完了させ、TRACEは非致命経路へ分離。

### 6. content script注入範囲が広い

**問題:** `https://note.com/*` はsingle purposeに対して過剰。

**修正:** `note.com/notes/*`, `note.com/new`, `editor.note.com/notes/*` のみに縮小。

### 7. NFKCを文字数へ使用

**問題:** `Ⅳ` が `IV` に展開されるなど、文字数そのものが変わる。

**修正:** NFKC廃止。zero-width除外 + Unicode code point単位。

### 8. emoji diffがUTF-16単位

**問題:** surrogate pair途中でdiffが分割される可能性。

**修正:** LCS/prefix/suffixをUnicode code point配列で処理。

### 9. MutationごとにIndexedDB dayBase読込

**問題:** 執筆中の不要なruntime message/IDBアクセス。

**修正:** dayBaseをattach contextへcache。日付が変わった場合だけ再取得。

### 10. privileged message境界

**強化:** sender.id / frameId / documentId / HTTPS host / editor route / articleId をService Workerで再検証。

draft write authorizationはDB transaction内でmappingまで確認。

## まだ「完成」と呼ばない理由

- 実note DOM未検証
- text-only backup
- title / formatting / image / embed未対応
- note公式文字数定義未照合
- clipboard挙動の実note確認が必要
- 新規記事遷移フローの実note確認が必要

したがって正確な状態は **「静的レビュー済みSpike / 実note検証待ち」**。
