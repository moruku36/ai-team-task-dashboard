# 20. 現行構成（2026-10-22時点）

言語：[English](20-current-architecture.md) | **日本語**

このページは、このリポジトリの現時点の全体像を示す唯一の最新資料です。docs/01〜12は過去の設計記録で、本ページやコードと食い違う場合は本ページとコードを優先します。図はMermaid（`docs/diagrams/*.mmd`）で記述し、[Pele](https://pele.run/)でSVGに変換しています。`.mmd`を編集したらSVGを再生成してください。

## 全体構成

![本番構成：本人のブラウザ、Vercel保護、静的ファイルとAPI、Neon PostgreSQL](images/system-overview.ja.svg)

- **唯一の正本：** Neon PostgreSQL。1つのドキュメント行を行ロック付きで更新します（`cloud/postgres.mjs`）。ローカルMarkdownは継続更新を終了しています。
- **アクセス制御：** 外側の境界はVercel Deployment Protection（All Deployments）。`cloud/auth.mjs`は既定で拒否し、`cloud/owner-auth.mjs`は検証済みの本人アカウントだけを通します。
- **ボード：** 4状態（To Do／In Progress／Blocked／Done）。旧状態`Awaiting Approval`・`Verifying`で保存済みのカードは、対応する列に旧状態バッジ付きで表示し、自動で完了にはしません（`cloud/model.mjs`）。
- **クォータ表示：** 保存済みスナップショットから作る読み取り専用DTO。鮮度はcurrent／stale／reference／unknownに分類します（`cloud/quota*.mjs`）。保存済みであることは、継続収集中を意味しません。
- **操作ジョブ：** 明示的に承認されたVercel buildが、最大10件のタスク操作を確認・適用できます。詳細は[Web更新手順](17-web-task-operations.ja.md)。

## 更新の流れ

![状態変更：期待する版付きPOST、本人確認、行ロックtransaction、古い版は409、定期再取得](images/update-flow.ja.svg)

## リポジトリ構成

![リポジトリ構成：cloud、api、scripts、tests、docs、examples、vercel.json](images/repo-layout.ja.svg)

| パス | 役割 |
|---|---|
| `cloud/` | 本番Webアプリ・API（静的UIは`cloud/public`、試験は`cloud/tests`、`npm test`で実行） |
| `api/index.mjs` | Vercel関数の入口。`cloud/server.mjs`を再公開 |
| `vercel.json` | build command、`/api/*`のrewrite、セキュリティheader、CSP |
| `scripts/`・`tests/` | 終了済みのローカルBacklog.md関連、表示アダプタ、受領確認、MiMo残高・利用状況ビューア |
| `docs/` | 資料。英語は`name.md`、日本語は`name.ja.md` |
| `examples/` | 合成データのみ |

関連：[資料索引](README.ja.md)／[README](../README.ja.md)
