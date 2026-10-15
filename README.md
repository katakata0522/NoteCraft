# KakuSave Preview v0.9

**note執筆中の本文テキストを、ブラウザ内だけに残すローカル履歴バックアップ。**

KakuSaveは、noteの編集画面で本文テキストを定期的にスナップショット保存し、過去本文の確認・比較・コピーをできるようにするChrome拡張です。note本体の保存機能を置き換えるものではなく、別系統のローカル保護層として動作します。

> **公開状態:** コード・静的テスト・IndexedDB統合テスト済み。実noteアカウントでの最終E2Eはリリースゲートとして未完了です。

## KakuSaveが守るもの

- 5秒間編集が止まった後のrolling snapshot
- 60秒ごとのcheckpoint
- タブ非表示・ページ離脱前のbest-effort保存
- 同一記事を複数タブで開いた場合のsession分離
- 新規記事から正式記事IDへ移る際の完全一致ベースの安全な履歴移行
- 保存済み本文の世代比較・コピー
- 当日初回観測時点からの追加/削除文字数

## 守らないもの

保存対象は **本文テキストのみ** です。タイトル、見出し書式、リンク属性、画像、埋め込み、ProseMirror内部構造の完全復元は対象外です。

また、KakuSaveはnoteの公式機能ではありません。note側の画面構造変更で本文エディタを検出できなくなった場合、10秒後に互換性警告を表示します。

## セキュリティ / プライバシー

- 外部送信なし
- note本文への自動書き込みなし
- 保存先はextension-origin IndexedDB
- 過去本文はnote content scriptへ返さず、extension-originの履歴画面だけで取得
- Service Worker側でsender.id / top frame / documentId / HTTPS host / route / articleId / draft mappingを再認可
- 履歴画面は短命capability tokenをtab + documentIdへbind
- `connect-src 'none'`
- `externally_connectable.ids=[]`
- `unlimitedStorage`を使用しつつ自前256MB安全上限を設置

## v0.9での公開前ブラッシュアップ

- 製品名を既存同名製品と衝突するNoteCraftから **KakuSave** へ変更
- Chrome Web Store提出用16/32/48/128pxアイコンを追加
- manifest / package / UI / 履歴画面のブランドを同期
- note本文エディタを10秒以上検出できない場合に、DOM互換性警告を表示
- CIでmanifest名・version・アイコン実在を検査
- 公開用Store文言と手動E2Eリリースゲートを明文化

内部の `NC_*` message名、`NoteCraftCore`、既存IndexedDB schemaは、既存データとの互換性を守るためv0.9では意図的に変更しません。

## リリースゲート: 実note E2E

以下がすべて通るまで正式公開扱いにしません。

- [ ] 空の新規記事でKakuSaveパネルが出る
- [ ] 5秒idle / 60秒 checkpoint / 非表示前best-effort保存が動く
- [ ] 同じ記事を2タブで編集しても、一方のrolling履歴がもう一方に消されない
- [ ] 記事A→B高速遷移で履歴が混ざらない
- [ ] 新規記事→正式ID移行で完全一致時のみdraft履歴が移る
- [ ] SAVE失敗時でも既存履歴を開ける
- [ ] TRACE失敗時は0ではなく`—`になる
- [ ] 履歴削除後、現在本文から保護が再開する
- [ ] Chrome再起動後も履歴が残る
- [ ] note本体の入力・保存・undoを壊さない
- [ ] エディタを意図的に検出不能にしたfixtureで10秒後に互換性警告が出る

詳細は `RELEASE_CHECKLIST.md` を参照してください。

## ローカルテスト

```bash
npm install --ignore-scripts
npm run check
npm test
```

KakuSaveは現時点では需要検証前のPreviewです。実note E2Eと初期ユーザーテストが通るまでは、完成度の高さだけを事業継続理由にしません。
