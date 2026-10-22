# AI Team Task Dashboard

Language: **English** | [日本語](README.ja.md)

A personal dashboard for tracking work shared with AI assistants: what is active, awaiting approval, blocked or finished, and whether saved quota information is still usable.

## Phase 1 complete — 2026-10-14

**The owner signed in, checked the new production UI and accepted Phase 1 as complete.** The Windows-local foundation and the owner-only Vercel + Neon dashboard are implemented. The next phase is a set of development candidates, not an approved implementation schedule.

- Task board with six statuses, one primary owner per task, search, details and the current / inventory / completion-history groups.
- Owner-only sign-in, Vercel protection across all deployments, and private state in Neon PostgreSQL. The cloud board can be viewed while the Windows PC is off.
- Private task migration with readback verification. Live tasks, histories and credentials are excluded from this public repository.
- Cloud updates use version checks (CAS) and request replay protection; the UI refetches every 30 seconds and after saves, and shows connection/update times.
- Compact header, reused local favicon, provider colors and remaining-quota summaries. Details start collapsed and retain state/focus across refresh. Unknown, actual zero and historical reference values are distinct; Antigravity shared pools are separate.
- Synthetic integration and headless-browser checks, including 15 checks for the final compact UI/build/quota/auth compatibility change. [PR #4](https://github.com/moruku36/ai-team-task-dashboard/pull/4) delivered the production update; owner screen confirmation followed.

Saved quota snapshots do **not** imply ongoing collection. Collectors were not restarted by this work; old observations remain references. Automated cloud-AI updates, historical analytics and continuous usage monitoring are not Phase 1 deliverables.

## Current operating policy — Web only

The Web app / Neon is the sole canonical task store. Local Markdown and the local UI are retired for ongoing updates. Use the existing owner Web session, or the explicitly authorized Vercel operator job described in [Web task operations](docs/17-web-task-operations.md). It reuses the existing connected deployment authority and production DB settings without new credentials. No local sync or background automation is started.

Reset summaries now show per-window JST dates/countdowns when observations are fresh; missing or stale resets remain unknown/reference.

## Foundation: Backlog.md

The adopted OSS is **[Backlog.md](https://github.com/MrLesk/Backlog.md/tree/v1.53.0), by MrLesk**, pinned to v1.53.0 (MIT). Its official Windows executable supports Markdown tasks, a CLI, MCP, a terminal Kanban board, a local web board, search, assignees, labels, priorities, milestones, dependencies and acceptance/DoD checklists. Git is optional through no-git mode. See the [selection record](docs/oss-reselection-20261011.ja.md) (Japanese).

The local installation uses the official CLI/MCP and web UI over a shared no-git data root outside this repository. File watch → WebSocket → UI provides local updates. The cloud version is this repository's own UI/API with Neon as its canonical store; it does not host Backlog.md or inherit every OSS feature. There is **no automatic synchronization with the old CLI/MCP data root**. Existing local scripts operate on the local store.

### What the OSS already offers

The v1.53.0 statistics implementation and official overview command provide a useful local starting point:

| Native capability | Meaning and limit |
|---|---|
| Status/priority counts and completion percentage | A current snapshot of loaded tasks, not a weekly completion trend |
| Recent activity | Recently created/updated tasks within seven days; not an execution log |
| Stale-task suggestions | Unfinished tasks with no update for over 30 days; not time spent in a particular status |
| Dependency blocking | Unfinished tasks with a loaded, unfinished dependency; separate from this dashboard's manual Blocked status |
| Average task age | Creation to now for active tasks; creation to latest update for Done tasks. This proxy is not measured start-to-finish cycle time |
| Assignee filtering and Markdown board export | Helps review workload and share a board; does not measure AI runtime or quota |

These are **OSS/local capabilities**, not analytics already added to the cloud dashboard. Snapshot counts depend on the loaded task set; they should not be treated as lifetime totals across archived data.

## Phase 2 and beyond: candidates

For one person, analytics can answer “what is stuck?” and “where should the next AI session go?” without turning task counts into a performance ranking.

| Candidate | What would need to be added |
|---|---|
| Phase 2: workload and stale-task view | Cloud aggregation by status/primary owner and an explicitly named “time since last update” indicator. Reuse OSS definitions where appropriate; publish scope, threshold and missing-data labels |
| Phase 2: status dwell and approval wait | Reliable timestamped transitions, including entry/exit, reopen and paused intervals. Latest update time alone cannot establish status dwell |
| Phase 2: cycle time and completion trends | Agreed start/completion semantics and durable events; per-period completions, median/range and data-coverage dates. Creation-to-update age cannot substitute for actual start-to-completion time |
| Later: AI assignment and activity | Owner counts are possible from task fields; actual runs, durations, outcomes and failures need separately recorded execution events. Assignment is not proof of activity or utilization |
| Later: quota history and planning | Authorized collection, observation/reset timestamps and retention rules; preserve freshness and separate Antigravity pools. Saved snapshots cannot establish consumption rates or per-model allocations |
| Later: controlled AI updates and reporting | An authenticated update path, durable idempotency/retry handling and optional private summaries. Backlog.md MCP availability alone does not connect a cloud assistant to Windows; dot is expected to update through a Windows delegated CLI |

The current cloud audit keeps at most 1,000 mutation events; imported historical text and latest task timestamps are not a complete structured transition/run history. Metrics without the necessary observations must stay **unknown**, with coverage disclosed. No historical durations, AI utilization or completion trend has been calculated or shipped here. Priorities, scope and costs require a separate decision before implementation; no new paid service is assumed.

## Where updates go today

| Action | Actual destination |
|---|---|
| Official local CLI/MCP creates or edits a task | Shared local Markdown only; the local web board watches those files |
| Signed-in owner opens a cloud card and saves its status (including Done) | Same-origin POST /api/tasks → owner authorization → version-checked Neon transaction → cloud refetch |
| Cloud task creation or broader edits | The protected API has a create/update contract, but the current UI only exposes status editing. The existing authenticated Vercel operator job can add/update tasks; a browser creation form is not wired |
| Browser's 30-second refresh | Reads the cloud DB; does not read or synchronize Windows files |

The initial private import was a one-time migration. No scheduled local-to-Neon writer is configured in this repository or was started by Phase 1. Later local CLI updates can therefore diverge from the cloud board. Authorized assistants can use the explicit operator-job workflow; it is not an automatic background sync. Do not keep two competing canonical stores or repeat a bulk import over cloud edits.

## Historical local usage (not the current update path)

```powershell
.\scripts\Install-Backlog.ps1                 # pinned v1.53.0 binary, SHA256 verified
.\scripts\Initialize-DataRoot.ps1             # %LOCALAPPDATA%\ai-team-task-dashboard\data
.\scripts\Start-Dashboard.ps1                 # http://127.0.0.1:6420; --no-open
.\scripts\backlog.ps1 task list --plain
.\scripts\backlog.ps1 overview                 # official local statistics TUI
node tests\integration.mjs                     # synthetic tasks in a temporary root
```

The data root must be outside the code repository and any Git workspace; scripts refuse an unsafe location and preserve existing configuration. The official v1.53.0 local UI requires an explicit page reload after disconnect/server restart to restore ongoing updates; upstream binaries/UI are unmodified. See [validation and reconnect limits](docs/11-validation-20261011.ja.md) (Japanese).

## Design and references

- [Cloud architecture — English](docs/12-cloud-architecture.md) / [日本語](docs/12-cloud-architecture.ja.md): design-stage background; its pre-deployment status notes are historical. The completion status above is current.
- [Current architecture and diagrams](docs/20-current-architecture.md) / [Documentation index](docs/README.md)
- [Local MVP architecture](docs/09-backlog-md-architecture.ja.md) / [AI update protocol](docs/10-agent-update-protocol.ja.md) (Japanese only).
- Earlier Kanboard documents (docs/01–08, Japanese only) and [old examples](examples/task-card.md) are superseded historical material, not the current architecture or native data format.

Official sources checked against tag v1.53.0 on 2026-10-14 (source commit fd20f71493fb4eda44b021aa89f257956f17fb71):

- [Backlog.md v1.53.0 README](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/README.md)
- [Official CLI reference](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/CLI-INSTRUCTIONS.md)
- [Statistics calculation](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/core/statistics.ts) / [overview command](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/commands/overview.ts)
- [Official web statistics view](https://github.com/MrLesk/Backlog.md/blob/v1.53.0/src/web/components/Statistics.tsx)

## Repository boundary

Public code, configuration examples, tests, diagrams and documentation only. Private task state stays outside Git locally or in the protected cloud database. No private conversations or credentials belong here. Backlog.md is MIT-licensed; this repository's original documents/code have no selected project license yet. Free resource tiers do not guarantee zero future hosting, maintenance or existing AI subscription costs.
