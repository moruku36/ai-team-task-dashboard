# Gemini 4 Argon 週間枠の分離表示と盤面の整理

ローカル表示（`scripts/usage-display.js` ほか）の改修メモ。実データ・アカウント情報・個人パスは含みません。テストはすべて合成値です。

## 1. 目的
- AG Gemini の共有枠（5h・週間）と、Gemini 4 Argon 専用の週間枠を **別々の値** として表示する。Argon を `gemini_shared` に二重計上しない。
- MiMo の従量課金残高（金額＋通貨）を、残率とは別のカードに表示する。通信失敗時も「前回参考」として保持する。
- 残量カードの右側の余白を詰め、「Awaiting Approval」列を畳んで右側の列を見やすくする（タスク・ステータス・保存データは変更しない）。

## 2. Argon の入力形式（`dashboard-usage.json` の Antigravity カード）
```json
"argon_weekly": {
  "limit_id": "gemini_4_argon_weekly",
  "percent": 0,
  "percent_basis": "remaining",
  "observed_at": null,
  "reset_at": "2026-01-01T00:00:00Z"
}
```
（値は書式の例です。）`last_known_argon_weekly` も同じ形式で、前回の有効値を別に持てます。

| 項目 | 規則 |
|---|---|
| `limit_id` | `gemini_4_argon_weekly` と一致しない項目は無視する（Argon を位置や名前の推測で決めない） |
| `percent` / `percent_basis` | 0〜100 の数値と、`remaining`（残率）か `used`（使用率）の明示が必須。基準が無い値は数値を出さない |
| `reset_at` | 絶対時刻。供給された場合のみ、通過・遠すぎる値を現在値として扱わない |
| `reset_in_seconds`（相対） | 丸め規則が未確認のため、**概算・精度未確認** の参考表示のみ。確定時刻や期限判定には使わない。0 超かつ 605,100 秒（604,800＋300）以下のみ有効で、範囲外・不正型は Argon の項目だけを欠測にする |
| `observed_at` | CLI が提供しない場合は null のまま。受信時刻はカードの `collected_at` として別に扱う |

- 保存から 1 時間超、リセット通過、アカウント不一致、取得失敗では現在値にしない。履歴として残る値は「参考」と明記する。
- 入力が無い間は「Argon週 —（未確認）」。5 時間値からの計算や Claude/GPT 枠への流用は行わない。

## 3. 収集側との対応（リポジトリ外の私的な収集処理）
収集処理はこのリポジトリに含まれません。表示側は上記の `argon_weekly` を受け取るだけです。参考として、agy 1.4.x の `/usage` 出力の対応は次のとおりです。

| agy の項目 | 意味 |
|---|---|
| グループ名 `Gemini 4 Argon` ＋ バケット ID `gemini-argon-wtu-weekly` の完全一致の組 | Argon 週間枠（位置・順序は使わない） |
| `remaining_fraction`（旧 `remainingFraction`） | 残率（0〜1） |
| `reset_time`（旧 `resetTime`） | 絶対時刻 |
| `disabled` | キー無しは「未報告」。無いだけで無効・0・満額とは扱わない |

## 4. 盤面の表示
- 「Awaiting Approval」列: 0 件なら非表示、1 件以上なら細い帯「承認待ち N件」に畳み、ボタン（`aria-expanded`）で再展開する。列の中身は DOM に残り、タスク・ステータス・保存データは変更しない。
- 残量カードは内容幅で並べ、狭い幅では折り返す。右側の列は広い画面で空き幅を使い、狭い画面では横スクロールで到達できる。ライト／ダークとも文字のコントラストを確保。

## 5. テスト
```
node --test tests/usage-metadata.test.mjs tests/status-display.test.mjs tests/usage-mimo-argon.test.mjs tests/board-layout.test.mjs
node --test cloud/tests/*.test.mjs
```
`tests/board-layout.test.mjs` は、`scripts\Install-Backlog.ps1` で入れる固定バイナリのコピーと Chrome（`CHROME_PATH` で指定可）を使い、隔離した一時データとループバックだけで動きます。前提が無い場合は失敗し、黙ってスキップしません。
