# Web版タスク更新手順（2026-10-14）

言語：[English](17-web-task-operations.md) | **日本語**

Webアプリ／Neonのドキュメントを唯一のタスク正本とします。終了したローカルMarkdownとローカルUIは更新も同期もしません。既存の状態、クォータのスナップショット、移行アーカイブはそのまま残します。

## 既存の権限だけを使い、新しい恒久アクセスは作らない

通常のUI／API認可は本人のセッションです。そのブラウザセッションにアクセスできないアシスタントは、**すでに接続済みで認可されたVercelデプロイ操作者**が、同じ本番プロジェクトで`cloud/run-task-operator-job.mjs`を1回限りのbuild commandとして明示的に実行できます。既存のDATABASE_URLはVercel内にとどまり、APIキー、新しいOAuth許可、サービスアカウント、常駐MCP登録、認証の迂回は一切導入しません。これは細く絞ったAPIトークンではなく管理的なデプロイ操作であり、既存プロジェクトのデプロイ権限と、タスク変更の明示的な承認が必要です。通常のbuildが操作ジョブのモジュールを読み込む・実行することはありません。

各ジョブは、レビュー済みの実行コードと、Git管理外の非公開`task-operator-request.json`を1つだけ含めます。静的なbuild出力はindex.html、app.js、style.css、favicon.pngのみです。非公開のジョブコードは保護されたVercel deploymentに残る場合があるため、ソースの公開アクセスを有効にしたり、公開出力へタスク内容を置いたりしてはいけません。ログに出すのは段階と結果の汎用メタデータ（ID、版、状態、digest）だけで、タスク本文や認証情報は出しません。

## 操作手順

1. レビュー済みの正確なcommitを取得し、対象のteam／projectと本番ターゲットを確認します。リクエストと受領記録はGitに入れず、非公開の作業場所に置きます。`scripts/Export-WebOperatorDeployment.mjs --commit <sha> --job-request <非公開パス> --output <非公開出力先>`を使うと、そのdeploymentのvercel.json（API projectSettingsより優先）のコピーだけでbuildCommandを変更します。通常のdeployでは`--job-request`を省略します。
2. 既存の認証済みVercel connectorで`inspect`ジョブを実行します。タスクID、完全一致のタイトル、または指定されたHTTPSの参照URLで照合します。inspectは一致したID・版・状態だけを報告します。複数一致した場合は人かエージェントが確認し、重複を作らないでください。
3. `expectedVersion`にinspectで得た版を設定し（一致なしの場合のみ0）、`apply`ジョブを実行します。1回で最大10操作、DB transactionは原子的で、CASと一意で安定したrequest IDを使います。既存の詳細は保持され、更新メモが追記されます。ほかのドキュメント項目には触れません。
4. buildイベント`DASHBOARD_OPERATOR_PROOF`で、確定した版、タスクdigest、読戻し成功を確認します。結果が不明なら再試行の前にinspectします。再試行は同じ論理操作を、まったく同じリクエストとIDで行い、不確かな応答を回避するために別のIDを作ってはいけません。ジョブが確定した後にbuildやaliasが失敗しても、書込みは確定しています。
5. 同じcommitから、非公開リクエストも操作モジュールも含まないデプロイソースで、通常の`node cloud/build-deployment.mjs`による本番deploymentへ戻します。READY、alias、保護状態を確認します。ブラウザは30秒以内、またはRefreshでNeonを再取得します。

旧状態（`Verifying`、`Awaiting Approval`）で保存されたカードの制約：ジョブは明示的な状態選択ができません。表示中の状態を保つ更新では保存済みの旧状態がそのまま残り、ジョブ結果に`storedLegacyStatus`と`statusPersisted: false`が付きます（inspectは常に実際に保存された状態を報告します）。4状態のいずれかを選べばそれが保存され、旧状態の値を書き込むことはできません。

実行時と同じ確立済みのproject／環境を使います。ジョブは保存先へアクセスする前に、既存のNeon projectの印と設定済みの本人を確認し、スキーマ初期化や旧状態の一括移行は行いません。この経路ではバッチごとにbuild待ちとデプロイ操作が発生します。認可されたアシスタント向けの実用的な経路であり、自動的な常駐同期でも、公開された書込みエンドポイントでもありません。

Webアプリは本人のPCなしで動きます。クラウドconnectorは、公開ソースと非公開リクエストがあればWindowsなしでジョブを実行できます。Windows側で実行する場合、PCの接続が必要なのはローカルツールの準備・実行のときだけで、新しい認証情報はPCに保存しません。Vercel connectorが使えない場合や新しいアクセスが必要な場合は、停止し、対象範囲と保存先を明示して先に承認を求めてください。

## 合成リクエストの例

```json
{"mode":"inspect","batch":{"version":1,"operations":[{"requestId":"synthetic_review_001","matchUrl":"https://example.invalid/apply","expectedVersion":0,"task":{"id":"SYNTH-APP","title":"Synthetic application","status":"Blocked","owner":"synthetic-owner","group":"現行","detail":"https://example.invalid/apply\nReply pending; exact send time unknown","lastConfirmedAt":null}}]}}
```

`mode`を`apply`に変えるのは、対象をinspectして正しい期待版を設定した後だけです。応募への返信待ちは、外部待ちの注記付きでBlockedにします。Awaiting Approvalはタスクの承認用に限ります。ユーザーが伝えた応募日は、正確な送信時刻でも受理結果でもありません。

## リセット表示

コンパクトなサマリには、保存済みの観測にあるウィンドウについて、5時間枠と週枠を別々に表示します。日時はAsia/Tokyo（JST、UTC+09:00）です。鮮度があり検証済みの未来のリセットにはカウントダウンを付けます。古いスナップショットは過去の参考日時、期限切れのリセットは更新待ち、欠落・不正な値は不明のままです。リセットは利用枠の更新を意味し、残量がゼロになることではありません。古い単一の時刻から繰り返しは推測しません。この表示変更で収集器や新しい認証情報は開始しません。

既存のサニタイズ済みクォータDTOが、ウィンドウごとの`reset_at`、`fresh_until`、観測・収集時刻、リセットの有効性を供給します。出典：[Codexのプラン利用量](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)、[Google Antigravity FAQ](https://antigravity.google/docs/faq)、保存済みのプロバイダ観測。スナップショット中のClaude取得失敗は過去の行だけを提供するため、現在のClaudeのリセットは主張しません。
