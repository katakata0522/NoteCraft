# KakuSave v0.9 Release Checklist

このチェックリストは「コードが通った」ではなく「実noteで本文を守れる」を公開条件にするためのものです。

## 1. 自動検査

- [ ] `npm run check`
- [ ] `npm test`
- [ ] GitHub Actions success
- [ ] manifest version = `0.0.9`
- [ ] 16 / 32 / 48 / 128px icon がpackage内に存在
- [ ] `connect-src 'none'`
- [ ] content script対象がnote編集ルートだけに限定

## 2. 実Chrome / 実note 基本導線

1. unpacked extensionを読み込む
2. noteへログイン
3. 空の新規記事を開く
4. KakuSaveパネルが10秒以内に表示される
5. 100文字以上入力する
6. 5秒以上停止し「本文テキスト保護済み」になることを確認
7. 60秒以上待ちcheckpointが残ることを確認
8. 「安全な履歴画面を開く」から本文履歴を表示
9. 2世代を選び差分比較
10. 比較先Bをコピーし、内容が一致することを確認

## 3. 破壊系シナリオ

### 複数タブ
- [ ] 同じ記事を2タブで開く
- [ ] A/Bそれぞれ異なる本文へ編集
- [ ] A側rolling保存でB側rollingが消えない

### 高速記事遷移
- [ ] 記事Aを編集
- [ ] すぐ記事Bへ遷移
- [ ] Aの本文がB履歴へ混入しない

### 新規draft → 正式記事ID
- [ ] 新規記事で保存履歴を作る
- [ ] 記事を保存して正式IDへ移る
- [ ] 本文完全一致時だけdraft履歴が移行する
- [ ] 本文不一致時は移行しない

### 再起動
- [ ] Chrome終了
- [ ] 再起動
- [ ] 既存履歴を表示できる

### 履歴リセット
- [ ] 確認dialogなしでは削除できない
- [ ] リセット後に現在本文からcheckpoint/dayBaseが再seedされる
- [ ] note本体の本文は変化しない

## 4. note互換性診断

- [ ] 正常な実noteでエディタ検出警告が誤表示されない
- [ ] テストfixtureで `.ProseMirror[contenteditable=true]` と `[contenteditable=true][role=textbox]` を外す
- [ ] 10秒後に「note側の画面構造が変わった可能性があります」と警告する
- [ ] エディタが再び検出可能になると通常状態へ復帰する

## 5. note本体を壊さないこと

- [ ] 通常入力
- [ ] 日本語IME変換
- [ ] Enter / Backspace
- [ ] Undo / Redo
- [ ] note側の保存
- [ ] 画像・リンク・見出し操作
- [ ] タブ切替

上記で入力遅延・カーソル飛び・保存競合・undo履歴破壊がないこと。

## 6. Store提出前

- [ ] `STORE_LISTING.md` とmanifestの説明が一致
- [ ] 「完全復元」「絶対に消えない」等の保証表現がない
- [ ] note公式製品ではないことを明記
- [ ] プライバシーポリシー公開URLを用意
- [ ] Storeスクリーンショットで本文内容に個人情報を使わない
- [ ] Preview表記を正式公開時に外すか判断

## Release decision

**1〜6の必須項目が通るまでは正式版として公開しない。**

失敗がnote DOM依存なら、無理にselectorを広げず実DOMを確認して最小範囲で対応する。`https://note.com/*` のような広域権限への拡張で解決しない。
