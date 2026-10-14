# WEB-PREPARATION: クォータ鮮度の統合準備(公開コード/合成データのみ)

対象は本フォルダ内の公開コード/合成データのみ。実コレクタ・実DB・ネットワーク・認証情報・デプロイ・git・設定変更には触れていない。**本番完成・デプロイ済みとは主張しない。**

## 0. 現在の状態(要約)
- 達成: 純モジュール統合、`GET /api/quota`、許可リストDTO、合成専用クォータstore、UI要約、**認証必須化(既定拒否)**、`vercel.json` ルーティング案、統合テスト10件。
- 未達(ブロッカー): **本番認証アダプタ未実装/未承認**、pgロック未実装、DB/Neon未接続、実コレクタ/heartbeat契約未決定、実タスク移行は承認待ち、デプロイ準備未完了(下記 §7)。
- **【更新: §8】** 本番既定exportは Better Auth 1.7.7 + Sign in with Vercel の**実オーナー認証アダプタを遅延配線**した(コードのみ)。設定(環境変数キー)が揃わない間は `/api/tasks`・`/api/quota`・`/api/auth/*` は503(DB/ネットワーク無し)。**実プロバイダ/ログイン/DBでの受け入れは未実施**。静的3アセットのみ未認証で配信(サインインUIを表示するため。データ無し)。以降の §3 の「全リクエスト認可/全拒否」の記述のうち、静的アセットと `/api/auth/*` は §8 で上書きされる。

## 1. 既存契約(読んだ範囲)と訂正
- `GET /api/tasks` → `{ revision, tasks[], observedAt }`。`observedAt` は **配信時刻**(`publicSnapshot` が付与)。タスク公開DTOは `id,title,status,owner,group,detail,lastConfirmedAt,version,updatedAt` のみ。`POST /api/tasks` は `{requestId, expectedVersion, task}`(CAS+冪等)。**この契約・意味論は変更していない。**
- クライアントは `observedAt` が端末時刻から±60秒を超えるsnapshotを破棄する。配信時刻を収集時刻の代用にしない。
- **TTL訂正(Codex統合レビュー)**: 既存ローカル `scripts/usage-metadata.mjs` は正の `stale_after_seconds` を `Math.min(value, 3600)`、欠測/不正は3600秒。**1時間は下限ではなく上限/既定値**(出典: `FRESHNESS-INTEGRATION-REQUIREMENTS.ja.md`)。前回の「最小1時間」は誤り。
- 同文書より: 年月日/時刻を検証、未来の観測/収集値はstale、freshnessは収集と観測の古い方、Codex/Claude/AG statuslineは観測時刻必須、AG CLIは収集時刻fallbackあり得る、reset通過は `awaiting_refresh`(回復成功へ変換しない)、失敗/曖昧/欠測とlast-knownを保持、heartbeatはクラウド向け新契約で既存collectorにある保証はない。

## 2. 変更ファイル(正確な一覧)
新規:
- `cloud/auth.mjs` — `authorizeOwner(authorize, req)`: 既定拒否。
- `cloud/quota.mjs` — アダプタ境界 + 許可リストDTO(`publicQuotaEntry` / `publicQuota`)。
- `cloud/quota-freshness.mjs` — (前回作成)純鮮度モジュール。今回 `parseIsoTimestamp` をexportのみ追加(挙動不変)。
- `cloud/tests/quota-freshness.test.mjs` — (前回作成, 10件, 無変更)。
- `cloud/tests/quota-integration.test.mjs` — 新規統合テスト10グループ。
- `cloud/tests/synthetic-auth.mjs` — **テスト専用**の合成オーナーcallback。
- `WEB-PREPARATION.ja.md`(本書)。

既存ファイルの変更:
- `cloud/server.mjs` — `handler({store, env, authorize, quotaStore, now})`、全リクエスト前に認可、`GET /api/quota`、`createVercelHandler({..., authorize, quotaStore})`、`startLocalServer(port, {authorize, quotaStore})`。
- `cloud/synthetic.mjs` — `SyntheticQuotaStore`(合成専用)追加。
- `cloud/public/app.js` — クォータ表示(`refreshQuota` 等)を**同一ファイル内**に追加。
- `cloud/public/index.html` — `<section id="quota">` 追加。
- `cloud/public/style.css` — クォータ用スタイル追記。
- `vercel.json` — `/api/quota` rewrite追加(**デプロイしていない**)。
- 既存テストの最小調整(**今回は実行していない**、§6): `cloud/tests/fixtures.mjs`(`app()` が合成オーナーcallbackを既定注入)、`cloud/tests/dashboard.test.mjs`(`handler`/`createVercelHandler`/`startLocalServer` 直接呼び出しに合成callbackを明示注入)、`cloud/tests/build.test.mjs`(rewrite一覧に `/api/quota` を追加)。
- 未変更: `api/index.mjs`(合成callbackを配線していない)、`cloud/model.mjs`、`cloud/postgres.mjs`、`cloud/build*.mjs`、`cloud/deployment-preflight.mjs`(新規 `auth.mjs`/`quota*.mjs` は必須ファイル一覧に未追加。既存preflightテストの契約を変えないため。追加は要判断)。
- 出力アセットallowlistは3つのまま(`index.html`,`app.js`,`style.css`)。

## 3. 認証(新要件: 既定拒否)
- `authorize` は**明示注入されるコールバック**。`verified === true` かつ `role === 'owner'` かつ非空 `subject` を返した場合のみ通過。
- 判定: コールバック無し=503、例外=503、null/未検証/形式不正=401、検証済みだがowner以外/subject無し=403。**全て認可前に store/quotaStore へ一切アクセスしない**。ボディ読み取りもしない。
- 全リクエスト(静的アセット、書き換え後パス `?dashboard_path=...` 含む)をルーティング前に認可する。
- 次はいずれも認証として扱わない: ヘッダ、クエリ、環境フラグ、`VERCEL=1`、`x-vercel-*` 、Cookie(暗号検証なし)、Origin(書き込みのCSRF的制約としてのみ従来通り使用)。迂回フラグなし。
- `createVercelHandler`: アダプタ無し→DB初期化(`connect`)前に503。認可は `connect` の**前**に行い、拒否時は接続しない。既定export(`api/index.mjs`)はアダプタ無し=全拒否。
- `startLocalServer` も注入が無ければ全拒否(`node cloud/server.mjs` 単体起動はすべて拒否)。ローカルで使うには呼び出し側が明示的にcallbackを渡す。
- 合成callback(`cloud/tests/synthetic-auth.mjs`)はテスト専用。`api/index.mjs`/`server.mjs`/本番起動からimportしない(テストで静的検査)。偽の本番セッションや資格情報は生成していない。
- **本番認証アダプタは承認・統合待ちのゲート**。実装方式(署名付きセッション/トークン検証、オーナー判定の根拠)は未決定。

## 4. クォータ統合
- 経路: `GET /api/quota`(認可必須、読み取り専用。POSTは404)。レスポンス `{ servedAt, entries[] }`。`servedAt` は配信時刻で、他の時刻フィールドに代入しない。
- 許可リストDTO(エントリ): `provider('codex'|'claude'|'ag')`, `source('native'|'statusline'|'cli'|null)`, `freshness`, `state`, `resetState`, `freshnessBasis`, `freshnessAgeMs`, `staleAfterSeconds`, `observedAt`, `collectedAt`, `lastSuccessAt`, `resetAt`, `usedPercent`, `lastKnown`, `reasons`。フィールド単位で構築し、未知フィールド・秘密・ソースパス・モデル別クォータ・未知providerは除去。**モデル別クォータは作らない**(providerごとに1エントリ、provider+source重複は先勝ち、最大6)。
- アダプタ境界(`quota.mjs`): native `observed_at` vs AG fallback。
  - codex/claude: `observedAt` 必須。無ければ `unknown`。
  - ag statusline: `observedAt` 必須。ag cli のみ収集時刻fallback(`freshnessBasis: 'collected_fallback'`)。
  - 鮮度基準 = 観測と収集の**古い方**。基準・最終成功・reset・heartbeatを純モジュールで評価。
  - TTL: `min(staleAfterSeconds, 3600)`、欠測/不正/0/負数は3600。
  - 未来の観測/収集は stale(既存契約)。未来の最終成功は純モジュールがunknown→adapterがstaleへ。いずれも current にならない。`futureSkewMs: 0`。
  - reset到達 → `resetState: 'awaiting_refresh'` かつ鮮度は current にならない(回復成功へ変換しない)。不正reset → `invalid`。
  - `state` が `failed/ambiguous/missing`(不正値は missing) → last-knownがあれば `reference`、無ければ `unknown`。`usedPercent` は null、last-knownは参考値として保持。
  - コレクタ offline/heartbeat欠落/途絶/未来 → `reference`(候補: 途絶5分 = `OFFLINE_AFTER_MS`。**既存collector契約ではない**)。現状heartbeatを供給する契約が無いため、実データが接続されても heartbeat契約が決まるまで current にはならない(安全側)。
- store: `SyntheticQuotaStore`(合成専用、メモリのみ)。`createVercelHandler` は `quotaStore` を受け取れるが既定は無し → `entries: []`(UIは「未接続(不明)」)。実クォータstore・実collector呼び出しは**なし**。
- UI(`app.js`): `current=最新 / stale=古い可能性 / reference=参考値 / unknown=不明` を表示。観測・収集・最終成功・リセットを個別表示し、配信時刻は別表示。TTLはサーバーのみで判定(二重定義なし)、UIは格上げしない。取得失敗/不正応答は「取得できません(不明)」で表示を置換(古い「最新」を残さない)。初回取得は `setTimeout` 経由、定期取得は30秒(既存タスク取得のテストハーネスに影響を与えないため)。

### 4.1 追加修正(Codexレビュー反映)
- 同一 provider/source の保存レコードが**重複または矛盾**する場合は、先頭/末尾を選ばず**単一の ambiguous エントリ**(`state:'ambiguous'`, `freshness:'unknown'`, `usedPercent:null`, 各時刻null, `lastKnown:null`, reasons `duplicate-records`)にする。current にならない。
- `state:'ok'` でも `usedPercent` が欠測/不正(NaN/Infinity/範囲外/文字列/null)なら `state:'missing'`(reason `used-percent-invalid`)として扱い、利用可能とは主張しない。`lastKnown` は別枠で、値が有効かつ観測時刻が有効・**未来でない**場合のみ保持(不正・未来は null=利用不可)。有効なlast-knownがあれば `reference`、無ければ `unknown`。
- `deployment-preflight` の必須ソースに `cloud/auth.mjs` / `cloud/quota.mjs` / `cloud/quota-freshness.mjs` を追加(欠落・ディレクトリ等の不正は既存ソースと同じ `missing_or_unsafe:<name>`)。`deployment-preflight.test.mjs` のfixtureを更新し、新規ソースの欠落/不正テストを1件追加。
- **本番の現状**: 認証アダプタ無しのため `api/index.mjs` は**全リクエスト拒否(503)**。実オーナー認証アダプタは承認待ち。クォータの供給元は**合成専用**(`SyntheticQuotaStore`)で、本番に実データ経路は無い。

### 4.2 実collector取り込み前に必要な適応(未実装・本DTOは準備完了ではない)
現行DTOは**provider単位・単一窓の合成用**であり、実の複数期間/共有プールDTOではない。モデル別クォータは作っていない。実collector取り込み前に次の設計・適応が必須:
- `quota_scope`(アカウント/ワークスペース/モデル群などのスコープ識別)
- `period`(5時間窓/週次など複数期間の同時保持)
- 共有プール(複数provider/モデルで共有される枠)の表現
- reset窓(`reset_window` の開始/終了、期間ごとのreset時刻と `awaiting_refresh` の窓単位判定)
- 上記を踏まえた重複キー(現在は provider+source)の再定義、DB保存形、ingestion契約(heartbeat含む)。

## 5. 純モジュール(前回分・要点)
`evaluateQuotaFreshness(record, { now, staleAfterMs, offlineAfterMs, futureSkewMs })` は I/Oなし・時計読み取りなし。`staleAfterMs`/`offlineAfterMs` は有限かつ>0、`futureSkewMs` は有限かつ>=0、違反は `TypeError`(fail closed)。経過時間==`staleAfterMs` は current、超過でstale。不正カレンダー日付は拒否。未来heartbeat(skew超過)は reference。既定値(15分/5分/60秒)は**候補**で既存契約ではない。統合側(`quota.mjs`)は常にTTL/offline/skewを明示して渡す。

## 6. テスト状況(実行した/していない)
- 実行して通過: `node --test cloud/tests/quota-integration.test.mjs` → **10件中10件パス**(合成データのみ、loopbackのテストサーバー)。
  内容: 未認証/拒否/例外/非ownerのGET・POST(tasks/quota、書き換えパス、偽装ヘッダ/環境フラグ付き)が storage に触れず拒否 / `createVercelHandler` の接続前拒否と既定export / 時刻の分離とTTL上限 / collector offline / 未来時刻 / stale・reset・状態・native vs AG fallback / DTO許可リストと秘密除去 / 既存 `/api/tasks` 契約不変 / UI表示とアセット3件・rewrite / 実collector・ネットワーク・合成callback非配線の静的検査。
- **実行していない**: `quota-freshness.test.mjs`(前回実行済み・今回変更は `parseIsoTimestamp` のexportのみ)、`dashboard.test.mjs`、`ui.test.mjs`、`build.test.mjs`、`deployment-preflight.test.mjs`(指示により上記1コマンドのみ実行)。既存テストは認可導入に合わせて最小調整済みだが、**未実行のため通過は未確認**。`npm test` での全体確認が必要。

- **§4.1 の修正後は未実行**: 修正後に `quota-integration.test.mjs` / `node cloud/build.mjs` / `node cloud/deployment-preflight.mjs` を実行しようとしたが、Bashの実行が拒否されたため**結果なし**(上の「10件パス」は修正前の実行結果)。`deployment-preflight` は lockfile/pg が無いため not ready になるのが想定。

## 7. 未実装・リスク・ブロッカー
- **本番認証アダプタ**: 未実装・承認待ち。無い限り本番は全拒否(503)。
- **pgロック未実装**: `PostgresStore` は `SELECT ... FOR UPDATE` の行ロックのみ。クォータの書き込み経路・取り込みロック/順序制御は未設計。
- **DB/Neon**: 未接続・未検証(`databaseVerified:false`)。クォータの保存先(`dashboard_state` 別キー/別テーブル)は未決定。
- **未構成の本番は拒否**: `DASHBOARD_ORIGIN`(https)・`DATABASE_URL`・認証アダプタのいずれか欠落で503。
- **デプロイ準備未完了**: 配信・Vercel環境・ドメイン・保護設定・`vercel.json` ルーティングの実環境確認なし。`/api/quota` rewrite は案であり**デプロイしていない**。preflightは新規モジュールを未検査。`package-lock.json` 等の状態は未確認。
- **実コレクタ/heartbeat/取り込み**: Windows停止検知、送信契約、署名・認証、書き込みAPIは未決定・未実装。`futureSkewMs: 0` は時計ずれで過剰にstale/referenceへ倒れる可能性あり(安全側)。
- **実タスク移行は承認待ち**: 実タスクデータ・私的データの読み取り/移行は行っていない。承認後に別途設計。
- クォータはprovider単位のみ(モデル別は存在しない/作らない)。共有poolの扱いはDTO未整合。

## 8. 本番オーナー認証アダプタ(Better Auth 1.7.7 + Sign in with Vercel)— コードのみ・実環境未検証
**状態: 実装済み(コード)、未検証。`npm install`・DB接続・ブラウザ/認証API呼び出し・実セッション・資格情報の生成/読み取りは一切していない。実プロバイダ/ログイン/DBの受け入れは未了。**

### 8.1 変更ファイル(今回)
- 新規: `cloud/owner-auth.mjs`(遅延アダプタ)、`cloud/tests/owner-auth.test.mjs`(6グループ)、`cloud/auth-schema.prep.sql`(**準備のみ・未実行**)。
- 変更: `cloud/server.mjs`(静的アセットを認可前に配信、`/api/auth/*` ルーティング、本番既定exportに実アダプタを遅延配線、認可→DB接続の順)、`package.json`(`better-auth: 1.7.7`、`pg: 8.23.1`、`engines.node: 22.x`)、`vercel.json`(認証rewrite4本)、`cloud/public/{index.html,app.js,style.css}`(サインイン/サインアウトUI、同一ファイル内)、`cloud/deployment-preflight.mjs`(必須ソースに `owner-auth.mjs` 追加)、`cloud/tests/{quota-integration,build,deployment-preflight}.test.mjs`(アセット非認可・rewrite一覧・fixtureの追随)。
- 未変更: `api/index.mjs`(合成callbackは配線なし)、タスクのCAS/冪等/クォータの挙動。
- **未実行(要確認)**: 上記の変更後、`quota-integration` / `build` / `deployment-preflight` / `dashboard` / `ui` の各テストは再実行していない(指示された1コマンド `node --test cloud/tests/owner-auth.test.mjs` のみ実行し **6/6通過**)。`quota-integration.test.mjs` のテスト1・9 とビルド/preflightテストは本変更に合わせて編集済みだが未実行。preflightに `better-auth` のlock検証は追加していない(未実装)。

### 8.2 一次情報で確認できたこと / できなかったこと
確認済み(公式ドキュメント取得: better-auth.com, vercel.com):
- Better Auth Vercelプロバイダ: `socialProviders.vercel: { clientId, clientSecret }`、`scope` は任意(スコープはVercel App側で設定)、PKCEは自動、デフォルトのコールバック `/api/auth/callback/vercel`(base path変更時は更新)、クライアント開始は `authClient.signIn.social({provider:"vercel"})`。
- Node連携: `better-auth/node` の `toNodeHandler(auth)` と `fromNodeHeaders(req.headers)`、`auth.api.getSession({ headers })`。**ボディパーサーより前に**ハンドラを置く必要あり(Express頁の記述)。専用の「Node」頁は404で、Express頁の例を根拠にしている。
- `pg` の `Pool` を `database` に直接渡せる。`emailAndPassword.enabled` 既定false、`disabledPaths`、`socialProviders.<p>.disableSignUp`、`account.accountLinking.enabled`(既定true)、`advanced.useSecureCookies`、`advanced.disableOriginCheck`(既定false)、`session.expiresIn`(既定7日)、`trustedOrigins`、`baseURL`/`BETTER_AUTH_SECRET`。Cookie名 `better-auth.session_token`、本番では httpOnly/secure。
- Vercel IdP: ID Token `sub` = ユーザー固有ID、検証はJWKS(`https://vercel.com/.well-known/jwks`)・issuer `https://vercel.com`・audience=client_id・nonce。App作成/Client Secret生成/コールバックURL登録/「Sign-In Access: Members of the team」制限はダッシュボード操作(人間)。Client Secretは最大2つ有効(ローテーション可)。
未確認・推定(**本物として扱わない**):
- Better Auth の Vercel プロバイダが保存する `account.accountId` が ID Token の `sub` と一致するか(文書は「プロバイダが割り当てた安定ID」とだけ記載)。**一致しなければ `OWNER_VERCEL_SUBJECT` との照合が常に失敗(=全員拒否)する安全側の失敗**。
- サーバー側 `auth.api.listUserAccounts` の存在・返却形(文書はクライアント `listAccounts()` のみ)。存在しない/配列でなければ 503(安全側)。
- HTTPパス `POST /api/auth/sign-in/social`、`POST /api/auth/sign-out` と、`sign-in/social` が `{ url }` を返す挙動(文書に明記なし)。UIは `https://vercel.com/` で始まるURLにのみ遷移する。
- `advanced.defaultCookieAttributes.sameSite` の受理と既定値(取得頁に記載なし)。OAuthのリダイレクト往復に必要なため `lax` を明示指定(Vercel公式チュートリアルも `lax`)。
- ID Tokenの署名/nonce/PKCE/stateの検証は**ライブラリ内部に委任**しており、本リポジトリのテストでは検証していない(モックは実OIDCの証明ではない)。
- Vercel App 側コールバックURLの形: Vercel公式チュートリアルは `{origin}/api/auth/callback` を例示するが、Better Auth は `/api/auth/callback/vercel` を送る。**Vercel App に後者を登録でき、リダイレクトURI不一致にならないか未確認**。
- Vercel のrewrite後に `req.url` が元URLか宛先URLか、元クエリ(`code`,`state`)が宛先に引き継がれるか(コードは両方に対応する想定だが未検証)。VercelのNodeランタイムが `req.body` を事前消費するか(認証ルートでは `req.body` に触れない)。
- 最小スコープ(`openid` のみ等)でBetter Authのユーザー作成が成功するか(emailが必須の可能性)。コードは `scope` を指定せずApp側設定に従う。

### 8.3 認証の判定(実装)
- `createOwnerAuth()` は**遅延**: `DASHBOARD_ORIGIN`(https・厳密一致)、`VERCEL_CLIENT_ID`、`VERCEL_CLIENT_SECRET`、`BETTER_AUTH_SECRET`(32文字以上)、`DATABASE_URL`(postgres)、`OWNER_VERCEL_SUBJECT` のいずれかが欠落/不正なら、ライブラリのimport・構築・DB・ネットワークなしで503。ライブラリ作成失敗も503(次回再試行、秘密はレスポンスに出さない)。
- 認可: ライブラリの `getSession`(サーバー側検証)で有効なセッションを要求 → 連携アカウントの `providerId==='vercel'` の `accountId` を `OWNER_VERCEL_SUBJECT` と**定数時間比較**。不一致/Vercel連携なし/未知ownerは `viewer`(403)。セッション内のrole/subject、ブラウザ値、`VERCEL=1`、`x-vercel-*`、外側Cookieは不使用。主体は不透明ダイジェストで、アカウントID・氏名・メールは返さない/表示しない。
- `/api/auth/*` は4本のみ(`GET status`(独自・`anonymous|owner|forbidden` のみ返す)、`POST sign-in/social`、`GET callback/vercel`、`POST sign-out`)。それ以外は404、タスク/クォータデータは返さない。メール/パスワード・他プロバイダは構成せず(`emailAndPassword.enabled:false`、`accountLinking.enabled:false`、`trustedOrigins`は正確なorigin、`disableOriginCheck:false`、`useSecureCookies:true`、`httpOnly`/`secure`/`sameSite:'lax'`、セッション12時間、`rateLimit.enabled:true`)。
- 順序: 設定 → 静的アセット/認証フロー(DBなし)→ オーナー認可 → DB接続 → ルート。
- 既知の限界: ライブラリは、ログインに成功した**任意のVercelアカウント**のuser/account/sessionを(許可スコープに応じ氏名・メール・トークン含め)保存し得る。403で拒否されるが行は残る。緩和=Vercel Appの「Sign-In Access: Members of the team」と最小スコープ(人間設定)。

### 8.4 必要な環境変数のキー名(値は人間が秘密UIに入力。本リポジトリ/チャット/ログに載せない)
`DASHBOARD_ORIGIN`(`https://<ドメイン>` 厳密)、`VERCEL_CLIENT_ID`、`VERCEL_CLIENT_SECRET`、`BETTER_AUTH_SECRET`(長いランダム値)、`DATABASE_URL`(Neon)、`OWNER_VERCEL_SUBJECT`(オーナーのVercelユーザーID=ID Tokenの `sub`。取得方法は人間が承認済みの手段で)。キー名のみ記載、**値は未設定・未確認**。

### 8.5 人間が行う作業(私は実施していない)
1. Vercel(チームのSettings → Apps)でAppを作成、Client Authenticationは `client_secret_basic`/`client_secret_post` 等でClient Secretを生成(秘密UIで保管)。**Sign-In Accessを「Members of the team」**、Permissionsは必要最小限(`openid`、Better Authがemail必須なら `email`、`profile` は不要なら外す。`offline_access` は付与しない)。
2. Authorization Callback URL に **`https://<DASHBOARD_ORIGIN のホスト>/api/auth/callback/vercel`** を登録(上記の未確認事項に注意。拒否されたら実際のリダイレクトURIを確認して設計見直し)。ローカル検証が必要なら別途 `http://localhost:<port>/api/auth/callback/vercel`(本コードの本番入口は https のみ受理)。
3. Vercelプロジェクトの環境変数に §8.4 のキーを秘密として設定(ローカル `.env` は作らない)。
4. Neon Free: 専用プロジェクト/DB・専用ロールを作成(最小権限: 当該DBのスキーマ作成と表のCRUDのみ)。接続文字列は `DATABASE_URL` のみに設定。
5. 認証テーブル: **`cloud/auth-schema.prep.sql` は準備のみ**。公式CLI `npx auth@latest generate` の出力で差分確認のうえ、人間が適用(`migrate` も同様)。**未実行・列定義は一次情報で未検証**。
6. 初回ログイン後のオーナー確認、拒否されるアカウントの確認、サインアウトの確認(実プロバイダ受け入れ)。

### 8.7 追補(Codexレビュー反映)
**UI初期表示の修正(`cloud/public/app.js`)**: 検証済みの `/api/tasks` スナップショットを一度も受理していない間は、グループ/列の件数を `—`、取得時刻を「未取得」と表示(0件とは表示しない)。接続失敗時、受理済みスナップショットが**無い**なら「まだタスクを取得できていません(0件ではありません)」のみ(「最後に取得」は主張しない)。受理済みが**ある**場合のみ、そのスナップショットを保持して「最終取得…古い可能性があります」と表示。検証済みの空成功のみ真の `0`。テスト: `cloud/tests/initial-unfetched.test.mjs` 3件(`node --test cloud/tests/initial-unfetched.test.mjs` → 3/3通過、VMハーネス=描画ロジックのみ)。
**`user.validateUserInfo` による事前拒否(`owner-auth.mjs` の `ownerOnlyValidation`)**: Vercelの `profile.sub` が `OWNER_VERCEL_SUBJECT` と(定数時間で)一致する場合のみ許可。`providerId` が `vercel` 以外、profile欠落/`sub`非文字列/不一致、他の認証方法は `{ error: 'owner_only' }` で拒否 → 非オーナーはuser/account/tokenの行を作られない設計。呼び出し側のrole/ヘッダ入力は参照しない。APIセッション+連携アカウント照合(§8.3)は多層防御として維持。
一次情報で**解決した点**(Codex提示のofficial default branch + 公式docs):
- `listUserAccounts`: `better-auth/better-auth` default branch `packages/better-auth/src/api/routes/account.ts`(SHA `0b5ff1bb…`)に存在し、`sessionMiddleware` 付きで `accountId`/`providerId` を返す(Codex確認)。
- Vercelプロバイダ: `packages/core/src/social-providers/vercel.ts`(SHA `776d1028…`)が `profile.sub` を account subject にする(Codex確認)→ `accountId == sub` の懸念は**default branch上では解消**。
- docs `concepts/users-accounts`: `user.validateUserInfo({ user, source })`、`source.action`(`create-user|link-account|sign-in`)、OAuthでは `source.oauth` にproviderIdと生プロファイル、戻り値は「何も返さない=許可、`error` を持つオブジェクト=拒否」、リダイレクト系はエラーURL、プログラム系は403。
- Express docs: `toNodeHandler`/`fromNodeHeaders`/`getSession({ headers })`。
**まだ未解決/未検証**:
- 上記の根拠は**default branchのソース**であり、**固定した 1.7.7 リリースの実行時挙動の証明ではない**。1.7.7 を実際にインストールして確認するまで、`listUserAccounts` のサーバーAPI名・戻り値、Vercelプロバイダの `accountId`、`validateUserInfo` の引数形(生プロファイルのキー名は `source.oauth.profile` と仮定。違えば全拒否=安全側)はすべて**未検証**。
- 実ログイン/OIDC(署名・nonce・PKCE・state)/Cookie/Vercel rewrite/Functions/Neon での受け入れは未実施。
- `sign-in/social`・`sign-out` のHTTPパス、`sameSite` オプション、最小スコープでのユーザー作成は引き続き未確認(§8.2)。
- 認証テーブル: 公式 `concepts/database#core-schema` の再取得でも**列定義が本文に含まれず**、`cloud/auth-schema.prep.sql` との項目別比較は**実施できなかった**(誤りの訂正もしていない)。未実行・版/実行時未検証のまま。人間が `npx auth@latest generate`(1.7.7固定の実環境)と差分確認すること。
- `owner-auth.test.mjs`(`ownerOnlyValidation` の静的/モック検証を追加)は**今回未実行**(実行したのは `initial-unfetched` の1コマンドのみ)。最後に実行した `owner-auth.test.mjs` は前回6/6通過。

### 8.8 検証結果と訂正(最終検証ターン)
**実行した検証(各コマンドを個別実行)**:
- `node --test cloud/tests/owner-auth.test.mjs` → **6/6 通過**(`ownerOnlyValidation` のモック検証を含む)。
- `node --test cloud/tests/quota-integration.test.mjs` → **10/10 通過**(認証・UI変更後の既存10統合回帰。fixtureのアセット非認可化後も通過)。
- `node cloud/build.mjs` → 成功(`dist/public` を出力)。
- 失敗・修正: なし。未実行: `dashboard`/`ui`/`build`/`deployment-preflight`/`quota-freshness`/`initial-unfetched`(後者は前ターンで3/3)の各スイート(指示外)。デプロイは**未実施**。
**一次情報状況の訂正**:
- `validateUserInfo` のプロファイルキー: 公式 `concepts/users-accounts` の例が `source.oauth.profile.hd` を使用しており、**`source.oauth.profile` というキーは文書化されている**(§8.7の「仮定」を訂正)。ただし固定した 1.7.7 の実行時挙動は**未検証**。
- 認証テーブルの**フィールド網羅**: 公式 core-schema のフィールド一覧(Codex取得)と `cloud/auth-schema.prep.sql` を項目別に照合し、user(7)/session(8)/account(13)/verification(6) の**全フィールドが存在し、過不足なし**(**フィールド網羅は確認済み**)。**列の型・NULL可否・UNIQUE・外部キー制約、1.7.7リリースが実際に生成するSQL、実行時挙動は未検証**。インデックス3本はドラフト独自の追加。**マイグレーションは未適用**。
- 前回提示のSHA(`account.ts` `0b5ff1bb…`、`vercel.ts` `776d1028…`)は **default branch のメタデータであり、固定した 1.7.7 リリースの証明ではない**。
**現状**: 実プロバイダのログイン/OIDC、実DB、Neon、実Cookie、Vercel rewrite/Functions、デプロイ(`vercel.json` は未デプロイ)はすべて**未実施・保留**。本番認証アダプタは**コードのみ(未検証)**で、人間の秘密入力・Vercel App登録・DB準備後に実受け入れが必要。

### 8.9 コールバック診断モード(`OWNER_VERCEL_SUBJECT` 未設定時)— コードのみ・実環境未検証
**目的**: オーナーのVercel `sub` を人間が確認できるよう、通常のBetter Auth Vercelサインイン/コールバックを**必ず拒否する診断**として動かす。認可は一切付与しない。
**変更ファイル**: `cloud/owner-auth.mjs`(診断構成・`diagnosticValidation`・既定sink・logger無効化・`onAPIError.errorURL`)、`cloud/server.mjs`(本番入口で `allowOwnerDiscovery: true` を明示)、`cloud/public/app.js`(相関IDの保存/表示)、`cloud/tests/owner-auth.test.mjs`(診断テスト追加)。`index.html`/`style.css`/`vercel.json`/クォータ・タスク処理は**変更なし**(新ルート・新エンドポイントなし)。
**構成**: `readAuthConfig` は**既定で厳格**(既存利用側は不変)。`readAuthConfig(env, {allowMissingOwner:true})` のときだけ、`OWNER_VERCEL_SUBJECT` が**完全に未設定(undefined/null/空)**で、かつ他の必須設定がすべて有効な場合に限り `{diagnostic:true, ownerSubject:null}` を返す。**値はあるが不正**な場合は診断にならず不可。`createOwnerAuth` は `allowOwnerDiscovery:true` を渡した場合のみ診断構成を許可(未指定なら未設定オーナーは従来どおり503)。
**認可の境界(診断中)**: `authorize()` は常に `null`(セッション参照もライブラリ呼び出しもしない)→ `/api/tasks`・`/api/quota`・POSTは401、DBは接続しない。相関ID/Cookie/ヘッダが一致しても**何も付与しない**。`/api/auth/status` は `{state:'diagnostic'}` とサインインボタンのみ(公開オリジンはexact same origin、Vercel外側保護は既存のまま。バイパス・既定オーナーなし)。
**検証フック**: `user.validateUserInfo(data, ctx)`(コールバックの `parseState`・`getUserInfo` の後、user/account/session作成の**前**)は診断では**常に `{error:'owner_unconfirmed'}` で拒否**。参照するのは `source.oauth.providerId==='vercel'` と `source.oauth.profile.sub`(`/^[A-Za-z0-9_-]{6,128}$/`)、`ctx.query.state`(`/^[A-Za-z0-9_.~-]{8,512}$/`)のみ。
**sink出力の境界**: 注入可能なsinkへ渡すのは固定フィールドのみ — `event`(`owner_discovery_rejected`)、`provider`(`vercel`)、`sub`、`at`(ISO時刻)、`correlationId`(`state` のSHA-256先頭16桁hex)。`state`/`code`/`verifier`/トークン/Cookie/プロファイル/name/email/env/エラーオブジェクトは**渡さず・出力しない**。`state` または `sub` が無い/不正なら**拒否のみでsink出力なし**。sinkが例外を投げても判定は変わらない。既定sinkは上記5項目だけを `console.info(JSON)` に出力(非秘密のsubはプライベートなサーバーログ限定。データAPI・URLクエリ・レスポンスには出さない)。Better Authの生ロガーは `logger.disabled:true` で無効化(プロバイダエラーの漏えい防止)。エラー復帰は既存の通常コールバックと `onAPIError.errorURL` は相対 `/` ではなく**絶対HTTPSの `config.origin + '/'`**(`readAuthConfig` が https・パスなしのexact originのみ許可)で、コールバックのエラー復帰先を同一オリジンのルートに一意化。
**UI(相関ID)**: サインイン開始時にまず保存済みの相関IDを**削除**(古い試行の再利用禁止)。ライブラリが返した認可URLの `state` をWeb Cryptoでハッシュし、**ハッシュ16桁のみ**(生stateは保存しない)を `sessionStorage` に保存してからリダイレクト。state/ダイジェストが得られなければ保存せず削除済みのまま。ルートに戻った時、**クエリが厳密に `error=owner_unconfirmed` のときだけ**「サインインは『オーナー未確認』のため拒否された。ログインもオーナー認定も成立していない」という説明と一致する相関IDを表示(IDが無ければ「相関IDなし」)。それ以外の `error=`(例: `access_denied`)は理由を断定しない中立表示(「サインインは完了しませんでした。ログインは成立していません」)で、相関IDも出さない。ライブラリが実際に返す `error` コード値は**未検証**(一致しなければ中立表示になる=フェイルセーフ)。診断中の `/api/auth/status` は引き続き全データ認可を拒否。**実際のsubは表示しない**。相関IDは**認可の証明ではない**(ログ照合用ラベル)。
**確認不能/未検証(重要)**: ①通常のOAuthでは検証テーブルのstateレコードが必要になる場合があり、DB/認証スキーマの準備が前提。②認証スキーマ(`auth-schema.prep.sql`)・インストール済みSDK・`validateUserInfo` の引数形(`(data, ctx)`, `ctx.query.state`)・`onAPIError.errorURL`・`logger.disabled` の実行時挙動は**未検証**(キー不一致なら診断出力なしで常に拒否=フェイルクローズ)。③実ログイン/OIDC/DB/Cookie/Vercel rewriteは**未実施**。④モックテストは実OIDCの証明ではない。
**デプロイはブロック中**: オーナー値の保存(`OWNER_VERCEL_SUBJECT` を人間が設定)と認証スキーマの検証が済むまでデプロイしない。診断で得たsubは、人間が確認してから設定する(推測のREST user-idマッピングはしない)。確認済みオーナーモードの厳格なsub一致+リンク済みアカウント確認は不変。

### 8.6 認証関連で残る未実装/未検証
- 実プロバイダ・実ログイン・実DB・実Cookie・実Vercel rewrite/Functions挙動の受け入れ(すべて未実施)。
- 認証テーブルのmigration(未実行、列定義は未検証)、`pg` の既存ロック方針と認証テーブルの併用、pgロック(クォータ取り込み)未実装。
- preflightは `better-auth` のlock/インストール検証が未対応。`package-lock.json` と `node_modules` は存在しない(`npm install` 未実施)ため `check:deployment` はnot ready。
- 実タスク(113件)の移行は未承認で、読み取り・移行していない。
- 本番デプロイ・Vercelプロジェクト/環境変数/保護設定の変更は未実施。

