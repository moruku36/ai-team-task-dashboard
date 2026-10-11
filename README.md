# AI Team Task Dashboard — Windows local MVP

## Current status (2026-10-11)

**A Windows-local MVP on the official, version-pinned Backlog.md v1.53.0 is implemented: no custom UI or REST wrapper. Adoption and implementation were authorized on 2026-10-11. Real task import and external deployment are pending.** Architecture: **[Backlog.md MVP architecture (final, Japanese)](docs/09-backlog-md-architecture.ja.md)**. Selection rationale: [OSS reselection proposal](docs/oss-reselection-20261011.ja.md).

Validation: [32 synthetic checks and measured timings](docs/11-validation-20261011.ja.md).

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
- Verified so far: a synthetic CLI/HTTP/WebSocket test with a temporary root. Not yet done: real data, GUI check, cloud-AI connection, autostart, external publication.
- Authenticated remote access and an always-on host are later design stages. Public repository visibility does not imply publishing live task data.

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
