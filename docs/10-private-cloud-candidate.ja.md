# 非公開クラウド候補の修正状況

2026-10-12。`feat/private-cloud-dashboard` の合成実装候補。方針は [mainへマージ済みの全体設計](https://github.com/moruku36/ai-team-task-dashboard/blob/main/docs/12-cloud-architecture.ja.md) に従う。現在のローカルBacklog.md環境には触れない。実DB・Vercel配置・資格情報設定・実タスク移送は未実施。

## 認証を変更した範囲

Basic認証と専用パスワード環境変数を削除した。Vercel Authentication＋All Deploymentsを入口とする方針で、呼出側のAuthorizationや`x-vercel-*`自己申告、環境変数フラグから認証を許可するコードはない。

2026-09-09の[公式発表](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan)で、Vercel Authenticationは本番を含む全デプロイに全プラン追加料金なしで適用できる。Hobbyでは本番保護に有料add-onが必須という旧条件は使わない。実プロジェクトの保護設定変更は別の具体承認を得てから行う。

Windows npm TLSに依存しない正規の候補は[Vercelのソースビルド](https://vercel.com/docs/builds/configure-a-build)。ただしroot `api` の依存installは言語別で、project Install Command overrideが効くとは仮定しない。静的コピーと合成試験は外部依存なしで実行できるが、実PostgreSQL接続には `pg` と全依存の通常導入・lockfileが必要。Windowsでの依存取得成功、実Vercel build、実DB疎通は未確認のまま。

業務handlerから独自の `verifyProtection` を除去した。本番入口は `connectStore()` で取得したstoreを通常handlerへ渡す。DB URL／正しいHTTPS originの欠落、接続失敗は503。環境変数や自己申告ヘッダーで「認証を検証済み」と扱う判定はない。ローカル起動は127.0.0.1・空の合成メモリstoreだけで、DATABASE_URLを参照して本番DBへ自動接続しない。

Vercel Authenticationはアプリの外側の認証境界。deploy時にcontrol planeの `ssoProtection.deploymentType=all`、本人以外の権限／共有／例外／bypass／Trusted Sourcesなしを確認し、全URL・資産・API・直接Function・POSTを未認証で拒否試験する。この試験はまだ実施していない。保護を無効化すると静的画面と業務APIが露出し得るため、アプリの自動閉鎖保証はしない。設定欠落503やOrigin検証は本人認証の代わりではない。

合成試験で注入するのはstore／DB接続factoryだけで、「検証済み」を返す模擬認証関数はない。POSTはOrigin必須・完全一致、JSONと専用headerを要求する。OriginのないCLI更新は現在拒否する。Originは本人認証ではなくブラウザー更新の補助制限であり、正しいOriginを送るCLIも外側認証を必ず通す必要がある。

AI用CLIの旧Basic経路も削除し、未設定エラーで閉じた。Vercel認証済みの委譲経路は次段階で決める。cookieコピー、bypass token、永続MCP登録はしない。

## 静的出力

`vercel.json` で `buildCommand: node cloud/build.mjs`、`outputDirectory: dist/public` を明示した。buildは許可した `index.html`／`app.js`／`style.css` だけをコピーする。既存出力に別ファイルがあれば失敗し、出力やassetファイルのリンク／非ファイルも拒否する。`dist/` はgitignore。repo root、設計文書、テスト、秘密ファイルはコピーしない。

catch-all rewriteを廃止し、`/api/tasks` だけをFunctionへrewriteする。filesystem優先の静的配信はVercelのAll Deploymentsで保護する必要があり、アプリのAPI閉鎖だけでは静的画面の保護を保証しない。全URL・資産・APIの未認証拒否と、実buildの出力・Function配置は未検証。ローカルのassetコピー成功をVercel build成功とは扱わない。

## 再送とUI

未確認の更新要求をタスクIDごとのMapに保持する。カード再表示・検索／一覧再描画・他タスクの操作で消さず、同じ要求ID・期待版番号・本文を再送する。結果未確認のカードには印を付け、再送中の状態変更をロックする。成功応答のID／版を照合するまで削除しない。409は自動的に新IDへ変換せず、最新カードの再確認を求める。

GET／POSTは15秒のtimeout、同一originの資格情報、認証redirectを自動追跡しない設定。実ブラウザーでのログイン・redirect挙動は未検証。Mapはメモリ内のみで、ページ全体のreload／タブ終了／ブラウザー中断後には保持されない。今回修正した保証はカード再表示と再描画の範囲であり、完全なブラウザー再起動復旧ではない。

## 合成検証の区分

`node --test cloud/tests/*.test.mjs` は依存取得不要。実タスクを読まない。

| 試験 | 区分 |
|---|---|
| 状態遷移・同ID再送・古い版・並列片方409・再起動 | loopback実HTTP＋test専用file保存／Promise直列化。実Postgresではない |
| 書込み失敗503・非秘密応答・同ID再試行一度だけ反映、読取失敗 | loopback実HTTP＋失敗する模擬store |
| 20,000バイト可／20,001拒否、JSON／header／origin／文字数／主担当／項目の境界 | loopback実HTTP＋模擬store |
| store／origin欠落、偽ヘッダー／envフラグでも設定欠落503 | loopback実HTTP。本物の認証試験ではない |
| 通常の本番入口配線、設定欠落・接続失敗503、接続再試行 | loopback実HTTP＋模擬DB接続factory。実Vercel／DBではない |
| ローカル起動のloopback bind・合成データだけ・再起動で空 | loopback実HTTP＋合成メモリstore |
| 同一client、commit／rollback、commit失敗 | 模擬Postgres client。実DB／commit後永続化ではない |
| 解析済みbody・rewrite・1バイトごとに分割したUTF-8・解析済み本文上限 | 模擬request／response |
| 1000タスク上限、1000要求／監査保持、保持範囲外の古い再送 | model＋模擬store |
| 状態の一覧反映・切断・復旧 | loopback実HTTP＋Node VMの模擬DOM |
| commit後ACK消失→他タスク操作→カード再表示→同ID／本文の再送 | loopback実HTTP＋模擬DOM、ACK消失はtransport側の模擬例外 |
| 3 assetだけの出力、未知出力の拒否、明示output設定 | ローカルfile build。Vercel packagingではない |

## 残件

`pg` 8.23.1は未取得、lockfileも未生成。TLS取得を同条件で繰り返しておらず、検証の無効化もない。実DB／TLS／別接続競合／commit後永続化／backup、Vercel packagingとfilesystem経路、All Deployments・本人だけのaccess設定、Trusted Sources／共有／bypass／例外なしの確認、全URL／直接Function／POSTの未認証拒否、AI認証transport、実ブラウザー操作、reload後の未確認要求復旧、実データの項目対応・移行は残っている。

この候補を本番で有効化・移送に使用しない。公開PRと実環境設定は次の指示を待つ。

## 2026-10-13 ローカル候補の取得・ACK境界修正

重なったGETは最後に開始した要求だけを採用する。遅い旧応答が最新画面や切断状態を接続中へ巻き戻さず、POST開始前のGETも更新成功の証拠にしない。取得JSONのタスク・主担当・版・時刻・重複IDを検査し、不正または既存revisionより古い応答は前の表示を保持して更新を無効にする。新しい正常応答で復帰できる。

成功ACKも完全なタスク形と要求の期待版+1を確認する。不正ACKでは未確認要求ID/本文を保持し、同じ要求で再送する。これらは模擬DOM/合成HTTPの検証であり、実ブラウザー・実DB・Vercel配置の確認ではない。別DBへの意図的なrevision巻戻しを追跡するepochは未導入で、復元/移行時には既存画面のreloadと未確認要求の扱いを別途判断する。
