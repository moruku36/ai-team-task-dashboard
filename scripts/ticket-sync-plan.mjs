// One-time ticket sync PLAN (dry-run only). Reads local backlog files and an owner-saved snapshot of GET /api/tasks; never calls the network and never writes tickets.
//   plan  : node scripts/ticket-sync-plan.mjs plan --local <backlog/tasks> --archive <backlog/archive/tasks> --cloud <snapshot.json> --decisions <decisions.json> --out <plan.json>
//   verify: node scripts/ticket-sync-plan.mjs verify --plan <plan.json> --local <backlog/tasks>      (exit 1 when any source file changed since the plan)
// decisions.json: { "date": "20261022", "status": { "TASK-20": "Done" }, "group": { "TASK-20": "完了履歴" }, "create": ["TASK-115"], "hold": { "TASK-1": "reason" } }
// `group` is optional and opt-in per card; groups never change implicitly (for a new card too: without it a created card stays 未分類). Differences are listed in groupMismatches for a decision.
// `body` (optional list of IDs, opt-in per card): copy the LOCAL body over the cloud body even when the status is unchanged. Without it the cloud body is never touched.
//   A body-only difference is otherwise invisible to this planner, because status/group are the only fields it compares.
// The plan and any records it writes are real data: keep them OUTSIDE the repository (this script refuses a path inside a git checkout).
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, parse } from 'node:path';
import { convertBacklogFiles } from '../cloud/import-snapshot.mjs';
import { taskInput, publicTask } from '../cloud/model.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const insideCheckout = path => { for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) { if (existsSync(join(dir, '.git'))) return true; if (dir === parse(dir).root) return false; } };
const readDir = dir => (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.endsWith('.md')).map(name => { const bytes = readFileSync(join(dir, name)); return { filename: name, bytes, base64: bytes.toString('base64'), mtimeMs: statSync(join(dir, name)).mtimeMs }; });
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

// The cloud snapshot must be an owner-saved GET /api/tasks result: expectedVersion is each target card's own `version` from it (never the board revision, never a file mtime),
// and "absent" (a create's expectedVersion 0) is only ever concluded from a well-formed snapshot. Anything else is refused whole.
function checkCloud(cloud) {
  let ok = cloud && typeof cloud === 'object' && !Array.isArray(cloud) && Number.isSafeInteger(cloud.revision) && cloud.revision >= 0 && Array.isArray(cloud.tasks) && cloud.tasks.length <= 1000 && new Set(cloud.tasks.map(t => t?.id)).size === cloud.tasks.length;
  if (ok) try { ok = cloud.tasks.every(t => { publicTask(t); return typeof t.detail === 'string' && t.version <= cloud.revision; }); } catch { ok = false; }
  if (!ok) throw new Error('クラウドのスナップショットが不正です(GET /api/tasks の結果を保存したものだけ使えます)');
}
export function buildPlan({ localFiles, archiveFiles = [], cloud, decisions, now = new Date() }) {
  checkCloud(cloud);
  if (decisions.body !== undefined && (!Array.isArray(decisions.body) || decisions.body.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('body は対象IDの配列で指定してください');
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
    // The display group comes from the local `表示:` label; decisions.group names it explicitly (opt-in, validated by taskInput) when the label is absent. Nothing is guessed.
    const group = decisions.group?.[id] ?? source.task.group;
    plan.operations.push({ kind: 'create', requestId: `sync${date}-${id}-create`, expectedVersion: 0, id, from: null, to: { status: source.task.status, group, owner: source.task.owner },
      sourceSha256: source.sha256, sourceFile: source.file.filename, sourceMtimeMs: Math.floor(source.file.mtimeMs) || null, task: taskInput({ id, title: source.task.title, status: source.task.status, owner: source.task.owner, group, detail: source.task.detail, lastConfirmedAt: source.task.lastConfirmedAt }) });
  }
  const bodyIds = new Set(decisions.body ?? []);
  for (const id of new Set([...Object.keys(decisions.status ?? {}), ...bodyIds])) {
    const source = local.get(id), current = cloudById.get(id), decided = decisions.status?.[id];
    if (!source || source.error || !current) { hold(id, !current ? 'クラウドに存在しません' : 'ローカルを変換できません'); continue; }
    // An ID collision is not identity evidence for copying an entire body. Renames need a separate reviewed decision.
    if (bodyIds.has(id) && source.task.title.normalize('NFKC').trim() !== current.title.normalize('NFKC').trim()) { hold(id, '名称が一致しません。本文同期前にタスクの目的・同一性を確認してください'); continue; }
    if (decided !== undefined && source.task.status !== decided) { hold(id, `ローカルの状態(${source.task.status})が決定表(${decided})と一致しません`); continue; }
    // Status: the decision when one is given, otherwise the cloud's (a body-only sync never changes the status).
    const status = decided ?? current.status, group = decisions.group?.[id] ?? current.group;
    const bodyChanged = bodyIds.has(id) && source.task.detail !== current.detail;
    if (current.status === status && group === current.group && !bodyChanged) { hold(id, bodyIds.has(id) ? '状態・表示グループ・本文とも同一です(変更なし)' : '既に同じ状態・表示グループです(変更なし)'); continue; }
    // Only status/group (and the body, when `body` names this card) change. Owner, title and confirmation time stay as the cloud has them.
    // A body update's request ID carries the source hash: the same logical change replays safely, a different body can never reuse an earlier ID.
    // A content operation carries a body-change summary (character counts and hashes only, never the text) so the apply preview can state it; the old status is kept unless a decision says otherwise.
    const bodyChange = bodyChanged ? { fromChars: current.detail.length, toChars: source.task.detail.length, fromSha256: sha256(Buffer.from(current.detail)), toSha256: sha256(Buffer.from(source.task.detail)) } : undefined;
    plan.operations.push({ kind: bodyChanged ? 'content' : 'status', ...(bodyChange ? { bodyChange } : {}), requestId: `sync${date}-${id}-v${current.version}${bodyChanged ? `-b${source.sha256.slice(0, 12)}` : ''}`, expectedVersion: current.version, id, from: { status: current.status, group: current.group }, to: { status, group },
      sourceSha256: source.sha256, sourceFile: source.file.filename, sourceMtimeMs: Math.floor(source.file.mtimeMs) || null, task: taskInput({ id, title: current.title, status, owner: current.owner, group, detail: bodyChanged ? source.task.detail : current.detail, lastConfirmedAt: current.lastConfirmedAt }) });
  }
  for (const [id, reason] of Object.entries(decisions.hold ?? {})) hold(id, reason);
  const planned = new Set(plan.operations.map(op => op.id)), held = new Set(plan.holds.map(h => h.id));
  plan.cloudOnly = [...cloudById.keys()].filter(id => !local.has(id) && !archived.has(id)).sort();
  plan.localArchivedInCloud = [...archived.keys()].filter(id => cloudById.has(id)).map(id => ({ id, localStatus: archived.get(id).task?.status ?? null, cloudStatus: cloudById.get(id).status, cloudGroup: cloudById.get(id).group })).sort((a, b) => a.id.localeCompare(b.id));
  plan.localOnly = [...local.keys()].filter(id => !cloudById.has(id) && !planned.has(id) && !held.has(id)).sort();
  const opGroup = new Map(plan.operations.map(op => [op.id, op.to.group]));
  plan.groupMismatches = [...local.entries()].filter(([id, v]) => v.task && cloudById.has(id) && v.task.group !== null && v.task.group !== (opGroup.get(id) ?? cloudById.get(id).group))
    .map(([id, v]) => ({ id, local: v.task.group, cloud: cloudById.get(id).group })).sort((a, b) => a.id.localeCompare(b.id));
  // Cards whose LOCAL body differs from the cloud body while nothing is planned for them: listed (ID and sizes only) so a decision can name them in `body`. Nothing is applied by this list.
  plan.bodyDifferences = [...local.entries()].filter(([id, v]) => v.task && cloudById.has(id) && !planned.has(id) && v.task.detail !== cloudById.get(id).detail)
    .map(([id, v]) => ({ id, localChars: v.task.detail.length, cloudChars: cloudById.get(id).detail.length, sameStatus: v.task.status === cloudById.get(id).status })).sort((a, b) => a.id.localeCompare(b.id));
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
    console.log(JSON.stringify({ operations: plan.operations.map(o => `${o.id}:${o.kind}`), holds: plan.holds.map(h => h.id), cloudOnly: plan.cloudOnly.length, groupMismatches: plan.groupMismatches.length, bodyDifferences: plan.bodyDifferences.length }));
  } else if (mode === 'verify') {
    const drift = verifyPlan(JSON.parse(readFileSync(a.plan, 'utf8')), readDir(a.local));
    console.log(JSON.stringify({ drift })); process.exit(drift.length ? 1 : 0);
  } else { console.error('usage: plan | verify'); process.exit(2); }
}
