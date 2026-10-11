# 8. 公式出典

**失効した初版の参考資料（2026-10-11）**：この章は撤回済みのKanboard案を記録したもので、現行構成・採用決定・構築指示ではありません。最新の検討状況は [OSS再選定提案](oss-reselection-20261011.ja.md) を参照してください。Backlog.mdは第一候補の提案で、採用未承認・実機未検証です。

確認日：**2026-10-11（UTC）**。公開一次資料のみ。料金・対応版・ライセンスは導入時に再確認する。現在のWeb資料は更新されるため、この一覧は将来の条件を保証しない。

## Kanboard

- S1 [公式README / MIT / maintenance mode](https://github.com/kanboard/kanboard/blob/main/README.md)
- S2 [インストール](https://docs.kanboard.org/v1/admin/installation/)：PHP Webサーバー、data領域、SQLiteの配置。
- S3 [動作要件](https://docs.kanboard.org/v1/admin/requirements/)：Windows、PHP 8.1以上、拡張、小画面、SQLite/DB選択の注意。
- S4 [看板](https://docs.kanboard.org/v1/user/boards/)：標準看板操作。
- S5 [Windows導入](https://docs.kanboard.org/v1/admin/windows/)：Apache/IIS。ページ自体に古い旨の注意がある。
- S6 [セキュリティ](https://docs.kanboard.org/v1/admin/security/)：初期資格情報、data保護、外部公開の防御。
- S7 [Task API](https://docs.kanboard.org/v1/api/task_procedures/)：create/update/reference/状態等。
- S8 [タスク](https://docs.kanboard.org/v1/user/tasks/)：説明、タグ、移動履歴、クローズ。
- S9 [Task metadata API](https://docs.kanboard.org/v1/api/task_metadata_procedures/)：追加情報を扱うAPI。
- S10 [CLI / CSV export](https://docs.kanboard.org/v1/admin/cli/)、[API認証](https://docs.kanboard.org/v1/api/authentication/)、[SQLite](https://docs.kanboard.org/v1/admin/sqlite/)。CSVと完全バックアップは用途が異なる。

## Windows / WSL

- S11 [Microsoft：WSLインストール](https://learn.microsoft.com/en-us/windows/wsl/install)：対応Windows、管理者操作、再起動等。
- S12 [Microsoft：WSLネットワーク](https://learn.microsoft.com/en-us/windows/wsl/networking)：WindowsからLinuxアプリへのlocalhostアクセス、LAN公開との違い。

## 将来のホスティング

- S13 [Vercel Hobby](https://vercel.com/docs/plans/hobby)：個人非商用、上限。
- S14 [Vercel商用利用条件](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)：用途判定。
- S15 [VercelでのSQLite](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)：永続ローカルDBに関する制約。
- S16 [Vercel Functionsの制約](https://vercel.com/docs/functions/limitations)：関数実行の制約。常駐ローカルサーバーの直接移植を前提にしない。
- S17 [Supabase料金](https://supabase.com/pricing)：FreeのDB/Auth容量等。確認時、DB 500 MB/project、MAU 50,000、2 active projects等。
- S18 [Supabase Freeの休止](https://supabase.com/docs/guides/platform/free-project-pausing)：7日間の低DB活動等による休止の条件。
- S19 [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：grantと行単位の所有者制御。
- S20 [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)：publishable keyとsecret/service-roleの区別。
- S21 [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)：標準送信の宛先・頻度・保証の制限。
- S25 [Cloudflare Pages Freeの制限](https://developers.cloudflare.com/pages/platform/limits/)：確認時、500 builds/monthなど。利用条件の承認は別途必要。
- S26 [Supabase backup](https://supabase.com/docs/guides/platform/backups)：Freeでの自前export/別保管推奨。

## 比較候補・ライセンス

- S22 [Vikunja公式README](https://github.com/go-vikunja/vikunja)：本体AGPL-3.0-or-later、desktop GPL-3.0-or-later。有償Proとの区分。
- S23 [Vikunja導入](https://vikunja.io/docs/installing/)、[Windows desktop](https://vikunja.io/docs/desktop-packages/)：API/UIの単一バイナリ、desktopとサーバーの区別。
- S24 [Vikunja API](https://vikunja.io/docs/api-documentation/)、[CLI dump/restore](https://vikunja.io/docs/cli/)：バージョン方針とexport/restore。
- S27 [SQLiteの権利関係](https://sqlite.org/copyright.html)：public domain。
- S28 [Next.js MIT](https://github.com/vercel/next.js/blob/canary/license.md)、[better-sqlite3 MIT](https://github.com/WiseLibs/better-sqlite3)：自作候補のOSS部品例。初版では不採用。

ライセンスはソフトウェアの利用/改変/配布の条件。Vercel、Cloudflare、Supabaseのホストサービスの料金や利用条件とは別である。
