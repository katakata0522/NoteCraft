# NoteCraft Spike v0.7

**状態:** 実装・静的検証済み。実際のnoteアカウント上でのE2Eは未検証です。

これは需要検証前の **捨てても惜しくない技術Spike** です。完成度の高さ自体は事業継続理由にしません。

## このSpikeで検証すること

- note本文エディタを壊さず読み取れるか
- 本文テキストを拡張機能自身のIndexedDBへ安全に保存できるか
- SAVE → BACK → TRACE の中核体験が実際に役立つか
- SPA遷移・新規記事ID確定・Chrome再起動などでも記事履歴が混ざらないか

## できること

- 現在の本文文字数表示
- attach直後の初期snapshot
- 5秒入力が止まった後のsnapshot
- 60秒ごとのsnapshot
- タブ非表示 / pagehide時のbest-effort snapshot
- 同一本文の重複snapshot抑止
- 最大5世代
- 2世代比較diff
- 過去本文のクリップボードコピー
- 「本日初回観測時点比」の追加 / 削除文字数
- 新規記事の一時draft履歴を、正式記事側の本文と**完全一致した場合だけ**安全に引き継ぐ
- 30日以上放置された孤児draftを自動GC

## 重要な仕様境界

このSpikeが保存するのは **本文テキストのみ** です。

現時点では以下を完全バックアップしません。

- 記事タイトル
- 見出し等のリッチテキスト書式
- リンク属性
- 画像
- 埋め込み
- その他ProseMirror内部構造

したがって、これは現段階では「note記事の完全復元ツール」ではなく、**本文テキストの独立セーフティネット**です。

また文字数は「ゼロ幅文字と改行を除いたUnicodeコードポイント数」であり、note公式の厳密な文字数定義との一致は未検証です。

## プライバシー / 保存先

- 本文は外部送信しません
- 保存先はService Workerからアクセスする **拡張機能originのIndexedDB** です
- content scriptからnote.com側のIndexedDBへ直接保存しません
- `unlimitedStorage` を要求し、Chromeの通常のquota / evictionから保護します
- ユーザーが通常の閲覧データを削除しても、拡張originの保存領域は別管理です
- 拡張機能をアンインストールすると、その拡張機能のローカルデータは失われます
- 保存内容自体を暗号化する機能はこのSpikeにはありません

## セキュリティ境界

Service Workerはcontent scriptを信頼しません。

- `sender.id` が自拡張か確認
- top frameのみ許可
- `sender.documentId` を要求
- HTTPSの `note.com` / `editor.note.com` のみ許可
- 現在URLの記事IDと、要求されたarticleIdを照合
- draft書き込みはmappingの検証を**同じIndexedDB transaction内**で実施
- content scriptから任意の記事履歴を読み出せないようroute-bound authorizationを実施

## 新規記事 → 正式記事の引継ぎ

`note.com/notes/new` から `editor.note.com/notes/<id>/edit` への遷移では、文書自体が入れ替わる可能性があります。

そのためdocumentIdだけを頼りに自動移行しません。

正式記事側で:

1. 同じtabIdにある直近2分のdraft候補を検索
2. draftの最新本文と、正式記事で現在表示されている本文が**完全一致**するか確認
3. 一致した場合のみ一括migration
4. migration transaction内でも再度本文一致を検証

一致しなければ履歴を混ぜず、正式記事を新規に保存します。誤移行より未移行を優先するfail-safe設計です。

## インストール

1. このフォルダを任意の場所へ置く
2. Chromeで `chrome://extensions` を開く
3. 「デベロッパーモード」をON
4. 「パッケージ化されていない拡張機能を読み込む」
5. `NoteCraft-Spike-v0.7` フォルダを選択
6. note編集画面を開く

## 実noteで確認するチェックリスト

- [ ] 空の新規記事でもNoteCraftパネルが出る
- [ ] 本文文字数が入力に追従する
- [ ] 絵文字1文字が不自然に2文字扱いにならない
- [ ] attach直後に初期snapshotが作られる
- [ ] 入力停止後約5秒でsnapshotが追加される
- [ ] 同一本文のまま60秒経っても重複世代が増えない
- [ ] 全文削除した「空状態」も履歴として保存される
- [ ] 最大5世代を超えたら古い世代から消える
- [ ] 2世代を選択するとdiffが表示される
- [ ] 絵文字のdiffが壊れた文字にならない
- [ ] 過去世代の「コピー」が動く
- [ ] 記事A → 記事Bを高速で移動しても履歴が混ざらない
- [ ] 新規記事 → 正式記事ID確定後、条件が合えば履歴が引き継がれる
- [ ] 引継ぎ条件が合わない場合は別記事へ誤混入しない
- [ ] Chrome再起動後も履歴が残る
- [ ] note.com側のサイトデータを削除しても拡張側履歴が残る
- [ ] note本体の入力・保存・undoを壊さない
- [ ] タブ非表示 / 離脱時保存はbest-effortであり、OS / Chrome強制クラッシュを保証しない

## ローカル静的テスト

```bash
node --check src/shared/core.js
node --check src/background/service-worker.js
node --check src/content/content.js
node tests/core.test.js
node tests/structure.test.js
```

## 現時点で意図的に作っていないもの

- 課金
- ログイン
- クラウド同期
- GA4
- AI生成
- note本文への自動復元
- 設定画面
- Chrome Web Store公開向け最終アセット
- 完全なリッチテキストbackup / restore
