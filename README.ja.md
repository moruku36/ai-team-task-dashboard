# AIチーム・タスクダッシュボード WindowsローカルMVP

## 現在の状態（2026-10-11）

**Backlog.md v1.53.0（公式・版固定）によるWindowsローカルMVPを実装しました。独自UI/REST wrapperはありません。2026-10-11に採用と即実装が承認されました。実タスクの取込みと外部公開は後続段階です。** 構成は **[Backlog.md MVP構成（最終）](docs/09-backlog-md-architecture.ja.md)** を参照してください。選定経緯は[OSS再選定提案](docs/oss-reselection-20261011.ja.md)です。

検証記録：[合成32項目と実測時間](docs/11-validation-20261011.ja.md)。共通更新手順：[AIの更新プロトコル](docs/10-agent-update-protocol.ja.md)。

### 使い方（PowerShell）

```powershell
.\scripts\Install-Backlog.ps1                     # 版固定binaryをSHA256検証して .runtime\ へ
.\scripts\Initialize-DataRoot.ps1                 # 既定: %LOCALAPPDATA%\ai-team-task-dashboard\data（-DataRoot で変更）
.\scripts\Start-Dashboard.ps1                     # http://127.0.0.1:6420 （--no-open、ブラウザは自分で開く）
.\scripts\backlog.ps1 task list --plain         # 公式CLIをdata root固定で実行
node tests\integration.mjs                         # 合成試験（一時rootのみ。結果は results\ に保存）
```

data rootはコードrepoやgitワークスペースの外に置く必要があり、該当すると拒否します。既存configは変更しません。

最新の検討内容は **[OSS再選定提案：13候補比較、更新経路、受入試験](docs/oss-reselection-20261011.ja.md)** を参照してください。

- 最優先は「AIが更新する → 保存を確認する → 開いた画面へ反映する」の一続きの経路です。人手転記を通常経路にしません。
- Backlog.mdの公式CLI/MCPと標準Web画面を採用しました。Windowsローカル、共通のタスク保存先、1タスク1主担当を想定します。
- 利用者別認証/RBAC、古い入力を拒否するCAS、クラウドAIからの実接続などには制約や未検証点があります。標準機能だけで解決済みとは扱いません。
- 確認済み：一時rootでの合成CLI/HTTP/WebSocket試験。未実施：実データ、GUI確認、クラウドAIの実接続、自動起動、外部公開です。
- 将来の認証付き外部閲覧・常時稼働ホストは独立した設計段階です。公開GitHubリポジトリに実タスクを保存する計画ではありません。

## 置換済みの初版資料

**Kanboard選定は[Backlog.md MVP構成](docs/09-backlog-md-architecture.ja.md)に置換済みです。以下は初版の判断を残した参考記録であり、現行構成・採用決定・構築指示ではありません。** 全面改訂は新案の確認後に行います。

1. [置換済み・要件と画面](docs/01-requirements-and-ui.md)
2. [置換済み・全体構成](docs/02-architecture.md)
3. [置換済み・Kanboard選定理由](docs/03-adr-oss-selection.md)
4. [置換済み・安全設計と承認の境界](docs/04-security-and-approval.md)
5. [置換済み・データ/API](docs/05-data-and-api.md)
6. [置換済み・導入段階・費用・移行](docs/06-deployment-and-migration.md)
7. [置換済み・受入試験・作業順](docs/07-acceptance-and-backlog.md)
8. [置換済み・公式出典](docs/08-sources.md)

[カード記入例](examples/task-card.md)と[スナップショット例](examples/task-snapshot.json)も旧案の架空データです。Backlog.mdのネイティブ形式や現行のデータ契約ではありません。

## リポジトリの範囲

ローカル起動・更新スクリプト、テスト、現行設計・参考資料・架空例のみです。実タスク、秘密、個人の会話全履歴、上流アプリのコードは含めません。製品をOSSから選ぶことと、このリポジトリ独自の文書・将来の拡張の公開ライセンスは別で、後者は未選定です。

確認日：2026-10-11。製品の対応版・ライセンス・料金条件は導入時に再確認します。製品利用料0円と、ホスティング・保守・電力・既存AI利用料0円は別です。
