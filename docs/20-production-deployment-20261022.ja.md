# Git 連携と本番反映の記録（2026-10-22 JST）

PR #12 の変更を、既存の Vercel プロジェクト `ai-team-task-dashboard` に本番反映しました。アプリコードは既に GitHub へ push 済みであり、今回のコミットで追加するのはこの運用記録のみです。

## 配信結果

| 項目 | 確認内容 |
|---|---|
| 配信元 | [PR #12](https://github.com/moruku36/ai-team-task-dashboard/pull/12) マージ後の `main` |
| コミット | `8f63687fe37a4df2943ba4fd215e5107a8442140` |
| 新規本番配信 ID | `dpl_CPSK23WcYcv1R2opqct5vf6D9jAe` |
| 本番 URL | https://ai-team-task-dashboard.vercel.app/ |
| 配信状態 | `READY` / `Production` |
| alias | 本番 URL と `ai-team-task-dashboard-git-main-moruku36s-projects.vercel.app` の割当てを確認 |

既存の GitHub 認可の範囲で、Vercel の既存プロジェクトを `moruku36/ai-team-task-dashboard` に接続しました。接続時点の `main` が上記コミットと一致することを確認し、その SHA を指定して新規本番配信を作成しました。今後は Git 経由で配信できます。

## 保持した設定と確認範囲

- ビルド設定は保持しました。Framework は `Other`、Root はリポジトリ直下（`./`）、Build は `node cloud/build-deployment.mjs`、Output は `dist/public`、Install は `npm install --ignore-scripts` です。
- 手動転送で対象コードと一致しなかった旧 preview は、本番反映に使用していません。
- 本番画面で `To Do` / `In Progress` / `Blocked` / `Done` の四列表示を確認しました。
- 助手は実タスクと残量値を未確認です。所有者はダッシュボードの表示を確認し、今回の動作確認を一区切りとしました。残量値の保持を含む、認証後の詳細な表示検証は完了扱いにしていません。
- 今回の配信作業では、実データ・DB・環境変数・ジョブを変更していません。
