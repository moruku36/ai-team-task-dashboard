# AIチームのタスク状況を見渡すためのOSS再選定

確認日：2026年10月11日  
状態：選定時点の参考記録。2026-10-11にBacklog.mdの採用と即実装が承認されました。現行の実装範囲は [Backlog.md MVP構成（最終）](09-backlog-md-architecture.ja.md) を参照。以下の未承認・未実装という記述は提案時点の履歴であり、現状はREADMEと現行構成を優先します。実タスクの取込みと外部公開は後続段階です。

## 結論

**第一候補はBacklog.md v1.53.0。次点はVikunja 2.7.0です。**

- **Backlog.md**：公式CLI/MCPで各AIが同じ保存先を更新し、ファイル監視→WebSocketで標準Web画面が自動反映します。Windowsの単一実行ファイルで動き、MIT、別DBサーバーや表示画面の自作は不要。今回の「AIが更新しやすい」「30件をすぐ見渡す」に最も近い候補です。
- **Vikunja**：利用者別の認証・権限と汎用タスク管理を優先する場合の次点。公式API/MCPとbotがありますが、開きっぱなしの標準画面への反映は確認できず、小さな更新窓口・自動取得表示を補う前提です。
- **Backlog.mdの弱点は、アプリ内の利用者別認証/RBACがないことと、task更新lockが古い入力を拒否するCASではないこと。** ローカルの信頼するAIチームで、1 task 1主担当・共通保存先・公式更新操作という条件から始めます。将来の外部アクセスには認証付きproxy等を別途設計します。

CollatticeとKanbiniにも、API/MCP→live画面という短い経路があります。ただし小規模・新興の保守体制や外部閲覧の制約を考え、今回の推奨2製品より後順位とします。Paperclipは、将来AIの実行管理まで統合したくなった場合の別案です。

**推奨する次の一歩は、承認後にBacklog.mdの標準機能で「AIが更新→保存→開いた画面が変わる」を架空タスクで試すことです。** 最初から独自dashboardを作りません。これは選定提案であり、導入済み・採用確定という意味ではありません。

## 1. 旧案から変えること

旧Kanboard案の大きな問題は、初版を「人がAIの報告を転記する」「複数AI更新は後で考える」としていたことです。今回の最優先事項は、**AIが仕事の節目で状態を更新し、人は一覧を見るだけで進行中・承認待ち・完了を把握できること**です。

新しい必須条件は次のとおりです。

1. 約30件の仕事を横断し、進行中・承認待ち・完了・停止理由を分かりやすく表示する。
2. クラウドAIアシスタント、Claude、Antigravityなどから、初版から機械的に更新できる。人手転記を通常経路にしない。
3. 情報源 → AIの更新経路 → 保存 → 開いた画面への反映を一続きで確認する。
4. Windowsローカルから始め、製品の必須利用料・新しいLLM API料金を追加しない。
5. PHPは使わず、保守状況とライセンスを確認できるOSSを選ぶ。
6. 将来、認証付きで外から見られる形へ移せる。初版では公開しない。

Kanbanは表示方法の一つであり必須ではありません。タスク表、状態別一覧、承認待ちのまとめを優先します。PHPという言語だけを理由に古いと断定せず、Kanboardを未保守と一括りにもしません。今回はPHPを使わず、AI更新を中心とする本設計の要件に合わせて選び直します。

## 2. 広く比較した結果

「標準の自動表示」は、外部APIで更新したタスクが、開きっぱなしの通常画面へ自動反映することを意味します。通知、文書の共同編集、MCPの通信方式とは別です。

| 候補 | AIが更新する入口 | 標準の自動表示・競合 | Windowsと運用 | 今回の位置づけ |
|---|---|---|---|---|
| **Backlog.md** | 公式CLIとstdio MCP。全AIのrootを共通保存先へ固定 | file watch→WebSocketで標準UI更新。task単位lock、ただしCASではない | Windows配布、ファイル保存。DB server/Docker不要 | **第一候補。今回のAI更新とlive表示を最短で試せる** |
| **Vikunja** | 本体内蔵の公式MCP、REST v2、botと操作別token | タスク画面の常時同期は未確認。書込If-Matchを保証できない | Goサーバー＋同梱UI＋SQLite。Linuxバイナリ/コンテナをWSL2等で動かす候補 | **次点。認証・権限に強く、live表示を補う** |
| **Collattice** | 公式REST、内蔵MCP | SSE→画面再取得。カード編集はlast-write-wins | Windows x64単一配布＋SQLite。Docker不要 | 機能適合は高い。小規模体制と権限の検証が必要 |
| Plane Community | 公式MCP、CEのREST v1 | タスク画面の常時同期とCASを確認できない | 公式CE構成は通常12サービス＋移行処理1。依存が多い | 30件の個人用には重く、今回の不足も残る |
| Kan | 公式MCP、REST/tRPC | 外部更新の自動反映・CASを確認できない | Node/Next.js＋PostgreSQL等 | モダンだが、今回Vikunjaを上回る根拠がない |
| Paperclip | 公式REST/MCP、agent checkout | WebSocket＋切断時poll。checkout/run所有権あり | Node＋PostgreSQL、agent管理・起動・予算も含む | **表示基盤だけでなく、実行管理ごと移す場合の別案** |
| OpenProject | 無料REST v3。公式MCPは有料Professional以上 | RESTにlockVersion。MCPにも更新保護 | Linux向け、PostgreSQL等。Windowsは公式サポート外 | 強力だが、今回の軽さ・無料公式MCPに合わない |
| AppFlowy | 現行商用サーバーにAPI/MCP。第三者MCPも複数存在 | 文書/DB共同編集あり | 同期/API用のserver構成が必要 | AGPL serverがarchive。現行self-host無料枠とOSSを混同しない |
| Vibe Kanban | coding agent/workspace中心 | 製品内の実行状態を扱う | coding環境も管理 | 公式sunsetting告知。新規の長期採用から外す |
| Task Master | 公式MCP、CLI、ローカルtasks.json | 共有live dashboardの完成品ではない | Node等。team modeはクラウド側 | ライセンスはMIT＋Commons Clause。通常のMIT OSSとは異なる |
| Kanbini | 公式MCP/REST、Electronの単一writer | ローカル画面へlive反映 | Windows優先、SQLite。アプリprocessに依存 | ローカル専用の有望候補。保守期間・外部アクセスを要確認 |
| Planka | APIあり | 今回は深掘り対象外 | Node/PostgreSQL系 | 現行はfair-code。厳密なOSS条件から外す |
| Focalboard | APIあり | 今回は深掘り対象外 | Windows版あり | standalone公式READMEが未保守を明記 |

主な根拠：[Vikunja](https://vikunja.io/help/mcp/)、[Collattice](https://github.com/MrBildo/collattice)、[Plane公式MCP](https://developers.plane.so/dev-tools/mcp-server)、[Kan](https://github.com/kanbn/kan)、[Paperclip](https://github.com/paperclipai/paperclip)、[OpenProject有料境界](https://www.openproject.org/docs/enterprise-guide/)、[AppFlowyサーバー](https://github.com/AppFlowy-IO/AppFlowy-Cloud)、[Vibe Kanban告知](https://www.vibekanban.com/blog/shutdown)、[Task Master license](https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE)、[Backlog.md](https://github.com/MrLesk/Backlog.md)、[Kanbini](https://github.com/Jigglyy/kanbini)、[Planka license guide](https://github.com/plankanban/planka/blob/master/LICENSES/PLANKA%20License%20Guide%20EN.md)、[Focalboard](https://github.com/mattermost-community/focalboard)。

## 3. 第一候補：Backlog.md

### 3.1 今回の用途に合う理由

Backlog.mdは、人とAIが同じtaskを扱うためのMarkdownベースの管理ツールです。coding taskを計画する用途が中心ですが、agentを起動するorchestratorではありません。v1.53.0にはno-git modeもあり、公式READMEが非codingのPersonal Planningを例示しています。今回のように調査・設計・資料作成を含む仕事の状態を、一つの共有保存先で管理できます。

- **公式CLIとMCPが本体にある**ため、画面操作や独自REST wrapperをまず作る必要がありません。
- **Web画面のlive反映が本体にある**ため、Vikunja/Plane/Kanで不足する常時表示を自作せずに試せます。
- **Windows x64/ARM64のruntime込み.exe、ローカルファイル保存**で、直接.exeを使えばNode/Bun・DB server・Dockerは不要です。npm経由ならNode launcherを使う点は区別します。
- **MITで、task metadataの読み書き・表示にLLM APIは不要**。既存のAIをそのまま使う方向です。
- task dataがMarkdownなので、製品を変える場合も内容を読み出せます。これは別製品のdata schemaへ無変換で移せるという意味ではありません。

[版を固定したREADME](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/README.md)、[license](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/LICENSE)、[配布build](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/.github/workflows/release.yml)

### 3.2 更新から画面まで、確認した実装

**CLI/MCP → taskファイル保存 → file watch → ContentStore → WebSocket通知 → Web画面が再取得**という経路を、v1.53.0のソースで確認しています。別viewerは不要です。WebSocketを持っているだけで判断せず、task更新とUI取得までつながることを確認しました。[server](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/server/index.ts)、[UI](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/App.tsx)

MCPはstdioです。各AIのMCP processが共通保存先を向き、同じtaskファイルを読む構成になります。通常のproject追従動作をそのまま使わず、共通rootを固定する点が今回の要です。[MCP起動](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/commands/mcp.ts)

### 3.3 同時更新の実態

ID採番のlockと、task単位read-modify-writeのlock、lock内の再読込みがあります。短い更新処理の同時衝突にはfail-fastの経路があり、Web APIでは409として扱います。ただし、**期待revisionによる古い入力の拒否や、agentの作業期間全体を占有するcheckoutではありません。** またMarkdown直接編集は協調lockを迂回します。[file操作](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/file-system/operations.ts)、[core更新](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/core/backlog.ts)

この性質から、初版は各taskの主担当を一つにし、すべてのAIが公式CLI/MCPを使う構成を勧めます。同じtaskを全AIが自由に上書きする設計は勧めません。

### 3.4 保守と無料境界

GitHubのlive情報では、repoは2025-06開始、最新公開release **v1.53.0は2026-09-24**、直近commitは2026-10-07です。継続的な開発を確認できます。約16か月の保守実績はありますが、将来の保守保証ではありません。今回必要なCLI/MCP/Web表示について有料enterprise限定機能は確認されていません。[release](https://github.com/MrLesk/Backlog.md/releases/tag/v1.53.0)、[活動](https://github.com/MrLesk/Backlog.md/commits/main/)

### 3.5 受け入れる弱点

アプリ内のuser別認証・task別RBACはありません。初版では利用者のWindows上の信頼するAIチームに限定します。将来の認証付き外部閲覧は追加proxy等が必要で、ここまで含めて完全な「導入だけで終わり」とは言いません。

標準UIはtask詳細にUpdatedを表示し、server切断時に「Server disconnected」とRetryを表示します。一方、全カードの最終観測時刻やagent別の生存状態を常時出す標準機能まではありません。task詳細の共通書式、Windowsでの復帰動作、表示の使い勝手は実機未検証です。必要な項目だけを補い、最初から独自dashboardへ置き換えません。[task詳細](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/components/TaskDetailsModal.tsx)、[切断表示](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/components/HealthIndicator.tsx)

## 4. 次点：Vikunjaで何ができ、何を補うか

### 4.1 確認できた製品機能

- 安定版 **2.7.0は2026-10-02公開**。この版で公式MCPを追加しています。Go＋Vue/TypeScriptで、PHPは不要です。[リリース](https://vikunja.io/changelog/vikunja-2.7.0-was-released/)
- 公式MCPは本体の `/api/v2/mcp`。Streamable HTTP＋Bearer tokenです。タスク、プロジェクト、ラベル、コメントを扱えます。[MCP](https://vikunja.io/help/mcp/)
- REST v2には部分更新、bot user、API tokenの操作別権限があります。botへの共有プロジェクトを絞れるため、個人の管理者tokenを全AIへ渡す必要はありません。[API v2](https://vikunja.io/docs/api-v2/)、[bot users](https://vikunja.io/docs/bot-users/)
- Kanbanのbucket移動とラベル付けもMCPの `find_action` → `do_action` 経由で公開されています。既定のtyped-toolsプリセットだけで全操作が許可されるとは限らず、必要なscopeを個別確認します。[2.7.0公開操作一覧](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/modules/mcp/exposure.go)
- 本体とUIは一体で配布でき、SQLiteなら別のDBサーバーやRedisは必須ではありません。Docker例では本体1コンテナ、PostgreSQLを選ぶ例では計2コンテナです。Windowsデスクトップ版は、それ自体がローカルserverの代わりになるものではありません。[公式導入](https://vikunja.io/docs/installing/)

### 4.2 無料版と有料版の境界

本体はAGPL。Proは管理画面、時間記録、監査ログ等を追加するプランです。今回のAPI、MCP、bot、基本タスク管理のためにProを前提にしません。ProのコードもAGPLと説明されていますが、公式配布で機能を利用する契約とソースライセンスは分けて扱います。[Pro説明](https://vikunja.io/pro/)

無料版のコメントや履歴を、改ざん耐性のある監査証跡と呼びません。必要な更新履歴は補助窓口側でも残しますが、それも第三者監査レベルの不変ログとは区別します。

### 4.3 見落とすと失敗する二つの点

**A. APIに書けることと、画面が勝手に更新されることは別です。**

2.7.0のWebSocket購読で確認できたのは通知とtimer系です。タスク更新・bucket移動を標準boardへ継続同期する実装や、利用者が設定できる定期refreshは確認できません。queryのstaleTimeはpolling周期ではありません。[serverEvents.ts](https://github.com/go-vikunja/vikunja/blob/v2.7.0/frontend/src/client/queries/serverEvents.ts)、[queryClient.ts](https://github.com/go-vikunja/vikunja/blob/v2.7.0/frontend/src/client/queryClient.ts)

**B. docsのETag/If-Match表現だけで、複数AIの上書き防止を保証できません。**

2.7.0固定タグでは、タスク更新処理に条件付きヘッダー入力がなく、PATCHもGET→PUTを介します。MCP schema生成もheaderを入力から除外します。未解決の報告とも整合するため、同一タスクの競合を標準機能任せにしません。[tasks.go](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/routes/api/v2/tasks.go)、[spec.go](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/modules/mcp/spec.go)、[Issue #3392](https://github.com/go-vikunja/vikunja/issues/3392)

これは実機で競合を再現した結果ではなく、版を固定したソース確認に基づく評価です。採用前に同時書込試験を行います。

### 4.4 最小の追加部分

独自タスク管理製品を一から作る代わりに、Vikunjaの外側へ**一つの小さなローカル補助サービス**を置く案です。

1. **AI更新窓口**：各AIからの構造化更新を受け、形式・対象task・更新者・重複・新旧を確認して、順番にVikunjaへ書く。
2. **read-only状況表示**：約30件だけを一覧表示。初期案は5秒ごとの取得、失敗時の接続表示、最終成功時刻、状態別件数を持つ。これは製品標準機能ではなく追加開発です。

この二つを同じ補助サービスにまとめ、別DB server、メッセージキュー、外部AI API、複雑なagent実行基盤を増やさない方針です。実装言語・配布方式は、Windowsにある実行環境を確認して決めます。

Vikunjaの標準UIは検索・詳細・管理に使います。常時見る画面は補助表示を使い、更新のたびにブラウザ全体を再読み込みする方法にはしません。もし標準UIに目的どおりの同期が実機で確認できれば、追加表示は省略できます。

**費用ゼロと開発ゼロは違います。** この案は新しいSaaS契約やモデル課金を必須にしませんが、補助サービスの作成・試験・保守は必要です。この追加開発を避け、標準live画面から試せることが、Backlog.mdを第一候補とした大きな理由です。

## 5. Collattice：live表示は標準、保守体制と権限は慎重に

### 製品標準で今回に近い部分

- MIT。C#/.NET＋React＋SQLite。Windows x64の自己完結型配布があり、実行時のDocker・別DB server・別.NET導入は不要と説明されています。[導入](https://github.com/MrBildo/collattice/blob/main/docs/installation.md)
- 公式RESTと公式MCPを同梱。カード作成・更新・移動・コメントを扱えます。
- 更新は保存後にSSEの `board-updated` を送信し、ブラウザがdebounceしてデータを再取得します。AI更新 → 開いた画面への反映という経路が、実装として確認できます。[画面更新実装](https://github.com/MrBildo/collattice/blob/main/frontend/src/hooks/use-board-events.ts)
- 進行中・承認待ち・完了はレーンで表現可能。表示専用に使うための追加LLM呼出しは不要です。
- GitHubのrelease APIで **v3.2.3、2026-10-01公開**を確認。repo作成は2026-03-13、直近commitも2026-10-01です。[release](https://github.com/MrBildo/collattice/releases/tag/v3.2.3)

### 採用前に解消したい点

- 小規模な開発体制です。活動があることは確認できますが、大きな利用者層や長期サポートの実績まで確認できたわけではありません。
- RESTは `X-User-Key`、MCPはtool引数に `authKey` を渡す構成です。鍵がモデル文脈や実行ログへ混ざる範囲を増やさないため、今回は資格情報を内部注入するREST更新窓口を優先する設計が安全です。[agent仕様](https://github.com/MrBildo/collattice/blob/main/docs/collattice/SKILL.md)
- AgentUserという名前だけで「自分のカード以外は書けない」と解釈できません。現仕様・実装では通常カードを他のactive userも更新できます。[CardTools.cs](https://github.com/MrBildo/collattice/blob/main/backend/Collabot.Collattice.Api/Mcp/CardTools.cs)
- 同時編集はlast-write-winsです。`expectedDescriptionRevision` は上書きを止めるCASではなく、衝突を事後通知する仕組みです。状態遷移の排他を保証するものでもありません。[API collision awareness](https://github.com/MrBildo/collattice/blob/main/docs/api-reference.md#collision-awareness)
- 「承認待ちレーン」は表示であり、利用者だけが承認できる実行権限の仕組みではありません。
- ローカル初期構成ではloopbackに限定します。既定の全interface待受を、そのまま外部公開してよいとは判断しません。

したがって、Collatticeならlive表示を自作せずに済む見込みがありますが、対象task制限・重複防止・衝突回避の更新窓口は依然有用です。SSE切断・復帰、複数writer、Windows常駐化は未試験です。

## 6. Plane、Paperclipなどを第一候補にしない理由

### Plane Community

AGPL-3.0-only。安定版1.4.2は2026-08-23、1.4.3-rc1は2026-10-06で、保守停止ではありません。ただしCommercial FreeとOSS Communityは別です。[releases](https://github.com/makeplane/plane/releases)、[edition](https://developers.plane.so/self-hosting/editions-and-versions)

公式MCPはMITでself-hostへ接続できますが、CEではstdioが現実的な入口です。一般の最新API docsをそのままCEへ当てはめず、CE1.4.2は `/api/v1` に合わせます。API keyは所有者userとして動き、操作別scopeは確認できません。MCPの全機能がCEで動くとも扱いません。[MCP](https://developers.plane.so/dev-tools/mcp-server)、[CE認証](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/middleware/api_authentication.py)

標準のliveサービスはPages共同編集用で、タスクboardの自動同期を意味しません。画面の周期再取得と書込CASも確認できず、Vikunjaと同じ追加部分が残ります。一方、公式構成はweb、space、admin、live、API、worker、beat-worker、PostgreSQL、Valkey、RabbitMQ、MinIO、proxyとmigratorです。30件の表示には運用対象が多すぎます。[CE Compose](https://github.com/makeplane/plane/blob/v1.4.2/deployments/cli/community/docker-compose.yml)、[SWR設定](https://github.com/makeplane/plane/blob/v1.4.2/packages/constants/src/swr.ts)

### Kan

AGPLv3。公式MCPはv0.6.0（2026-06-29、pre-release）へ収録済みです。ローカルMCPは利用可能で、hosted MCPはKan Cloud有料planの境界があります。ただしv0.6.0と現mainでは、board queryに周期再取得がなく、外部更新のpushを確認できません。カード更新も期待version条件を持たず、列移動のtransactionは古い入力を拒否するCASではありません。API keyはuser identityを使うため、専用user等で権限を分ける設計が必要です。[release](https://github.com/kanbn/kan/releases/tag/v0.6.0)、[公式MCP docs](https://github.com/kanbn/kan/blob/main/apps/docs/integrations/mcp-server.mdx)、[board query](https://github.com/kanbn/kan/blob/v0.6.0/apps/web/src/views/board/index.tsx)、[DB更新](https://github.com/kanbn/kan/blob/v0.6.0/packages/db/src/repository/card.repo.ts)

### Kanbini

MIT、Windows installerと同梱MCP、SQLite、live表示があり、ローカル導入は軽い候補です。初releaseは2026-05-31、最新v0.10.1は2026-10-10。約5か月の小規模な新興projectです。単一Electron writerはDB整合性を守りますが、古いstatusを拒むCASはなく、同じfieldは後の更新が勝ちます。また画面はElectronで、Backlog.mdのWeb UIのように将来そのままproxyする経路がありません。最後のwindowを閉じるとWindowsでは終了する実装も、常駐運用上の違いです。[初release](https://github.com/Jigglyy/kanbini/releases/tag/v0.1.0)、[最新release](https://github.com/Jigglyy/kanbini/releases/tag/v0.10.1)、[MCP設計](https://github.com/Jigglyy/kanbini/blob/main/docs/MCP.md)、[writer](https://github.com/Jigglyy/kanbini/blob/v0.10.1/packages/db/src/crud.ts)、[main process](https://github.com/Jigglyy/kanbini/blob/v0.10.1/apps/desktop/src/main/index.ts)

### Paperclip

MITで、AI向けのREST/MCP、原子的checkout、run所有権、review/approval、WebSocketと切断時pollを備え、agent-nativeという点では強い候補です。2026-10-06公開のv2026.1005.0、10月11日のcommitも確認でき、開発は活発です。[repo](https://github.com/paperclipai/paperclip)、[公式MCP](https://github.com/paperclipai/paperclip/blob/master/packages/mcp-server/README.md)、[Issues API](https://docs.paperclip.ing/reference/api/issues/)、[live回復仕様](https://github.com/paperclipai/paperclip/blob/master/doc/DEVELOPING.md)

ただし、これはcoding専用ではない一方、**AIチームの実行・組織・予算・承認まで管理する基盤**です。既存の各AIを表示するだけの箱とは違います。issue更新でwakeが発生し得ること、checkout後の更新がrun IDと結び付くこと、agent起動時の実行policyを扱うことに注意が必要です。Windows対応もありますが、Nodeやprovider CLI等の構成を持ちます。[Windows対応](https://github.com/paperclipai/paperclip/releases/tag/v2026.722.0)、[deployment modes](https://docs.paperclip.ing/reference/deploy/deployment-modes/)

将来「仕事を眺めるだけでなく、この管理画面からAIへ割当・起動・再実行したい」に要件が変われば再評価します。表示の依頼から実行制御基盤の導入へ、勝手に範囲を広げません。本体無償でも、agent実行のモデル費用は別です。

### AppFlowy、OpenProject、保守・ライセンスで落とした候補

- **AppFlowy**：desktop側のAGPLと、同期/APIを担うserver側を分けて評価します。AGPLのAppFlowy-Cloudは2026-09-11にarchiveされ、現行serverはclosed-source commercial forkの公式imageへ移行しています。self-host無料枠はありますが、「活発に保守されるOSS server」という条件の代わりにはなりません。[公式archive説明](https://github.com/AppFlowy-IO/AppFlowy-Cloud)、[現行self-host](https://github.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial)
- **OpenProject**：17.9.1は2026-10-01で活発です。無料REST v3のlockVersionは評価できますが、公式MCPはProfessional以上のEnterprise add-on。最低要件は4GB RAM/20GB disk、Windowsは公式サポート外です。[release](https://www.openproject.org/docs/release-notes/)、[API](https://www.openproject.org/docs/api/endpoints/work-packages/)、[MCP有料境界](https://www.openproject.org/docs/enterprise-guide/)、[system requirements](https://www.openproject.org/docs/installation-and-operations/system-requirements/)
- **Vibe Kanban**：2026-04-10の公式告知で運営終了・communityへの移行を説明しています。直近commitの有無だけで、以前と同じ保守体制と見なしません。[公式告知](https://www.vibekanban.com/blog/shutdown)
- **Planka**：現行は用途制限を含むfair-code licenseです。無料利用可能な範囲があっても、通常のOSSと同じ条件とは扱いません。[license guide](https://github.com/plankanban/planka/blob/master/LICENSES/PLANKA%20License%20Guide%20EN.md)
- **Focalboard standalone**：公式READMEが現在未保守と明記します。Mattermost pluginの状況とは分けます。[公式repo](https://github.com/mattermost-community/focalboard)

## 7. Backlog.md：情報源から画面までの具体的な接続案

以下のAIクライアント名は接続方式の構成例です。特定の利用者の利用状況や接続設定を表すものではありません。

### 初版の共通構成

```text
Claude Code / Antigravity（Windows上）
  └─ 作業開始・承認依頼・停止・検証・完了の構造化更新
       └─ Backlog.md公式MCP/CLI（共通rootを明示）

クラウドAIアシスタント（cloud側）
  └─ 許可されたWindows作業タスクへ短い更新内容を渡す
       └─ Windows内のBacklog.md CLI（同じ共通root）

Backlog.md公式更新操作
  └─ task単位lock・lock内再読込み → ローカルtaskファイル
       └─ file watch → WebSocket → 標準Web画面が再取得
```

外部APIやチャットの全履歴を勝手に吸い上げる方式ではありません。各AIの作業手順に、仕事の節目で状態を報告する操作を組み込みます。標準のlive画面は、この報告が保存された後の表示を担当します。

### すべてのAIを同じrootへ向ける

Backlog.mdは通常、MCP clientのworkspace/rootに追従します。それぞれのcoding repoで初期化するだけでは、30件を横断する一つのboardになりません。今回の設計では**タスクdata用の共通保存先を一つに固定**します。

- 各MCPへ `BACKLOG_CWD` または `backlog mcp start --cwd <共通保存先>` を設定する。
- CLIも必ず同じ保存先で呼び出す。
- 公開する設計・コードrepoと、実task dataの保存先を分ける。data側に公開remoteを設定しない。
- **v1.53.0に収録されたno-git modeを使う**。初期化はcheckActiveBranches、remoteOperations、autoCommitをfalseに固定するため、branchやremoteの差異を持ち込まない。
- 各AIが別folderへコピーして別々の正本を作らない。

[公式MCP起動仕様](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/commands/mcp.ts)、[no-git初期化](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/core/init.ts)

### 接続できることを混同しない

| 更新元 | 初版で想定する経路 | 未検証の部分 |
|---|---|---|
| Claude CodeをWindows上で実行 | ローカルstdio MCPまたは公式CLI | 対象PCでの接続、task更新、共通rootの固定 |
| AntigravityをWindows上で実行 | ローカルstdio MCPまたは公式CLI | 採用版の設定互換性、同じrootへの更新 |
| クラウドAIアシスタント | 明示的に接続を許可したWindowsの作業経路→公式CLI | 更新遅延、中断時の回復、常設同期ではないこと |
| cloud側の別AI | 許可されたローカル実行経路を介する | localhost/stdioへ直接到達するとは言えない |

Antigravityはstdio MCPを含む設定を公式に説明しています。これは方式上の根拠であり、今回の実機試験済みという意味ではありません。[Antigravity MCP](https://antigravity.google/docs/mcp)

Backlog.mdのstdio MCPは、cloud側のdotが直接接続するremote MCPではありません。dotはWindows上の作業経路を使います。次点Vikunjaについても、公式文書はChatGPT developer modeのBearer非対応、Claude Desktop/claude.aiのheader beta制約と到達性を明記しています。**MCP搭載＝このdotが即座に直接更新できる、ではありません。** [Vikunja client別説明](https://vikunja.io/help/mcp/)

### タスク情報の入れ方

- 最初に共通task IDを採番し、以後はIDで更新します。会話タイトルの一致で同一taskと判定しません。
- 各AIの手順に「開始・承認待ち・停止・検証結果・完了時に更新」を含めます。hookを使う場合も、process終了を仕事の成功へ機械的に変換しません。
- dotは受け取った作業結果や明示された待ち状態を更新します。全AIの内部状態・全会話を自動取得できるAPIの存在は前提にしません。
- 接続していないAI、更新手順を通していない会話は、自動追跡の対象外と分かるようにします。
- 新しいLLMの常時要約を挟まず、既存AIが短いtask metadataを送ります。

## 8. 表示とデータの最小設計

### 最初は標準画面を使う

標準boardに「次にやる」「進行中」「承認待ち」「停止・依存待ち」「検証中」「完了」を設定する案です。Kanban以外の独自dashboardを最初から作ることはしません。30件で、状態・担当・短い名前を見渡し、詳細から次の一手と証跡へ入れるか確認します。

最終確認時刻、待ち理由、根拠の種類は、まずtask詳細の短い共通書式へ保存します。これらを標準カードへ常時表示できるとは約束しません。標準UIにはserver切断表示と自動再接続がありますが、agentの最終報告や全体の最終同期時刻を常時一覧表示する機能は別です。その常時表示が必要な場合だけ小さく補います。

### 時刻と接続状態を分ける

- `observed_at`：仕事の状態を根拠から確認した時刻。
- `reported_at`：AIが状態を報告した時刻。
- 保存時刻：Backlog.mdのtask更新時刻。
- 画面接続状態/最終取得成功時刻：boardがdataを取得できているか。

画面取得が成功していても、AIからの報告が古ければ仕事は「最新確認済み」ではありません。**仕事の状態と、接続・観測の状態は別**です。通信断を仕事の失敗や完了へ変換しません。

根拠は「成果物/実行結果を確認」「担当AIの報告」「推定」「未確認」を区別します。推定は推定と表示し、完了の根拠にしません。単に一定時間が過ぎたから「作業していない」とも断定しません。

### metadataに限定する

保存対象はtask ID、短い要約、担当、状態、次の一手、待ち理由、時刻、検証段階、証跡リンクです。秘密鍵・token・パスワード・会話全文・詳細な私的ログ・承認原文は載せません。URLへaccess tokenを埋め込まず、証跡の元のアクセス権も変えません。

Backlog.mdのassignee、label、description、references、notes等の既存項目へ収めます。独自のfrontmatterを任意に追加すると全UI/MCPで保存される、と仮定しません。データ形式は選定版で実際に往復確認します。[task型](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/types/index.ts)

### 「リアルタイム」の受入目標

標準のhealth接続は切断後5秒で再接続を試み、復旧時はdataを再取得します。これはserver接続の検知であり、各AIが動いているかの監視ではありません。[再接続実装](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/hooks/useHealthCheck.tsx)

初期案は、**task保存を確認してから画面反映まで10秒以内**です。Backlog.mdではWebSocketによる標準更新を使い、polling画面の自作を必須にしません。数値は設計目標で、実測済み性能ではありません。

AIが出来事を報告するまでの時間と、dotからWindowsへの委譲時間は別です。「現実の作業開始から必ず10秒以内」とは約束せず、入力遅延と画面遅延を分けて計測します。

## 9. 同時AI更新、権限、承認

### 標準lockが守ること・守らないこと

Backlog.mdのtask単位lockとlock内の再読込みは、同時read-modify-writeによる破損や取りこぼしを減らす仕組みです。競合時にはfail-fast/409となる経路があります。しかし、数分前の状況を見たAIが後から古いstatusを送ることは、短いfile lockだけでは防げません。長時間の仕事のcheckoutでもありません。

初版では次の運用にします。

1. **1 task 1主担当**。主担当だけがstatusを更新し、別AIのreviewは子taskや報告として渡す。
2. 共通dataは公式CLI/MCP/Web操作で更新し、Markdown直接編集でlockを迂回しない。
3. 更新直前にtaskを読み、対象ID、担当、現在statusを確認する。衝突時は再取得して意味を確かめ、無条件retryしない。
4. 応答が不明なら保存済みか照合する。task作成やcommentをblind retryして重複させない。
5. 同じstatusの再送と、同じcommentの重複追加を区別する。重要な更新にevent IDを残す案は、既存notes等で往復できることを確認して採用する。
6. 人が主担当やstatusを変更する場合は、そのtaskのAIへ変更を伝える。AIは自分がまだ主担当か再確認する。

**これは利用者別RBACや期待versionの強制ではありません。** 二つのAIが同じtaskを自由に編集し、古い更新を必ず拒否することまで必須なら、Backlog.md単体では不足です。その場合は全更新経路を一つの窓口へ集約してrevision/所有者検証を足すか、実行管理まで含む別製品を再評価します。窓口の外から直接編集できるまま「競合を完全防止」とは宣言しません。

### 権限境界

Backlog.mdはOS上の利用者・ローカルprocessへの信頼を前提にし、アプリ内の利用者別認証やtask別permissionを提供するserverではありません。stdio MCPも、接続したローカルclientのfilesystem権限で動きます。削除・全体設定など不要な操作はclient側で使わせない手順にしますが、それをserver側の強い権限制御とは呼びません。

初期用途は利用者のWindowsと信頼するAIチームです。複数人の権限分離や、外部AIへの限定tokenが初版から必要なら、Vikunjaの方を優先する条件変更になります。

### 承認待ちの扱い

「承認待ち」は元の会話で利用者の判断が必要という記録です。taskを別の列へ動かすことやAIがapprovedと書くことを、購入・公開・マージ・実行許可にしません。承認後の実作業は元の対象と範囲を確認して行います。今回のboardに実行ボタンは作りません。

## 10. Windows、費用、将来の外部アクセス

### ローカル初版

Backlog.mdのWindows x64/ARM64 standalone.exeを使い、no-gitの共通data folderとWeb画面processを持つ案です。直接.exeを使えばNode/Bun、DB server、Docker、Redisは不要です。CPUに合う配布を確認して選びます。npm経路を選ぶ場合だけNode依存があります。[公式release](https://github.com/MrLesk/Backlog.md/releases/tag/v1.53.0)

GUIがロックされていても、Web画面serverと呼出し側processが動いていればCLI/API更新できる構成を目指します。ロック・sleep・logout・再起動は別です。sleep中や電源offで更新できるとは扱いません。自動起動・sleep復帰・ファイルbackup/restoreを試験します。

「追加費用なし」は製品の必須利用料と新規必須API費用を追加しない方針です。既存AI契約、電力、端末、通信は別です。Backlog.mdは新しいLLM接続を必須にしません。

### 外部アクセスは別の段階

Backlog.md v1.53.0のbrowser serverは、無認証のread/write APIをLANへ出さないため127.0.0.1へ固定されています。**port開放でそのまま公開してはいけません。** [公式の制限理由](https://github.com/MrLesk/Backlog.md/blob/main/backlog/completed/back-560%20-%20Bind-the-browser-server-to-loopback-only.md)

将来の候補は、同じhostの認証付きreverse proxyがHTTPとWebSocketを中継する構成です。これは技術的な推論で、Backlog.md標準のremote利用機能や実証済み構成ではありません。VPNだけを付けてもloopbackに直接届くわけではありません。

また、ログインを付けるだけでは、既存Web UIを閲覧専用にできません。外部から読むだけにするなら、書込endpointを許可しないproxy設計やread-only表示を別途検証します。外部AIにも直接書込させる場合は、user別・task別の権限を改めて設計します。その要求が強ければVikunjaへ移行する合理性があります。

Windows停止中も最新状態が必要なら、正本を常時稼働hostへ移します。二つの書込正本や無検証の双方向file syncは作りません。host、backup、認証サービスの費用・無料条件はその時点で確認し、無条件の月額0円は保証しません。

公開repoに設計・コードを置くことと、task dataを公開することは別です。実data、秘密、private証跡をrepoへ含めません。

## 11. 採用を確定するための試験

承認後の試験案です。今回、製品のインストールや接続試験は行っていません。

| 試験 | 合格条件 |
|---|---|
| 架空30件の表示 | 進行中・承認待ち・完了、担当、次の一手を確認できる |
| 共通root | すべてのAIが同じtaskを読み、別boardへ分裂しない |
| Claude/Antigravityから更新 | 人手転記なしで作成・状態変更し、再読込みで一致 |
| dotから更新 | Windows作業経路から同じtaskを更新し、画面と一致 |
| 開いた画面への反映 | 手動refreshなし。保存から表示まで10秒以内を測定 |
| 同時更新 | 別taskの並列更新で破損せず、同taskへのlock取得競合ではエラーを識別して再読込みできる。時間差の古い入力は次項で別試験 |
| 古い入力 | lockだけでは防げないことを試験で示し、主担当運用が守られるか確認 |
| 不明応答/retry | task作成やcommentをblind retryせず、既存結果を照合 |
| 接続切断・復帰 | 最新確認できないことが見え、復帰後の取りこぼしを再取得 |
| 時刻・根拠 | observed_atと保存時刻を混同せず、推定/未確認を識別 |
| 承認待ち | 表示変更を実作業の承認へ変換しない |
| ローカル限定 | LANの別端末から無認証でread/writeできない |
| Windows運用 | ロック中更新、再起動後起動、sleep復帰、backup/restoreを確認 |
| 移行 | task metadataと証跡を取り出し、別folder/hostで復元できる |

**最初に通すのは画面の見た目ではなく、「AIが更新→保存を確認→画面が変わる」の1往復です。** そこに失敗した製品を、導入済みという理由で採用しません。古い入力の厳密な拒否やtask別強制権限まで必要なら、その時点で補完部分の規模を見積もり、標準機能だけで十分と扱わない判断をします。

## 12. 次の設計改訂

撤回したKanboard選定は採用済みとして引き継ぎません。再選定案の確認後、次の点をまとめて直す対象とします。

- 要件：初版のAI更新・自動表示を必須へ。
- 構成：Backlog.mdの共通root、Windows内の更新経路、cloud側dotの経路を分離。
- 選定理由：MCP、画面反映、競合、保守、licenseの確認結果へ置換。
- data契約：安定ID、観測/報告/保存時刻、根拠、接続状態。
- 運用：1 task 1主担当、公式操作への統一、利用者承認との分離。
- 受入条件：手動転記や手動refreshでは合格にしない。
- 将来：外部認証・read-only公開・常時hostは独立した設計段階へ。

本書は再選定提案として保存したものです。旧設計各章の全面改訂、および製品の採用・導入は未実施です。
