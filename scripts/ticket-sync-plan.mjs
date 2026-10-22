// One-time ticket sync PLAN (dry-run only). Reads local backlog files and an owner-saved snapshot of GET /api/tasks; never calls the network and never writes tickets.
//   plan  : node scripts/ticket-sync-plan.mjs plan --local <backlog/tasks> --archive <backlog/archive/tasks> --cloud <snapshot.json> --decisions <decisions.json> --out <plan.json>
//   verify: node scripts/ticket-sync-plan.mjs verify --plan <plan.json> --local <backlog/tasks>      (exit 1 when any source file changed since the plan)
// decisions.json: { "date": "20261022", "status": { "TASK-20": "Done" }, "group": { "TASK-20": "完了履歴" }, "create": ["TASK-115"], "hold": { "TASK-1": "reason" } }
// `group` is optional and opt-in per card; groups never change implicitly. Differences are listed in groupMismatches for a decision.
// The plan and any records it writes are real data: keep them OUTSIDE the repository (this script refuses a path inside a git checkout).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, parse } from 'node:path';
import { convertBacklogFiles } from '../cloud/import-snapshot.mjs';
import { taskInput } from '../cloud/model.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const insideCheckout = path => { for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) { if (existsSync(join(dir, '.git'))) return true; if (dir === parse(dir).root) return false; } };
const readDir = dir => (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.endsWith('.md')).map(name => { const bytes = readFileSync(join(dir, name)); return { filename: name, bytes, base64: bytes.toString('base64') }; });
const idOf = file => /^id:\s*(\S+)/m.exec(file.bytes.toString('utf8'))?.[1];

function convertAll(files) {
  const byId = new Map();
  for (const file of files) {
    const id = idOf(file); if (!id) continue;
    // The API accepts at most 100000 characters of body; a longer card is held whole rather than truncated.
    if (file.bytes.toString('utf8').length > 100000) { byId.set(id, { file, error: '本文が100000文字を超えます(切り捨てません)', sha256: sha256(file.bytes) }); continue; }
    try {
      const out = convertBacklogFiles([file]);
      byId.set(id, { file, task: out.board.tasks[0], record: out.records[0], sha256: sha256(file.bytes) });
    } catch (error) { byId.set(id, { file, error: error.message, sha256: sha256(file.bytes) }); }
  }
  return byId;
}

export function buildPlan({ localFiles, archiveFiles = [], cloud, decisions, now = new Date() }) {
  const local = convertAll(localFiles), archived = convertAll(archiveFiles);
  const cloudById = new Map(cloud.tasks.map(task => [task.id, task]));
  const date = decisions.date ?? now.toISOString().slice(0, 10).replaceAll('-', '');
  const plan = { generatedAt: now.toISOString(), cloudRevision: cloud.revision, operations: [], holds: [], notes: [] };
  const hold = (id, reason) => plan.holds.push({ id, reason });
  for (const id of decisions.create ?? []) {
    const source = local.get(id);
    if (!source || source.error) { hold(id, source ? `変換できません: ${source.error}` : 'ローカルに存在しません'); continue; }
    if (cloudById.has(id)) { hold(id, 'クラウドに同じIDが既にあります(作成しない)'); continue; }
    if (source.task.detail.length > 100000) { hold(id, '本文が100000文字を超えます(切り捨てません)'); continue; }
    plan.operations.push({ kind: 'create', requestId: `sync${date}-${id}-create`, expectedVersion: 0, id, from: null, to: { status: source.task.status, group: source.task.group, owner: source.task.owner },
      sourceSha256: source.sha256, sourceFile: source.file.filename, task: taskInput({ id, title: source.task.title, status: source.task.status, owner: source.task.owner, group: source.task.group, detail: source.task.detail, lastConfirmedAt: source.task.lastConfirmedAt }) });
  }
  for (const [id, status] of Object.entries(decisions.status ?? {})) {
    const source = local.get(id), current = cloudById.get(id);
    if (!source || source.error || !current) { hold(id, !current ? 'クラウドに存在しません' : 'ローカルを変換できません'); continue; }
    if (source.task.status !== status) { hold(id, `ローカルの状態(${source.task.status})が決定表(${status})と一致しません`); continue; }
    if (current.status === status && (decisions.group?.[id] ?? current.group) === current.group) { hold(id, '既に同じ状態・表示グループです(変更なし)'); continue; }
    // Only the status changes. The display group changes ONLY when decisions.group names it for this card; owner, title, body and confirmation time stay as the cloud has them.
    const group = decisions.group?.[id] ?? current.group;
    plan.operations.push({ kind: 'status', requestId: `sync${date}-${id}-v${current.version}`, expectedVersion: current.version, id, from: { status: current.status, group: current.group }, to: { status, group },
      sourceSha256: source.sha256, sourceFile: source.file.filename, task: taskInput({ id, title: current.title, status, owner: current.owner, group, detail: current.detail, lastConfirmedAt: current.lastConfirmedAt }) });
  }
  for (const [id, reason] of Object.entries(decisions.hold ?? {})) hold(id, reason);
  const planned = new Set(plan.operations.map(op => op.id)), held = new Set(plan.holds.map(h => h.id));
  plan.cloudOnly = [...cloudById.keys()].filter(id => !local.has(id) && !archived.has(id)).sort();
  plan.localArchivedInCloud = [...archived.keys()].filter(id => cloudById.has(id)).map(id => ({ id, localStatus: archived.get(id).task?.status ?? null, cloudStatus: cloudById.get(id).status, cloudGroup: cloudById.get(id).group })).sort((a, b) => a.id.localeCompare(b.id));
  plan.localOnly = [...local.keys()].filter(id => !cloudById.has(id) && !planned.has(id) && !held.has(id)).sort();
  const opGroup = new Map(plan.operations.map(op => [op.id, op.to.group]));
  plan.groupMismatches = [...local.entries()].filter(([id, v]) => v.task && cloudById.has(id) && v.task.group !== null && v.task.group !== (opGroup.get(id) ?? cloudById.get(id).group))
    .map(([id, v]) => ({ id, local: v.task.group, cloud: cloudById.get(id).group })).sort((a, b) => a.id.localeCompare(b.id));
  plan.doneStillCurrent = {
    cloud: cloud.tasks.filter(t => t.status === 'Done' && t.group === '現行').map(t => t.id).sort(),
    local: [...local.entries()].filter(([, v]) => v.task?.status === 'Done' && v.task.group === '現行').map(([id]) => id).sort() };
  plan.privateRecords = [...local.entries()].filter(([id]) => planned.has(id) || held.has(id)).map(([id, v]) => v.record && { id, ...v.record, sourceSha256: v.sha256 }).filter(Boolean);
  return plan;
}

export function verifyPlan(plan, localFiles) {
  const byFile = new Map(localFiles.map(file => [file.filename, sha256(file.bytes)]));
  return plan.operations.filter(op => byFile.get(op.sourceFile) !== op.sourceSha256).map(op => ({ id: op.id, file: op.sourceFile, reason: byFile.has(op.sourceFile) ? 'changed' : 'missing' }));
}

function args(list) { const out = {}; for (let i = 0; i < list.length; i++) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[++i]; return out; }
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const [mode, ...rest] = process.argv.slice(2), a = args(rest);
  if (mode === 'plan') {
    if (!a.local || !a.cloud || !a.decisions || !a.out) throw new Error('--local --cloud --decisions --out are required');
    if (insideCheckout(a.out)) throw new Error('Refusing to write the plan inside a git checkout');
    const plan = buildPlan({ localFiles: readDir(a.local), archiveFiles: a.archive ? readDir(a.archive) : [], cloud: JSON.parse(readFileSync(a.cloud, 'utf8')), decisions: JSON.parse(readFileSync(a.decisions, 'utf8')) });
    writeFileSync(a.out, JSON.stringify(plan, null, 1), { flag: 'wx' });
    console.log(JSON.stringify({ operations: plan.operations.map(o => `${o.id}:${o.kind}`), holds: plan.holds.map(h => h.id), cloudOnly: plan.cloudOnly.length, groupMismatches: plan.groupMismatches.length }));
  } else if (mode === 'verify') {
    const drift = verifyPlan(JSON.parse(readFileSync(a.plan, 'utf8')), readDir(a.local));
    console.log(JSON.stringify({ drift })); process.exit(drift.length ? 1 : 0);
  } else { console.error('usage: plan | verify'); process.exit(2); }
}
