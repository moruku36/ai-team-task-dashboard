# AIの共通更新手順

この手順はWindows上の既存CLI経路から呼び出します。dotも許可されたWindows委譲経路で同じスクリプトを呼びます。cloud側からlocalhostへの直結を前提にしません。新しいLLM API、永続MCP登録、資格情報は不要です。

## タスクの作成と更新

以下は合成例です。`-DataRoot` の省略時は全AIが共通の既定rootを使用します。別のrootを採用する場合は全AIで同じ絶対パスを指定してください。

```powershell
.\scripts\backlog.ps1 task create 'Synthetic research' -a synthetic-owner -d 'source: synthetic | next_action: investigate' --plain
.\scripts\backlog.ps1 task view TASK-1 --plain
.\scripts\backlog.ps1 task edit TASK-1 -s 'In Progress' --append-notes 'event_id: synthetic-001 | observed_at: 2026-10-11T00:00:00Z | reported_at: 2026-10-11T00:00:05Z | source: owner-report | next_action: investigate | wait_reason: none'
.\scripts\backlog.ps1 task edit TASK-1 -s 'Awaiting Approval' --append-notes 'event_id: synthetic-002 | source: owner-report | next_action: user decision | wait_reason: scope approval'
.\scripts\backlog.ps1 task edit TASK-1 -s Done --final-summary 'Synthetic result verified'
```

開始、承認依頼、停止、検証、完了の節目で更新します。実際の時刻と根拠を記録し、固定した例の時刻を流用しません。task IDを一度採番したら保存して使い続け、会話タイトルで同一性を推定しません。主担当を一人に限定し、交代時は旧担当へ変更を伝え、新担当が再取得してから更新します。この所有ルールは利用者別RBACで強制されません。

CLIの成功後にtaskを再取得し、ID・主担当・status・notesを照合します。詳細のUpdatedは保存時刻であり、根拠を観測した時刻とは異なります（標準表示は分単位）。観測が古い場合は「未確認」として扱い、画面が接続中でも仕事が最新確認済みとは判断しません。根拠は `owner-report` / `result-verified` / `inferred` / `unknown` を区別します。

`event_id` は既存notesに残す照合用の目印です。重複排除機能ではありません。応答が途切れたときは同じイベントが保存されたかを照合し、task作成・notes追加を盲目的に再送しません。中断後も再取得し、現在の担当と状態を確認して再開します。process終了は完了を意味しません。

同taskへの競合エラーは再取得して主担当に相談し、無条件retryしません。公式lockは短時間のファイル操作を保護し、古い状態の再送は拒否しません。長時間の所有権やrevision検証が必要になったら、全更新経路を集約する追加設計が必要です。

## MCPと表示

登録は未実施です。将来明示的に登録する場合の起動コマンドは、`powershell.exe -NoProfile -File scripts/backlog.ps1 -DataRoot <共通root> mcp start` です（必要なら-ExePathも指定）。wrapperが共通rootとlock環境を固定し、raw stdioを中継します。Windows標準のPowerShell/.NETのみを使い、新しいruntimeは不要です。stdioはローカルclientのための通信で、remote MCP endpointではありません。rootを固定しない起動は使いません。

標準Web画面のhealth接続だけが自動再接続します。server再起動後に接続表示が戻っても、データ通知用接続は閉じたままで継続更新が止まります。**切断・server再起動後はページを明示的に再読込してください**。headless試験では再読込後の次のCLI更新もDOMへ反映しました。task詳細のnotesで最新の観測・報告時刻を確認します。全カードの観測時刻やAIの生存状況を常時表示する機能はMVPに含めません。

## ローカル保存と復旧

タスクデータはno-gitの共通rootにのみ保存し、公開remoteを作りません。秘密・全文会話・私的ログは取り込まず、短いmetadataと権限を変えない根拠リンクだけを記録します。外部公開とWindows再起動時の自動起動は後続段階です。

backup/restoreの設計手順は、全AI writerを停止 → server停止 → 共通root全体を非公開ローカルbackupへコピー → 別のno-git rootへ復元 → CLIとHTTPでID/statusを照合、です。稼働中のファイルコピーや双方向同期は使いません。この手順の実機試験、sleep/OS再起動試験は未実施です。今回の自動試験はserver process再起動を検証しています。
