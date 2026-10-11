# AI Team Task Dashboard — Design Proposal

## Current status (2026-10-11)

**The leading candidate is Backlog.md v1.53.0; Vikunja 2.7.0 is the runner-up. This is a reselection proposal, not an approved adoption. It has not been validated on the target Windows machine, and implementation has not started.**

Read the current **[OSS reselection proposal: 13 candidates, update paths and acceptance tests (Japanese)](docs/oss-reselection-20261011.ja.md)**. The [Japanese README](README.ja.md) is the main entry point.

- The priority is an end-to-end path: an AI updates a task, storage is verified, and an already-open view reflects the change. Manual transcription is not the normal update path.
- The leading proposal uses Backlog.md's official CLI/MCP and standard web UI, a shared local task-data root, and one primary owner per task.
- Per-user authentication/RBAC, stale-write rejection through CAS, and actual connectivity from cloud AI tools remain constraints or validation items. They are not presented as solved.
- The next step, after separate approval, is an on-device test with fictional tasks. No installation, connection setup, implementation or external application deployment has been performed.
- Authenticated remote access and an always-on host are later design stages. Public repository visibility does not imply publishing live task data.

## Withdrawn initial documents

**The Kanboard selection has been withdrawn. All documents below are historical reference material, not the current architecture, an adoption decision or instructions to build.** Full revisions will follow review of the new proposal.

1. [Withdrawn: requirements and UI](docs/01-requirements-and-ui.md)
2. [Withdrawn: architecture](docs/02-architecture.md)
3. [Withdrawn: Kanboard selection ADR](docs/03-adr-oss-selection.md)
4. [Withdrawn: security and approval boundaries](docs/04-security-and-approval.md)
5. [Withdrawn: data and API concepts](docs/05-data-and-api.md)
6. [Withdrawn: deployment and migration](docs/06-deployment-and-migration.md)
7. [Withdrawn: acceptance tests and backlog](docs/07-acceptance-and-backlog.md)
8. [Withdrawn: official sources](docs/08-sources.md)

The [task card](examples/task-card.md) and [snapshot JSON](examples/task-snapshot.json) are fictional examples from the old proposal. They are not Backlog.md's native format or the current data contract.

## Repository scope

Design proposals, historical reference documents and fictional examples only. No live task data, secrets, private conversation history or upstream application code is included. Selecting open-source software does not automatically license this repository's original documents or future extensions; that license remains undecided.

Source review date: 2026-10-11. Recheck supported versions, licenses and pricing conditions before installation. Zero software license fees do not imply zero hosting, maintenance, electricity or existing AI subscription costs.
