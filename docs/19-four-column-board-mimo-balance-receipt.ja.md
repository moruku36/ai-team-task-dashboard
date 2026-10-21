# 看板4列化・MiMo残高の情報源・受領記録の検証

この文書は設計と実装の説明です。実運用の台帳件数、カードの実状、受信口の集計、内部パスは含めず、例はすべて合成です。

## 1. 看板は4列（To Do / In Progress / Blocked / Done）

- 書き込みで受け付ける状態は4つだけです。すべてのカードがBlockedを通る必要はありません。
- 旧状態のカードは**4列の中**に表示し、旧状態をバッジで残します。5列目以降は出ません。
  - `Verifying`（最終確認）→ In Progress 列に「旧「最終確認」から表示（要確認）」付きで表示。Doneにはしません。
  - `Awaiting Approval`（承認待ち）→ Blocked 列に「旧「承認待ち」から表示（要確認）」付きで表示。
  - クラウド版（`cloud/model.mjs` の `legacyStatusMap`）は読み取り時に4状態へ寄せ、`legacyStatus` を保持します。
  - ローカル版（`scripts/status-display.js`）は旧列を常にCSSで隠し（カード0件でも）、各カードを対応する列へ表示用のコピー（プロキシ）として出します。クリックすると元のカードを開きます。
  - **保存状態の一括変更はしません。** 表示だけの変更で、IDも詳細も履歴も保たれます。
  - **旧状態のカードを保存しても、表示上の対応は保存されません。** 詳細画面には「保存上の旧状態」と表示上の列を示し、状態の選択肢の既定は「旧状態のまま（変更しない）」です。この既定のまま保存しても、別項目だけを編集して保存しても、保存状態は旧状態のままです（更新自体は記録され、版が進みます）。保存状態が変わるのは、利用者が4つの状態のどれかを明示的に選んだときだけで、そのときは旧状態が監査履歴（`from`）に残ります。新しい状態として書き込めるのは、従来どおり4種類だけです。
- 新規rootは4状態で初期化します。既存rootの `config.yml` は変更しません。旧状態は読み取り互換のため残ります。
- クラウドのCSSも4列に合わせています。
- 旧「承認待ち」を畳む縦長の帯（fold）の表示は、旧状態も4列内に表示する要件に置き換えました。

### 実データ移行の案（未実行）
1. 読み取り専用プレビュー: `node scripts/preview-status-migration.mjs <tasks-dir>`（IDと状態だけを出力。本文は出しません）。
2. 旧状態のカードがあれば、1件ずつ「完了証拠があればDone／作業中ならIn Progress／外部待ちならBlocked」を本人が判断します。曖昧なものは一覧にします。
3. 実行前に、共通root全体の非公開バックアップ（全AI writer停止後にコピー）を取ります。復旧は、そのバックアップを別rootへ戻してCLIとHTTPでID・状態を照合します。
4. ローカルの `config.yml` の `statuses` 行を4状態へ変えるのは移行後で、本人の確認後に行います。

### frontendの再接続テスト
`tests/frontend.mjs`（サーバー再起動後に標準UIが更新を受け取り続けるか）は、基準版（`origin/main`＝74f0d43）を隔離した一時worktreeで実行しても同じ1件が同じ内容で失敗しました。今回の変更によるものではありません。原因はスクリプト内の説明（データ用WebSocketの再接続処理がない）とされていますが、独立には確認していません。検証の削除・緩和はしていません。

## 2. MiMo API残高（現状: ローカル表示の実装まで）

- **実装済み:** ローカルの非公開表示に、残高・通貨・取得日時・取得状態・**情報源**を出す部分。情報源は `official_api` / `console_manual` / `mock` / `unconfirmed` で、使用量からの推計は残高として表示せず破棄します。取得不能時は0や架空の残高を出さず、未取得／取得失敗／古い情報を明示します。
- **未対応:** 実残高の取得と、公開側（`cloud/`）での表示。どちらも実装していません。
- **公式資料の確認結果:** [公式の充値案内](https://mimo.mi.com/docs/en-US/news/previous-news/recharge) は、残高をコンソールの Balance 画面で見ると説明しています。プログラムから残高を取る公式APIの記載は、探した範囲では見つかりませんでした（存在しないとは断定できません）。
- **保留中の判断:** 手入力（`console_manual`）／API確認／オーナー認証付きの非公開画面のどれを採用するか。決まるまで、認証設定、キーの配置、実アカウントへのアクセスは行いません。

## 3. 「適用済み」とカード内容の不一致

### 問題の型（合成例）
受信packetに「期限 2026-10-22・外部通信の阻害」を載せたのに、receiptは `applied` で、適用前後のhashが同一、カード本文にも期限と阻害の記載がない。このとき、receiptやhash一致、読戻し成功だけでは内容の反映は証明できません。

### 検証スクリプトと、実処理の修正は別です
`scripts/inbox-receipt-verify.mjs` は**読み取り専用の検証部品**です。これを追加しただけでは、既存の更新処理の誤判定は直っていません。更新担当（更新ジョブ）には未接続です。

判定は4段階（受信口への保存／更新担当の受領／対象タスクへの適用／画面反映）に分けます。所見は5種類を**別々に**保持し（`findings`）、総合判定は下の優先順位で決めます。

| 所見（`findings`） | 意味 |
|---|---|
| `receipt` | receiptが信頼できない（event_id・batch_idの不一致、`received_at`・`applied_at`が有効な日時でない、`applied_at`が`received_at`より前、receiptの指示時刻の欠落・不一致、applied_at・読戻しなし、対象IDの不一致） |
| `content` | 読み戻した実カードが、packetの期待と**食い違う**（状態、期限、阻害、必須文言） |
| `declaration` | packet自身の宣言とreceiptが矛盾する（`expects_no_card_change`なのにhashが変化） |
| `insufficient` | 比較材料が足りない（`card_assertions`なし、カード未読戻し、前後hashの欠落、packetに指示時刻がない、年のない日付など） |
| `owner` | 完了済みカードへの追記に、本人確認の記録がない／packetの自己申告だけ |

**総合判定の優先順位**（上から最初に当てはまるもの。所見はすべて残ります）

| 順位 | 判定 | 条件 |
|---|---|---|
| 1 | `inbox_integrity_error` | packetのhash・batch_idが受信口の記録と一致しない |
| 2 | `needs_owner_decision` | 完了（Done）済みカードを、本人確認の記録なしに再開・追記しようとしている |
| 3 | `saved_not_received` | receiptがない |
| 4 | `received_not_applied` | receiptはあるが `applied` ではない |
| 5 | `receipt_inconsistent` | `receipt` 所見がある |
| 6 | `mismatch_content_not_reflected` | `content` 所見がある（比較材料不足があっても、矛盾は隠さない） |
| 7 | `declaration_inconsistent` | `declaration` 所見がある |
| 8 | `unverified` | `insufficient` 所見がある（`card_assertions` 導入前のpacketはここに入り、破損扱いにしません） |
| 9 | `content_present_no_recorded_change` | 内容は既にカードにあるが、前後hashが同一（変更の記録がない） |
| 10 | `applied_verified`（画面が未反映なら `applied_not_displayed`） | receiptが整合し、前後hashが揃って変化し、実カードの内容がpacketの期待を満たす |

日時は、タイムゾーン付きのISO 8601で、実在する暦日のものだけを有効とします（`validInstant`）。

`card_assertions`（状態・期限・阻害・阻害要約・必須文言）は**期待値の宣言にすぎず**、呼び出し側が公式CLIなどで読み戻した実カードと必ず照合します。空の宣言（`{}` など）は検証とみなしません。

**期限の照合:** 部分文字列ではなく、日付として比較します（`10/2` は `10/22` ではなく、`1/5` は `11/5` ではなく、年が違えば別の日です）。カードに年のない日付（`10/22`、`10月22日`）しかない場合は、1つの年に確定できないため一致とはせず、`unverified`（`due_at_year_unconfirmed`）にします。

**阻害の照合:** 単語 `blocked` の有無ではなく、カードの状態が `Blocked` であること、または明示的な阻害の項目（`Blocker:` `阻害:` `待ち理由:` などの行や、`blocker` フィールドで、値が `none`・`なし` などでないもの）があることで判定します。「not blocked」は阻害ありとは扱いません。

### `expects_no_card_change` のhash条件
通常、`applied_verified` には「前後hashが両方あり、かつ異なる」ことが必要です（欠落は `unverified`、同一は `content_present_no_recorded_change`）。
`card_assertions.expects_no_card_change: true` のdeltaは、逆に**前後hashが両方あり、かつ同一**であることを必須とします。欠落は `unverified`、変化していれば宣言との不整合として `declaration_inconsistent` で、どちらも `applied_verified` にはなりません。このフラグは、hashに求める条件を変えるだけで、receiptの整合、日時、実カードの内容照合は一切緩めません。

### 本人確認の証拠
packet内の `owner_confirmed_target_task_id` は自己申告であり、本人確認とは扱いません（対象IDの置き換えにも使いません）。確認は、既存の確認記録（`ownerConfirmations`: `event_id`、`task_id`、`confirmed_at`、`basis_id`）との照合で行います。記録がそのeventと、receiptが指す対象タスクを名指しし、有効な `confirmed_at` を持ち、deltaが `source_message_ids` を持つ場合はその1つが `basis_id` と一致するときだけ、確認済みとします。照合材料がなければ `needs_owner_decision` のままです。この部品は確認記録を作らず、読み取りもしません（呼び出し側が既存の記録を渡す）。

### 実処理への接続案（未実施・本人の確認が必要）
更新担当の判定ロジックはこのリポジトリの外（更新ジョブの指示文）にあります。必要な最小変更は次のとおりです。
1. dotが作るpacketに、反映後にカードが満たすべき `card_assertions`（状態・期限・阻害要約）を載せる。既存packetは変更しない。
2. 更新担当の「適用済み」判定を、receiptやhash一致から、**公式CLIでの読戻し結果と `card_assertions` の照合**（`verifyDelta` 相当）に置き換える。`applied_verified` 以外では `applied` と書かない。`unverified` は `received_unapplied` か `pending` にとどめる。
3. 再実行時は `planApply`（event_idと内容fingerprint）で、同一packetの再送を skip、同じevent_idで内容が違えば conflict にする。台帳の手修正で見かけだけ解決しない。
4. 完了済みカードへの追記は、既存の本人確認の記録との照合（`ownerConfirmations`、packet内の自己申告だけでは不可）を必須にする。未承認の新規タスクは作らない。

この変更は更新ジョブの設定変更にあたるため、実施前に本人の確認を取ります。それまで、既存の更新処理の誤判定は直りません。

## 4. 受信口の正本パスの確認手順

プロトコルに記載されたパスと、実際に使われているパスが異なる場合は、次の順で**読み取りだけ**で確認します。原本の移動・複製・書換えで解決しません。
1. 両方のパスの存在、リンク（ジャンクション・シンボリックリンク）の有無、更新担当の参照設定が指すパスを確認する。
2. 受信口の各バッチが記録しているpacketのパスと、実際のファイル、記録されたSHA-256の一致を確認する。
3. 同一実体と言い切れない場合や、hashが一致しないものがある場合は、そこで止めて本人の判断を待つ。再送や変更はしない。
4. 記録のパスを別のパスに読み替えて確認する場合は、`--map <記録の接頭辞>=<実際の接頭辞>` を本人が明示して使う（推測では置換しない）。

## テスト

```
node --test tests/*.test.mjs cloud/tests/*.test.mjs
node tests/integration.mjs
```
