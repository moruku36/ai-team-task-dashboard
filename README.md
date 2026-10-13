# AI Team Task Dashboard

## Current implementation and next design (2026-10-12)

**The official, version-pinned Backlog.md v1.53.0 Windows-local dashboard is running. Private tasks have been imported locally; their contents are absent from this repository. The next design is an owner-private Vercel + Neon dashboard that can be viewed while the Windows PC is off. It has not been provisioned, deployed or migrated.** Review and merge the design first, then build and verify with synthetic data only.

![Current local system and planned private cloud system](docs/images/cloud-architecture.svg)

Start with the **[overall design and Mermaid diagrams (Japanese)](docs/12-cloud-architecture.ja.md)**. The cloud plan uses a new Kanban UI/API and Neon PostgreSQL, rather than hosting Backlog.md itself. It retains the useful status/group/owner organization but does not promise identical UI features. Vercel Authentication with All Deployments is the intended protection; owner-only access across every URL and asset/API route still requires verification. Additional Basic authentication is not adopted. There is no automatic synchronization with the old CLI/MCP store.

The [local MVP architecture](docs/09-backlog-md-architecture.ja.md) and [selection rationale](docs/oss-reselection-20261011.ja.md) describe the existing local implementation, which has no custom UI or REST wrapper. Cloud candidate code is separate and under review; this documentation change contains no candidate implementation.

Validation: [Corrected validation and known reconnect failure](docs/11-validation-20261011.ja.md).

### Usage (PowerShell)

```powershell
.\scripts\Install-Backlog.ps1                     # pinned binary, SHA256-verified, into .runtime\
.\scripts\Initialize-DataRoot.ps1                 # default: %LOCALAPPDATA%\ai-team-task-dashboard\data (-DataRoot to override)
.\scripts\Start-Dashboard.ps1                     # http://127.0.0.1:6420 (--no-open; open the browser yourself)
.\scripts\backlog.ps1 task list --plain         # official CLI with the data root pinned
node tests\integration.mjs                         # synthetic test (temp root only; results saved under results\)
```

The data root must be outside the code repository and any git workspace (otherwise refused); existing config is never modified.

The [Japanese README](README.ja.md) is the main entry point.

- The priority is an end-to-end path: an AI updates a task, storage is verified, and an already-open view reflects the change. Manual transcription is not the normal update path.
- The implementation uses Backlog.md's official CLI/MCP and standard web UI, a shared local task-data root, and one primary owner per task.
- Per-user authentication/RBAC, stale-write rejection through CAS, and actual connectivity from cloud AI tools remain constraints or validation items. They are not presented as solved.
- Local verification includes synthetic CLI/HTTP/WebSocket tests and real DOM/network behavior with headless Chrome. After a disconnect/server restart, the official v1.53.0 UI needs an explicit page reload to restore ongoing updates; health reconnection alone restores one snapshot. No upstream UI/binary patch. Cloud-AI connection, autostart and external deployment remain pending.
- Cloud protection, real database/TLS/concurrency/durability, build output, AI update authentication, retry UX and migration are not complete. Preserve one canonical store and verify protection before separately authorizing private data transfer. Public repository visibility does not imply publishing live task data.

## Superseded initial documents

**The Kanboard selection is superseded by the [Backlog.md MVP architecture](docs/09-backlog-md-architecture.ja.md). All documents below are historical reference material, not the current architecture, an adoption decision or instructions to build.** Full revisions will follow review of the new proposal.

1. [Superseded: requirements and UI](docs/01-requirements-and-ui.md)
2. [Superseded: architecture](docs/02-architecture.md)
3. [Superseded: Kanboard selection ADR](docs/03-adr-oss-selection.md)
4. [Superseded: security and approval boundaries](docs/04-security-and-approval.md)
5. [Superseded: data and API concepts](docs/05-data-and-api.md)
6. [Superseded: deployment and migration](docs/06-deployment-and-migration.md)
7. [Superseded: acceptance tests and backlog](docs/07-acceptance-and-backlog.md)
8. [Superseded: official sources](docs/08-sources.md)

The [task card](examples/task-card.md) and [snapshot JSON](examples/task-snapshot.json) are fictional examples from the old proposal. They are not Backlog.md's native format or the current data contract.

## Repository scope

Local launch/update scripts, tests, current design, historical reference documents and fictional examples only. No live task data, secrets, private conversation history or upstream application code is included. Selecting open-source software does not automatically license this repository's original documents or future extensions; that license remains undecided.

Source review date: 2026-10-11. Recheck supported versions, licenses and pricing conditions before installation. Zero software license fees do not imply zero hosting, maintenance, electricity or existing AI subscription costs.
