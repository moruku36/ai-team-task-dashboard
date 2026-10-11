# 9. Backlog.md MVP構成（最終）

確認日：2026-10-11。Kanboard案（01〜08章）はこの構成で置換済みです。選定経緯は[OSS再選定提案](oss-reselection-20261011.ja.md)。

## 構成

```text
各AI（Windows上のClaude Code等 / dot経由）
  └─ scripts\backlog.ps1（公式CLI。BACKLOG_CWDを固定、実行後に元へ戻す）
       └─ 共通data root（no-git・コードrepoの外）  ← 正本
            └─ file watch → WebSocket tasks-updated → 標準Web画面が /api/search（type=taskの結果からtaskを抽出） を再取得
scripts\Start-Dashboard.ps1 = 公式 backlog browser --no-open（127.0.0.1のみ）
```

- 独自UI・独自REST wrapperは作らない。表示も更新も公式機能のみ。固定した版は v1.53.0（upstream commit `fd20f71493fb4eda44b021aa89f257956f17fb71`）、GitHub release asset digestとのSHA256検証後だけ実行する（`Install-Backlog.ps1`）。
- data rootの既定は `%LOCALAPPDATA%\ai-team-task-dashboard\data`。コードrepo配下・gitワークスペース配下は拒否。既存の `config.yml` は変更しない。no-gitの4項目が一度だけcanonical keyで明示されない既存設定、root/別形式設定、未初期化の非空フォルダ、root/祖先/内部ファイルとディレクトリのjunction/symlink、別Backlog rootの子は拒否します。リンクを辿る前に階層ごとに検査します。
- 状態は `To Do / In Progress / Awaiting Approval / Blocked / Verifying / Done`（初期化直後のconfigの `statuses` 行だけを編集。`config set statuses` は未対応）。
- 認証・firewall・VPN・常設MCP登録は行わない。外部公開は別段階（proxy等を別途設計）。

## 所有と更新

- **1 task 1主担当（assignee）**。主担当だけがstatusを更新する。他AIのレビューは子taskか報告で渡す。
- `observed_at`（根拠から確認した時刻）/`reported_at`（AI報告時刻）/`source`/`next_action`/`wait_reason` は既存のdescriptionまたはnotesに書く。保存時刻はBacklog.mdのUpdated。
- 更新は公式CLI/MCP経由のみ。Markdown直接編集はlockを迂回する。

## 同時更新と古い入力

- wrapperはUSE_GLOBAL_TASK_ID_LOCKを呼出し中だけtrueへ固定し、BACKLOG_CWDとともにfinallyで元へ戻します。グローバルOS設定は変えません。task単位lockがあるため、**別taskの同時更新**は5件並列の合成試験で欠落がないことを確認しました。一般的な安全性保証ではありません。
- lockは**CAS（期待revisionによる拒否）ではない**。古い状況を見たAIが後からstatusを上書きできる。`stale`（観測が古い）は運用上の目印で、システムは拒否しない。更新前にtaskを読み直して主担当・現在statusを確認する。
- 応答が不明な時は、保存済みか照合してから再送する。task作成・commentをblind retryしない（重複する）。中断後は再取得してから再開する。

## 接続・更新時間

- 仕事の状態と、画面の接続状態は別。通信断を失敗・完了へ変換しない。画面取得が成功しても、`observed_at` が古ければ最新確認済みではない。
- 目標：保存確認から画面反映まで10秒未満。実測（合成試験、ローカル）は保存後おおむね0.1〜0.2秒だが、設計目標の確認であり性能保証ではない。AIの報告遅延・dotからWindowsへの委譲時間は含まない。
- 標準の **health用** WebSocketは切断後5秒ごとに再試行し、復旧時に一度再取得します。データ通知用WebSocketは再接続しません。実headless Chromeで、server再起動後の2回の更新が各10秒以内にDOMへ反映しないことを確認しました。**切断・server再起動後は、明示的なページ再読込が必要です**。接続表示が復旧しても継続更新の復旧を意味しません。上流UI/binaryは改変していません。

## 承認

「Awaiting Approval」は利用者判断待ちの**表示**にすぎない。列移動やAIの「approved」記載は、購入・公開・マージ・実行の許可にならない。承認後の実作業は元の対象と範囲を確認して行う。実行ボタンは作らない。

## dotの経路

cloud側のdotはlocalhost/stdioへ直接到達しない。許可されたWindows作業経路が `scripts\backlog.ps1` を呼び、Windows CLIへ委譲する。

## 検証

`node tests\integration.mjs`（Node 22+、依存なし）。一時のno-git rootと合成30件で、作成→In Progress→Awaiting Approval→Done、`tasks-updated`→`/api/search`のtask抽出と再取得<10秒、UI asset配信、手製clientの手動WS再接続、server再起動と新規client接続、別task並列更新、127.0.0.1限定を確認する。標準UIの自動復旧の試験ではありません。実PowerShell5.1 wrapperの引数/標準出力/MCPも含め36項目合格。結果JSONは無視対象の `results\` のみに保存し、実dataには触れない。

`tests/safety.ps1`は追加の合成安全負例29項目合格。`node tests/frontend.mjs`は実標準UIを隔離profileのheadless Chrome/CDPで試験し、22/23項目・継続更新FAIL（非zero終了）。明示reload後のsnapshotと次の更新が戻ることも確認しました。[訂正済み検証記録](11-validation-20261011.ja.md) に内訳と制限を記載しています。

公式stdio MCP経由の更新、同taskの並列追記、古いstatusが受理される限界、既存設定と非空フォルダの保護も試験します。[AIの更新手順](10-agent-update-protocol.ja.md) を各Windows委譲経路に共通で適用します。

## 出所と検証範囲

[公式 v1.53.0 release](https://github.com/MrLesk/Backlog.md/releases/tag/v1.53.0) の x64 baseline 配布物を取得し、GitHub API の公開 digest `f5d4678ababa11e36866186e897a86e68e9f1f3c263d6c97034f674622abc689` と一致しました。Authenticode は NotSigned です。追加の署名済みチェックサムファイルは release assets にありません。タグ固定の [server](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/server/index.ts) と [UI](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/App.tsx) で通知・再取得の接続を確認し、実機のHTTP/WSで測定しました。初版の/api/tasks再取得は標準画面経路ではありませんでした。修正版は/api/searchを使い、別のCDP/headless Chrome試験で実DOMと通信も確認しています。

## 未検証・制限

アプリ内の利用者別認証/RBACなし。対話的GUI操作、sleep/OS再起動後の自動起動、cloud AI実接続、backup/restoreは未試験。実ブラウザのDOM/通信はheadlessで試験済みですが、切断後の無操作継続更新は標準v1.53.0の既知の未達要件です。
