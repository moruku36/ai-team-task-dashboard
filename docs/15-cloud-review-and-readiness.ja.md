# クラウド候補のレビュー・受入チェック

2026-10-13。対象は `dddf869` からのローカル修正差分。コード読解と別の攻撃的合成ケースでレビューし、修正後に全21試験と静的buildを実行した。別AI/外部レビュアーの承認や、実ブラウザー/DB/Vercelの証明ではない。

## 修正した指摘

| 重要度 | 箇所 | 問題と修正 | 受入証拠 |
|---|---|---|---|
| 高 | app.js / model.mjs | ID/版が正しいだけの別内容ACKを成功扱いできた。要求の全入力項目を照合し、保存済みreceiptも検査する | wrong ACKの同ID再送、corrupt receipt 503 |
| 高 | app.js | 成功ACK後、同じ古いGETを新しい観測時刻で受理できた。ACK版を読取下限に保持 | post-write stale GETはoffline、正常GETで復帰 |
| 中 | app.js | 同revision改変・タスク版巻戻り/飛躍・古い/未来の観測時刻を受理できた | task版<=revision、変更差<=全体版差、同版内容一致、観測時刻±60秒 |
| 中 | app.js | 詳細を閉じた後に遅い成功応答が選択を復活。別更新後の古い詳細から保存可能 | detail世代/close、二重POST防止、古い詳細は再表示要求 |
| 高 | server.mjs / model.mjs | 保存された未知項目がtasks/receiptのAPI応答へ混入 | 明示wire DTO、合成secret字段除外、不正board 503 |
| 中 | model.mjs / app.js | APIが許す日時とUIが許す日時が不整合。実在しない日もDate.parseで補正され得た | timezone付き実在日時を検証しAPIはUTC正規化 |
| 中 | model.mjs | receiptの継承プロパティを既存要求と誤認、整数上限の加算で版を破損 | Object.hasOwn、MAX_SAFE_INTEGERで409/不変 |
| 高 | build.mjs | sourceファイルの親リンクを確認せず別場所のassetをコピーできた | root/cloud/publicのリンク拒否、合成junction先を出力しない |

合成serverの既定portは6422へ分離した。既存公式6420・残量アダプター6421とは別で、今回常駐起動していない。`PORT`明示時も既存portの使用に失敗すれば終了し、既存processを停止しない。

既存の状態遷移、同ID再送、競合片方409、20,000byte境界、Origin/JSON/header、固定主担当、ACK消失、再接続、設定欠落/読取失敗503、allowlist 3assetsも回帰した。

## 取消・古い状態の契約

詳細を閉じることは送信済み更新の取消ではない。送信後はbusy中の多重保存/別カード選択を止め、閉じた詳細を遅い応答で復活させない。結果が不明なら要求ID/本文を保留して再送し、反映を推測しない。409は新しい要求へ自動変換しない。

不正・古い・不整合なGETでは最後に受理した表示を保持し、接続失敗と示して保存を止める。正常な新しい応答で復帰する。サーバーとブラウザーの時計差が60秒を超える応答も、最新取得の証拠にしない。

## 実環境の残件チェックリスト（未実施）

- [ ] `pg`固定版と全依存の正規取得・lockfile生成・integrity確認。通常sourcebuildのinstall/Node版/Functions依存解決を実際のログで確認。Windows TLS失敗の検証無効化やmirror/承認迂回はしない。
- [ ] 本人承認済みの対象projectとGit連携を正規経路で確認。既存OAuthの403原因は未確定。再認可・新token・権限変更は別判断。
- [ ] All Deploymentsのcontrol plane設定、本人以外のaccess/shared/bypass/Trusted Sources/例外なしを確認。外側保護を無効化するとアプリが自動閉鎖する保証はない。
- [ ] 未認証で静的3assets・API・直接Function・POSTを拒否、認証済み本人だけの閲覧/更新を実証。Origin検証は本人認証の代わりではない。
- [ ] syntheticのみで実Vercel build/trace/outputを検査。`.env`/DB/実タスク/ログ/設計文書/テストが公開assetsに混入しないこと、3assetとFunction経路を確認。
- [ ] 承認済みの隔離DBでschema/接続TLS/最小権限・実row lock・別接続CAS・commit後ACK消失/再送・プロセス再起動後永続化を確認。模擬poolの成功を実DB成功としない。
- [ ] DBのSQL/lock timeout、障害時pool解放と再接続、backup/restoreの版巻戻り・移行epoch、retention1000件外の再送扱いを実証・文書化。
- [ ] 実ブラウザーでログインredirect/期限切れ/close/Escape/多重クリック/隠れたタブ復帰を確認。Node VMはレイアウト/ネイティブdialog操作の証明ではない。
- [ ] reload/タブ終了後に失うpendingMap・ACK版下限の復旧設計。結果不明の更新を新IDで勝手に再送しない。
- [ ] AI委譲の正規認証transportと許可範囲を決定。cookieコピー・bypass token・恒久MCP登録は未実施。
- [ ] 実データ移行は非秘密項目対応・本人承認・バックアップ・切戻し計画を確定してから。現在は合成データのみ、移行なし。

## 判定

ローカル合成候補はレビュー指摘修正と21件回帰を完了。本番公開/移行/認証設定の受入は上記未了。既存ローカルBacklog.mdと残量表示のプロセス・設定にはこのレビューで触れていない。

## オフライン配置前検査

`node cloud/deployment-preflight.mjs`（`npm run check:deployment`）はroot manifest、lockfile v3のpg固定版・公式registry/integrity metadata、Functions入口から使うローカルsource、installed pg入口をオフライン点検する。静的3asset buildの成功とは別で、欠測・版不一致・リンク・不正artifact URLがあれば非0終了する。未知フィールド・credential URLの内容をエラーへ出さない。

この検査を通しても実Vercel dependency trace・推移依存の実行互換性・DB・認証は未検証。実平台build/traceと未認証アクセス拒否の受入は引き続き上のチェックリストに残る。検査はinstall・DB接続・認証・設定・配置を起動しない。

2026-10-13再調査ではroot pg固定は存在し、lockfile/installed driverが欠測。隔離コピー・別々の空npm設定・script無効・公式registryのみでlockfile取得を試みたがTLS alert handshake failure（alert40）で終了。正規artifact/integrity未取得のためlockfileを創作しない。npm設定/TLS検証/認証経路を変更せず、合成のみで検査を検証した。

参考： [公式Node依存仕様](https://vercel.com/docs/functions/runtimes/node-js)、[Functions用Install Commandの制約](https://vercel.com/docs/builds/configure-a-build)、[Functions入口とbuild](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration)。

Vercel候補のbuildCommandは `node cloud/build-deployment.mjs` とし、このオフライン検査の失敗時は静的asset生成へ進まない。`npm run build`/`node cloud/build.mjs` は合成・静的asset検証用に維持する。これはローカル候補のコード変更で、実Vercel project設定や配置には適用していない。
