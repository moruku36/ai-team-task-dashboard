# Web task operations (2026-10-14)

The Web app / Neon document is the sole canonical task store. Retired local Markdown and the local UI are not updated or synchronized. Existing state, quota snapshots and migration archives remain intact.

## Existing authority; no new permanent access

The owner session remains the normal UI/API authorization. For an assistant without access to that browser session, an **already connected, authorized Vercel deployment operator** can explicitly run `cloud/run-task-operator-job.mjs` as a one-job build command in the same production project. Existing DATABASE_URL stays inside Vercel; no API key, new OAuth grant, service account, persistent MCP registration or auth bypass is introduced. This is an administrative deployment operation, not a narrow API token, and requires the existing project's deploy rights and explicit task-change authorization. Ordinary builds never import or execute the operator module.

Each job packages reviewed runtime source plus one private `task-operator-request.json` outside Git. Static build output still contains only index.html, app.js, style.css and favicon.png. Private job source may be retained in the protected Vercel deployment; never enable public source access or place task payloads in public output. The job writes only generic stage/result metadata to logs (IDs, versions, status and digests), not task text or credentials.

## Operator sequence

1. Fetch the exact reviewed commit; verify intended team/project and production target. Keep the request and receipts in a private workspace, never Git. Use `scripts/Export-WebOperatorDeployment.mjs --commit <sha> --job-request <private-path> --output <private-output>`: it changes buildCommand only in that deployment's copy of vercel.json (which takes precedence over API projectSettings). Omit --job-request for the ordinary deployment.
2. Submit an `inspect` job using the existing authenticated Vercel connector. Match by task ID, exact title or supplied HTTPS reference URL. Inspect reports only matching IDs/versions/statuses. Multiple matches require human/agent review; do not create a duplicate.
3. Set `expectedVersion` to the inspected version (0 only when there is no match). Submit an `apply` job. Maximum 10 operations, with an atomic database transaction, CAS and stable unique request IDs. Existing task details are retained and an update note is appended. Other document fields remain untouched.
4. Read the `DASHBOARD_OPERATOR_PROOF` build event: committed revision, task digests and readback success. If the outcome is uncertain, inspect before retrying. Retry the same logical operation with exactly the same request and ID; never invent a second ID to get around an uncertain response. A committed job followed by a build/alias failure is still a committed write.
5. Restore the ordinary `node cloud/build-deployment.mjs` production deployment from the same commit, with no private request or operator modules in the deployment source. Verify READY/alias/protection. The browser refetches Neon within 30 seconds or on Refresh.

Status limitation for cards stored with a legacy status (`Verifying`, `Awaiting Approval`): the job cannot make an explicit status choice. An update that keeps the displayed status leaves the stored legacy status in place, and the job result then carries `storedLegacyStatus` and `statusPersisted: false` (inspect always reports the real stored status). Choosing one of the four statuses stores it; legacy values can never be written.

Use the same established project/environment as the runtime. The job checks the existing Neon project marker and configured owner before storage access; it never initializes schema or bulk imports old state. This route involves build latency and deployment operations per batch. It is a practical authorized assistant route, not an automatic background sync or a publicly callable writing endpoint.

The Web app runs without the user's PC. The cloud connector can run jobs without Windows once it has the public source and private request. This Windows execution workflow needs the PC connected only to prepare/run its local tools; it does not persist any new credentials there. If the Vercel connector is unavailable, or new access is needed, stop and request approval for the exact scope/storage first.

## Synthetic request example

```json
{"mode":"inspect","batch":{"version":1,"operations":[{"requestId":"synthetic_review_001","matchUrl":"https://example.invalid/apply","expectedVersion":0,"task":{"id":"SYNTH-APP","title":"Synthetic application","status":"Blocked","owner":"synthetic-owner","group":"現行","detail":"https://example.invalid/apply\nReply pending; exact send time unknown","lastConfirmedAt":null}}]}}
```

Change `mode` to `apply` only after inspecting the target and setting the correct expected version. Application reply waiting uses Blocked with an explicit external-wait note; Awaiting Approval is reserved for task approval. An application date reported by the user is not an exact send timestamp or acceptance result.

## Reset display

The compact summaries show separate five-hour and weekly windows, where those windows are present in the saved observations. Dates use Asia/Tokyo (JST, UTC+09:00). A fresh, verified future reset gets a countdown; stale snapshots show a historical reference date, expired resets show waiting for refresh, and missing/invalid values stay unknown. Reset means the usage allowance window renews; it does not mean remaining allowance becomes zero. No recurrence is inferred from a single old timestamp. No collectors or new credentials are started by this display change.

The existing sanitized quota DTO supplies per-window `reset_at`, `fresh_until`, observed/collected timestamps and reset validity. Sources: [Codex plan usage](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [Google Antigravity FAQ](https://antigravity.google/docs/faq), and the stored provider observations. The snapshot's Claude fetch failure provides historical rows only; a current Claude reset is not claimed.
