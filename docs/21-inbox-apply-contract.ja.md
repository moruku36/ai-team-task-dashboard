# 受信箱 → カード適用 → receipt → 公開読み戻しの接続（判定部品）

`scripts/inbox-apply-contract.mjs` は、既存の更新担当が呼び出せる**純粋な判定部品**です。ファイル・台帳・DB・ネットワークを読み書きせず、新しいジョブ・スケジュール・権限・設定も作りません。入力はすべて呼び出し側が渡し、結果は「記録してよい状態」の**提案**です。例はすべて合成です。

## 4つの事実を分けたまま扱う
受信箱へ保存 → 受領（receipt）→ 対象カードへ適用 → 公開画面での読み戻し。前の段階は後の段階の証拠になりません。受信箱への保存やpacketの存在は、カード反映の証拠にしません。

| 関数 | 役割 |
|---|---|
| `parseInbox` | `schema_version=1` と各batchの必須項目の形だけを検証。`application_state` は `unapplied` / `received_unapplied` / `pending` / `conflict` / `applied` を許容し、過去の適用履歴を不正扱いしない。状態の宣言は適用証拠にはしない。パスは開かず、結果にも出さない。batch_idの重複・未知状態は拒否。 |
| `planReception` | packet全体のSHA-256、batch_id、指示時刻、batch_id・event_idの重複、台帳（`planApply`）、既存receiptの同一性を確認。結果は `record_received` / `continue` / `skip_duplicate`（再検証付き）/ `pending` / `conflict` で、`applied` は出ません。 |
| `snapshotCard` | 公開 `/api/tasks` のカード（`detail`）を検証部品のカード形式（`body`）へ。無い・重複・不正は `undefined`（成功にしない）。旧状態は `legacyStatus` を保持。 |
| `decideReceipt` | `verifyDelta` の判定を receipt の状態（`received_unapplied` / `pending` / `conflict` / `applied`）へ。`applied` を提案するのは、受領済み・正式な読み戻し・再計算一致のhash・実際の `applied_at`・本人の記録（`{event_id,task_id,confirmed_at,basis_id}`、`basis_id` が delta の `source_message_ids` に含まれ、`source_instruction_at ≤ confirmed_at ≤ applied_at`）・対象タスク一致・旧状態でない永続状態が**すべて**揃うときだけ。既存の `applied` が裏付けを失えば `flag_downgrade`（黙って維持しない）。同じ入力の再実行は `keep`（書き換えなし）。 |

## 未実装の境界（公開コードだけでは埋められない）
次は推測で実装していません。既存の更新担当（リポジトリ外）の設定本文、または本人の確認が必要です。
1. **deltaからカード変更への写像。** 公開コードで分かるdeltaの項目は `event_id` / `target_id_hint` / `source_message_ids` / `card_assertions` などだけです。メモ本文・状態・期限をどうカードへ書くかは更新担当の指示文にあり、ここには含みません。実際の書き込みは既存の経路（所有者の画面、または明示的なoperator job）が行います。
2. **receiptのhash計算アルゴリズム。** 契約どおりのアルゴリズムは公開されていないため、`hashCard` を呼び出し側が注入します（未指定なら `applied` にはなりません）。docs/19のとおり、receiptを書く側とは独立した経路で計算する必要があります。
3. **receiptと台帳の実体。** 保存場所・追記専用かどうか・書き換え手順・ファイル名規則（CLIは `<receipt_directory>/<event_id>.json` を読む）以外のスキーマは、この部品の対象外です。`decideReceipt` はreceiptを書かず、`action` と提案receiptを返すだけです。
4. **本人の記録の出所と真正性。** 記録の形は確定済みで `decideReceipt` が厳密に照合しますが、記録を誰がどう保存するか(真正性)は呼び出し側の責任です。
5. **本人確認の記録の出所と真正性**（docs/19「更新処理へ接続する前の条件」1〜3）。
6. **実際に2件が受領されていない原因**（更新担当の稼働・権限・参照パスなど、実行時の状態）。

## 接続の最小手順（更新担当の指示文の変更。実施前に本人の確認が必要）
1. 起動時に `parseInbox` → 各batchで `planReception`。`record_received` のeventだけ、`received_unapplied` のreceiptを記録する。
2. 適用は既存経路で行い、`applied` を書く**前**に、候補receiptを `decideReceipt({receipt: 候補, persistedState: 現在の保存状態, card: snapshotCard(公開スナップショット, 対象ID), priorCard, hashCard, ...})` で判定する。`action` が `write` のとき、返された `receipt` だけを記録する。`pending` / `conflict` はその状態のまま記録する。
3. 再実行では、既存receiptを `receipt` として同じ関数に通す。`keep` なら何も書かず、`flag_downgrade` なら人の確認に回す。

## 実保存 receipt との対応
実保存の `before_sha256` / `after_sha256` / `official_cli_readback` は検証器の `before_hash` / `after_hash` / `readback_verified` と形式が異なります。`fromStoredReceipt` は**名前の対応だけ**を行い、`readback_verified` を設定せず、`official_cli_readback` を公開カードの読み戻しとは扱いません(`unmapped` に残す)。検証済みになるには、実バイトからの hash 再計算と `snapshotCard` による読み戻しが別途必要です。

## 本文だけの同期と表示確認

`ticket-sync-plan.mjs` の `decisions.body` に明示したカードだけが本文置換の対象です。状態は別の明示判断がない限り公開側を保持します。IDが同じでも名称が一致しないカードは保留し、名称変更や目的の同一性を機械的に推定しません。既存タイトル・主担当・確認日時は保持し、プレビューには置換前後の文字数と状態・分類変更だけを表示します。

選択した元MarkdownのSHA-256とmtimeの完全一致、送信本文・本文変更サマリのhash整合が必要です。planは30分以内、各カードの`expectedVersion`は取得した公開snapshotのカード版数です。409では後続送信を止めます。2xxだけで適用件数を増やさず、応答カードの全フィールドと版数を照合します。結果不明時は同じrequest IDと内容を保全し、再取得してから判断します。

適用ACKと一覧の再取得は別の証拠です。再取得できなければ画面反映は未確認と表示します。ID・本文検索は全分類を横断し、分類未設定のカードにも到達できます。分類未設定は引き続き未分類であり、自動的に現行へ移しません。

本変更は合成回帰203件と静的buildで確認しました。実ownerセッションでの公開適用、正本のreceipt修復、更新ジョブへの接続、残量の再収集・送信は行っていません。実運用への接続には、配信版との一致、最新認証済みsnapshot、hashの対象と本人確認記録を提供する呼出側の確認が残ります。

送信直前に公開一覧の再取得を必須とし、版数・変更前状態/分類・保持項目・置換前本文hashを照合します。状態変更に本文変更が混在したプランは送信前に拒否します。
