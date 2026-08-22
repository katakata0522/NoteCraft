# NoteCraft Spike v0.8

**状態:** 実装・静的テスト済み。GitHub ActionsでIndexedDB統合テストを実行する構成。実noteアカウント上のE2Eは未検証です。

需要検証前の技術Spikeです。完成度の高さ自体を事業継続理由にはしません。

## v0.8で重点的に直したこと

- 同一記事を複数タブで編集しても、rolling snapshotは**同じeditor sessionのrollingだけ**を置換
- 初期SAVE失敗時も既存履歴を読み込み、履歴画面から復旧可能
- 256MB安全上限では、置換・trimで解放する容量を考慮してnet増加を抑制
- TRACE用dayBaseにも同じ安全上限方針を適用
- TRACE取得失敗を `0字` と偽装せず `—` 表示
- 小規模な複数箇所編集はLCSでより正確に差分文字数を算出。大規模差分は `≈` を付けて概算と明示
- 履歴削除をダブルクリック式から確認dialogへ変更
- 履歴削除直後に現在本文をdayBase/checkpointとして再seed
- draft GCをMV3 Service Workerの寿命に依存させず `chrome.alarms` で日次実行
- `externally_connectable.ids=[]` で外部拡張からの接続をmanifestレベルでも閉じる
- route監視と重いeditor identity確認の周期を分離
- 自動SAVE成功をaria-liveへ流さず、エラー・手動操作だけ読み上げ
- `articleMeta.lastText` を廃止し、fingerprint + latest snapshot exact compareへ移行
- DB v7→v8 migrationで旧`lastText`を削除
- GitHub Actions + browser-script/core/storage/security/IndexedDB統合テストを追加
- metadata/mappingが欠損した孤児draft payloadも日次GCで検出
- IndexedDB upgradeがblockedになった場合、遅れて開いたDB connectionをリークしないよう処理

## 保護範囲

保存するのは **本文テキストのみ** です。タイトル、見出し書式、リンク属性、画像、埋め込み、ProseMirror内部構造の完全復元は対象外です。

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

## 実noteでの最重要チェック

- [ ] 空の新規記事でパネルが出る
- [ ] 5秒idle / 60秒 checkpoint / 非表示前best-effort保存が動く
- [ ] 同じ記事を2タブで編集しても、一方のrolling履歴がもう一方に消されない
- [ ] 記事A→B高速遷移で履歴が混ざらない
- [ ] 新規記事→正式ID移行で完全一致時のみdraft履歴が移る
- [ ] SAVE失敗時でも既存履歴を開ける
- [ ] TRACE失敗時は0ではなく`—`になる
- [ ] 履歴削除は確認dialogを経由し、削除直後から現在本文の保護が再開する
- [ ] Chrome再起動後も履歴が残る
- [ ] note本体の入力・保存・undoを壊さない

## ローカルテスト

```bash
npm install --ignore-scripts
npm run check
npm test
```

実note E2Eが通るまでは「完成品」ではなくSpikeです。
