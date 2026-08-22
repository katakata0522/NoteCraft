# NoteCraft v0.8 hardening review

v0.7の辛口レビューで確認したP0/P1/P2をまとめて修正した記録。

## P0

- 同一記事の複数タブrolling競合 → sourceSessionId単位coalesceへ変更

## P1

- 初期SAVE失敗で履歴UIまで失う → SAVE / HISTORY / TRACEを分離
- 256MB上限が置換まで止める → freed payloadを考慮
- dayBaseが上限を素通り → 同じ容量policyを適用
- TRACE障害が+0/-0に見える → `—` + unavailable表示
- 離れた複数変更のTRACE過大計上 → bounded LCS + 大差分は概算表示
- 削除の2クリック誤発火 → native dialog確認
- 削除後TRACE seed遅延 → 現在本文で即reseed
- GCがService Worker寿命依存 → chrome.alarms
- テスト不足 → GitHub Actions / policy / security / fake IndexedDB統合テスト

## P2

- 外部extension接続入口 → externally_connectableを明示的に閉じる
- 250msごとの重いDOM検索 → route 500ms / editor identity 2秒へ分離
- aria-liveノイズ → 通常自動SAVEは読み上げない
- 小さく薄い補助文字 → font size / contrast改善
- articleMeta本文重複 → fingerprint化
- DB旧版migration → v7→v8 migration追加

## まだ残る検証

実note DOM、新規記事遷移、clipboard、pagehide、Chrome再起動、複数タブ、undoへの影響は実ブラウザで要確認。

## v0.8実装中に追加で捕捉した回帰

- content script分割時のトップレベル`return`がNode `--check`では検出できない可能性 → browser classic script parse testを追加し、guardをトップレベルreturnなしへ修正
- IndexedDB `onblocked`後に遅れて成功したconnectionが未管理になる可能性 → settled state + timeout + late connection closeへ修正
- GC簡略化でmetadata/mapping欠損の孤児payload検出を落としかけた → snapshot/dayBase key scanを復帰
- history CLOSEだけcapability binding確認が弱くなっていた → history tab/document bindingを再検証してから破棄
