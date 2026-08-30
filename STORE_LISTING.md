# KakuSave - Chrome Web Store listing draft

## Title
KakuSave - note本文バックアップ

## Short description
note執筆中の本文テキスト履歴をブラウザ内だけに保存。外部送信なし・本文書き換えなし。

## Detailed description
KakuSaveは、noteで長い文章を書くときのためのローカル履歴バックアップです。

編集が止まってから5秒後の自動保護、60秒ごとのチェックポイント、タブを離れる前のbest-effort保存を組み合わせ、本文テキストの過去世代をChrome内に残します。

### 主な機能
- 本文テキストの自動スナップショット
- 保存世代の時系列表示
- 2世代の差分比較
- 過去本文のコピー
- 同じ記事を複数タブで編集した場合の履歴分離
- 新規記事から正式記事IDへ移る際の安全な履歴引き継ぎ
- 本日初回観測時点からの追加/削除文字数
- note側の画面構造変更を検知しやすくする互換性警告

### プライバシー
本文テキストは開発者サーバーへ送信しません。保存先はChrome拡張機能専用のIndexedDBです。KakuSaveからnote本文への自動書き戻しも行いません。

### 保護範囲
KakuSaveが保存するのは本文テキストのみです。タイトル、見出し書式、リンク属性、画像、埋め込み、noteエディタ内部構造の完全復元は対象外です。

KakuSaveはnote株式会社の公式製品ではありません。note側の仕様変更により一時的に動作しなくなる可能性があります。

## Permission justification
### unlimitedStorage
本文履歴をユーザーのChromeプロファイル内にローカル保存するために使用します。KakuSave自身でも256MBの安全上限を設けています。

### alarms
Manifest V3 Service Workerの停止に依存せず、不要になった一時draftデータを日次で整理するために使用します。

## Data use declaration notes
- Web history: collected externally = No
- Website content: transmitted externally = No
- Personally identifiable information: collected externally = No
- Authentication information: No
- Financial information: No
- User activity for advertising/analytics: No

本文テキストは拡張機能機能提供のためローカルで処理・保存しますが、開発者へ送信しません。

## Reviewer note
This extension only runs on note editor routes declared in `content_scripts.matches`. It does not request `<all_urls>`, does not inject into unrelated pages, and extension pages use `connect-src 'none'`.
