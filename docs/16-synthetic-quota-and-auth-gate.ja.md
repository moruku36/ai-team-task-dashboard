# WEB-PREPARATION: クォータ鮮度の統合準備(公開コード/合成データのみ)

対象は本フォルダ内の公開コード/合成データのみ。実コレクタ・実DB・ネットワーク・認証情報・デプロイ・git・設定変更には触れていない。**本番完成・デプロイ済みとは主張しない。**

## 0. 現在の状態(要約)
- 達成: 純モジュール統合、`GET /api/quota`、許可リストDTO、合成専用クォータstore、UI要約、**認証必須化(既定拒否)**、`vercel.json` ルーティング案、統合テスト10件。
- 未達(ブロッカー): **本番認証アダプタ未実装/未承認**、pgロック未実装、DB/Neon未接続、実コレクタ/heartbeat契約未決定、実タスク移行は承認待ち、デプロイ準備未完了(下記 §7)。
- 本番(`api/index.mjs` → `createVercelHandler()` の既定export)は認証アダプタが無いため**全リクエストを503で拒否**する。これは意図した状態。

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

