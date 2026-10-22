# 20. Current architecture (as of 2026-10-22)

Language: **English** | [日本語](20-current-architecture.ja.md)

This page is the single up-to-date map of the repository. Older design documents (docs/01–12) are historical; where they disagree with this page or the code, this page and the code win. The diagrams are written in Mermaid (`docs/diagrams/*.mmd`) and rendered to SVG with [Pele](https://pele.run/); regenerate them after editing the `.mmd` files.

## System overview

![Production system: owner browser, Vercel protection, static assets and API, Neon PostgreSQL](images/system-overview.en.svg)

- **Sole canonical store:** Neon PostgreSQL, one document row updated under a row lock (`cloud/postgres.mjs`). Local Markdown is retired for ongoing updates.
- **Access:** Vercel Deployment Protection (All Deployments) is the outer boundary; `cloud/auth.mjs` denies by default and `cloud/owner-auth.mjs` accepts only the verified owner account.
- **Board:** four statuses (To Do / In Progress / Blocked / Done). Cards saved with the older `Awaiting Approval` or `Verifying` status are shown in the matching column with a legacy badge and are never auto-completed (`cloud/model.mjs`).
- **Quota display:** read-only DTO built from saved snapshots; freshness is classified as current / stale / reference / unknown (`cloud/quota*.mjs`). Saved snapshots do not imply live collection.
- **Operator job:** an explicitly authorized Vercel build can inspect or apply up to 10 task operations. See [Web task operations](17-web-task-operations.md).

## Update flow

![Status change: POST with expected version, owner check, row-locked transaction, 409 on stale version, periodic refetch](images/update-flow.en.svg)

## Repository layout

![Repository layout: cloud, api, scripts, tests, docs, examples, vercel.json](images/repo-layout.en.svg)

| Path | Role |
|---|---|
| `cloud/` | Production web app and API (static UI in `cloud/public`, tests in `cloud/tests`, run with `npm test`) |
| `api/index.mjs` | Vercel function entry; re-exports `cloud/server.mjs` |
| `vercel.json` | Build command, `/api/*` rewrites, security headers and CSP |
| `scripts/`, `tests/` | Retired local Backlog.md tooling, display adapters, receipt verification, MiMo balance and usage viewers |
| `docs/` | Documentation. English: `name.md`; Japanese: `name.ja.md` |
| `examples/` | Synthetic data only |

See also: [Documentation index](README.md) / [README](../README.md).
