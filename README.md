# AI Team Task Board — Design Only

## Current status (updated 2026-10-11)

**The initial Kanboard selection has been withdrawn. We are reassessing open-source options that are easier for AI agents to update. Implementation has not started.**

The material below and in docs/ is retained as a record of the withdrawn initial proposal. It is not a current selection decision or an instruction to build. No replacement has been selected, and no implementation, installation or deployment has been performed.

## Withdrawn initial proposal (for reference)

Recommended first step: **Kanboard (MIT), local on Windows**, using its standard UI, short task descriptions and evidence links. Use one designated writer; do not build a custom application or autonomous-agent control system for the MVP.

The main design is in Japanese: [README.ja.md](README.ja.md).

## Scope

- Design documents and fictional examples only. Nothing is installed, deployed or connected.
- Local-only Kanboard + PHP + SQLite, preferably in an existing WSL2 environment. No public tunnel or LAN exposure.
- Later: move the same stack to an always-on host, or create an authenticated read-only cloud snapshot if zero additional monthly cost takes priority.
- A task status is never authorization to perform a consequential action.
- Vercel is an optional frontend host, not a durable local-SQLite/PHP-server deployment target.
- Free hosting tiers have eligibility, quota and availability limits. No perpetual-free or always-on promise.

## Documents

1. [Requirements and UI](docs/01-requirements-and-ui.md)
2. [Architecture](docs/02-architecture.md)
3. [OSS selection ADR](docs/03-adr-oss-selection.md)
4. [Security and approval boundaries](docs/04-security-and-approval.md)
5. [Data and API concepts](docs/05-data-and-api.md)
6. [Deployment and migration](docs/06-deployment-and-migration.md)
7. [Acceptance tests and backlog](docs/07-acceptance-and-backlog.md)
8. [Official sources](docs/08-sources.md)

Reviewed against public official documentation on 2026-10-11. The repository does not contain upstream application code or live user task data. The license for any newly written extension must be explicitly selected before distribution; adopting MIT-licensed Kanboard does not automatically license this repository.
