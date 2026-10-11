# 5. データとAPIの概念

## Phase 1：Kanboard標準データへ写像

| 必要な情報 | 初版の保存先 |
|---|---|
| title / priority / due_at | 標準のタイトル・優先度・期限 |
| status | 列＋待ち理由タグ。候補/保留は別プロジェクト |
| task_owner_ai | `ai:review` 等の役割タグ＋説明の「担当AI」。実ログイン更新者とは区別 |
| next_action | 説明の1行目 |
| evidence_url / current_commit | 説明中のリンクとコミットID |
| last_verified_at / next_check_at | 説明にISO 8601の時刻。表示は利用者のタイムゾーン |
| 検証段階 | 説明の4項目：実装・合成試験・実接続・公開 |
| approval | 説明の待ち内容、scope、pending/approved/expired等、期限 |
| external_id | reference。製品内で一意制約があると仮定しない |
| history | 製品の移動履歴＋重要変更の短いコメント |

記入例は [task-card.md](../examples/task-card.md)。Kanboardにはtask/metadata APIがあるが、この設計独自の項目や厳密な競合制御が標準で備わるという意味ではない。[S7, S8, S9](08-sources.md)

## 更新ルール

- 1件の仕事には1つの安定したexternal_idを割り当てる。タイトル一致だけで同一タスクと判断しない。
- 初版は1人の更新者が順番に処理。本人が直接編集するときは、自動/代理更新を止めてから行う。
- 優先度・scope・完了条件を変更したら、誰が・何を・なぜ変えたかを1コメントに残す。細かな実況は保存しない。
- 不明な内容を推測で完了にしない。根拠がない箇所は `unknown` / 未確認。
- 誤更新は通常の編集で戻し、訂正理由を残す。削除による履歴消去を常用しない。

## Phase 1.5：単一API更新者（必要になったら）

Kanboardの公開JSON-RPC APIを使う。候補：`getTaskByReference`, `getTask`, `createTask`, `updateTask`, `moveTaskPosition`, task metadata取得/更新。JSON-RPCのrequest idは**idempotency keyではない**。

概念上の更新要求：

```json
{
  "schema_version": 1,
  "event_id": "unique-event-id",
  "source": "approved-integration",
  "source_task_id": "stable-task-id",
  "expected_fingerprint": "fingerprint-of-last-read-task",
  "patch": {"next_action": "確認する内容", "status": "verification"}
}
```

処理：受信→形式/権限確認→イベント重複確認→現在値を再取得→古ければ競合を返す→適用→再読込で確認→結果記録。

- `event_id + source` を更新者側の永続台帳に記録。同じID・同じ内容の再送は元の結果を返し、違う内容なら拒否。
- 作成成功後に応答が消失したら、referenceで照合してから再試行。referenceの重複も検出し、人手で解決する。
- API呼出しが複数に分かれれば部分成功し得る。列・説明の両方を再読込して突き合わせる。
- 読込と書込の間の厳密な競合防止を標準APIだけで保証しない。単一更新者の運用を継続し、外れたら自動上書きを停止する。

## Phase 2B：スナップショットの契約

[task-snapshot.json](../examples/task-snapshot.json)は将来のexport/import形式の例であり、Kanboardがそのまま出力するネイティブ形式ではない。小さなexporterを後で作る。

- `schema_version`, `snapshot_id`, `source_instance_id`, `source_revision`, `source_updated_at`, `generated_at`, `tasks[]`。
- `source_updated_at` は出力対象の正本の最終変更時刻、`generated_at` はexport生成時刻。各taskの `last_verified_at` は根拠の確認時刻であり、これらと別。
- `published_at` はimport成功時にサーバーが記録する時刻で、export入力からは信用しない。同一snapshotの再importでは変えない。画面は正本変更時刻・公開反映時刻・taskの確認時刻を分けて表示し、古いexportの取り込みだけで内容を新しく見せない。
- taskの必須：`id`, `title`, `status`, `priority`, `task_owner_ai`, `next_action`, `last_verified_at`。
- nullable：`current_commit`, `next_check_at`, `completed_at`。証跡は配列。URLはtokenを除去し、許可スキームのみ。
- `verification` は4段階ごとに `not_run / passed / failed / not_applicable` と証跡・確認時刻・対象commitを持つ。
- `approval` は `not_required / pending / approved / expired / revoked / unknown`、`explicit_approval_scope`, `evidence_url`, `expires_at`。これは記録用で実行権限ではない。
- exportでは本人の実名や会話を含めず、役割名を使う。承認原文は送らない。

importは本人のみ。DBに `snapshot_id` と内容ハッシュの一意対応を保存し、同一再送を無害にする。`source_revision` が古ければ拒否。新snapshot全体を1トランザクションで検証/保存した後、current pointerを切り替える。失敗時は旧snapshotを維持する。単なるファイル時刻で新旧を決めない。

snapshotは正本の選択的な複製。クラウドで編集した内容をローカルへ戻す双方向同期は作らない。削除・非表示の反映は次の完全snapshotで行い、過去snapshotの保持期間も本人と決める。

## Phase 3：複数AI直接更新を許す場合だけ

全ての書込を同一gatewayに通す。タスクversion付きCAS、イベント一意制約、同一トランザクションの更新+履歴、期限付き担当lease、取り消し/再開、監査を追加する。競合は409相当で拒否して再取得。最終書込勝ちを既定にしない。

本人の標準UIがgatewayを迂回できる状態では整合性を保証できない。Kanboardプラグイン等で全経路を同じ境界へ集めるか、別の実装へ移るADRが必要。この機能は初版と切り離す。
