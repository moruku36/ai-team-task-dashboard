# AIチーム・タスクダッシュボード

言語：**日本語** | [English](README.md)

## 現状と次の計画（2026-10-12）

**現在は、公式Backlog.md v1.53.0を使うWindowsローカル版が稼働しています。PC停止中でも本人が一覧を見られるVercel＋Neon版は導入準備中です。初版設計はマージ済みで、画面／APIは未deploy・実データ未移行です。** NeonリソースはFree／Availableを確認済みですが、地域・プロジェクト接続・実DB疎通は未確認です。構築・アクセス保護は合成データだけで検証します。

![現在のWindowsローカル版と計画中の非公開クラウド版](docs/images/cloud-architecture.svg)

**[全体設計とMermaid構成図](docs/12-cloud-architecture.ja.md)** から読むと、現在と計画、認証、更新・閲覧経路、単一正本への移行、無料枠と未検証事項が分かります。

[English design](docs/12-cloud-architecture.md)／[日本語の図](docs/images/cloud-architecture.svg)／[English diagram](docs/images/cloud-architecture.en.svg)。

| 現在：稼働済み | 計画：導入準備中 |
|---|---|
| 公式Backlog.mdのCLI／MCP／標準Web画面 | Vercelの新しいKanban UI／API。Backlog.md自体のホストではない |
| 共通no-git Markdownが正本。私的タスクはローカルに取り込み済み | Neon PostgreSQLを唯一の正本にする。旧CLI/MCPとの自動同期はしない |
| loopbackで閲覧。PC起動が必要 | Vercel Authentication＋All Deploymentsで本人限定・全URL保護を検証 |
| file watch→WebSocket→標準画面 | MVPは30秒ごとと保存後の再取得。既存UIと機能・操作が完全に同じではない |

ローカル版には独自UI／REST wrapperはありません。[ローカルMVP構成](docs/09-backlog-md-architecture.ja.md)と[OSS選定経緯](docs/oss-reselection-20261011.ja.md)は、その採用時点の説明です。クラウドの候補実装は別ブランチで独立レビュー中です。追加Basic認証は採用しません。

検証記録：[訂正済み検証記録と再接続の未達要件](docs/11-validation-20261011.ja.md)。共通更新手順：[AIの更新プロトコル](docs/10-agent-update-protocol.ja.md)。

### 使い方（PowerShell）

```powershell
.\scripts\Install-Backlog.ps1                     # 版固定binaryをSHA256検証して .runtime\ へ
.\scripts\Initialize-DataRoot.ps1                 # 既定: %LOCALAPPDATA%\ai-team-task-dashboard\data（-DataRoot で変更）
.\scripts\Start-Dashboard.ps1                     # http://127.0.0.1:6420 （--no-open、ブラウザは自分で開く）
.\scripts\backlog.ps1 task list --plain         # 公式CLIをdata root固定で実行
node tests\integration.mjs                         # 合成試験（一時rootのみ。結果は results\ に保存）
```

data rootはコードrepoやgitワークスペースの外に置く必要があり、該当すると拒否します。既存configは変更しません。

ローカル版を選んだ比較記録は **[OSS再選定提案：13候補比較、更新経路、受入試験](docs/oss-reselection-20261011.ja.md)** を参照してください。

- 最優先は「AIが更新する → 保存を確認する → 開いた画面へ反映する」の一続きの経路です。人手転記を通常経路にしません。
- Backlog.mdの公式CLI/MCPと標準Web画面を採用しました。Windowsローカル、共通のタスク保存先、1タスク1主担当を想定します。
- 利用者別認証/RBAC、古い入力を拒否するCAS、クラウドAIからの実接続などには制約や未検証点があります。標準機能だけで解決済みとは扱いません。
- 確認済み：ローカル版の合成CLI/MCP/HTTP/WSとheadless Chromeでの実DOM/通信。**標準v1.53.0は切断・server再起動後、継続更新を戻すため明示的ページ再読込が必要です**。health復旧は一度の再取得だけです。上流UI/binaryは改変していません。クラウドAI実接続、自動起動、外部公開は未実施です。
- クラウド版の全URL保護・本人限定、実DB/TLS/競合/永続化、buildと静的出力、AI更新の認証、再送UX、データ移行は未検証または修正待ちです。保護検証が通るまで実タスクを移送しません。公開GitHubに実タスク・秘密・内部記録は保存しません。

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
