import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { app, FixtureStore, env } from './fixtures.mjs';
import { buildPlan, verifyPlan } from '../../scripts/ticket-sync-plan.mjs';

// Synthetic tickets only. Local files are Backlog-style markdown; the cloud side is a GET /api/tasks-shaped snapshot.
const md = (id, status, { assignee = ['@synthetic'], labels = ['表示:現行'], updated = "'2026-10-20 09:00'", body = 'local body' } = {}) =>
  `---\nid: ${id}\ntitle: 'Synthetic ${id}'\nstatus: ${status}\n${assignee.length ? `assignee:\n${assignee.map(a => `  - '${a}'`).join('\n')}\n` : 'assignee: []\n'}${labels.length ? `labels:\n${labels.map(l => `  - '${l}'`).join('\n')}\n` : 'labels: []\n'}created_date: '2026-10-11 09:00'\n${updated ? `updated_date: ${updated}\n` : ''}---\n## Description\n${body}\n`;
const PLAN_TIME = Date.now(), file = (id, text) => { const bytes = Buffer.from(text); return { filename: `${id}.md`, bytes, base64: bytes.toString('base64'), mtimeMs: PLAN_TIME - 3600000 }; };
const cloudTask = (id, status, version, over = {}) => ({ id, title: `Cloud title ${id}`, status, owner: 'cloud-owner', group: '現行', detail: `CLOUD BODY ${id}`, lastConfirmedAt: null, version, updatedAt: '2026-10-15T00:00:00.000Z', ...over });
const local = [file('T-1', md('T-1', 'Done', { labels: ['表示:完了履歴'] })), file('T-2', md('T-2', 'Done')), file('T-3', md('T-3', 'In Progress')), file('T-4', md('T-4', 'Done')),
  file('N-1', md('N-1', 'In Progress')), file('N-2', md('N-2', 'To Do', { assignee: [], labels: [], updated: null })), file('N-3', md('N-3', 'To Do', { body: 'x'.repeat(100001) })),
  file('H-1', md('H-1', 'Done')), file('S-1', md('S-1', 'Done')), file('E-1', md('E-1', 'Done', { labels: ['表示:現行'] }))];
const archive = [file('A-1', md('A-1', 'Done'))];
const cloud = { revision: 9, tasks: [cloudTask('T-1', 'In Progress', 3), cloudTask('T-2', 'To Do', 2), cloudTask('T-3', 'To Do', 1), cloudTask('T-4', 'Done', 4), cloudTask('H-1', 'Blocked', 1), cloudTask('S-1', 'Done', 5, { group: '完了履歴' }),
  cloudTask('E-1', 'Done', 6, { group: '現行' }), cloudTask('A-1', 'Done', 7), cloudTask('C-ONLY', 'To Do', 8, { owner: '' })] };
const decisions = { date: '20261022', create: ['N-1', 'N-2', 'N-3'], status: { 'T-1': 'Done', 'T-2': 'Done', 'T-3': 'In Progress', 'T-4': 'Done', 'MISSING-1': 'Done' }, group: { 'T-1': '完了履歴' }, hold: { 'H-1': '本人確認待ち' } };
const NOW = new Date();
const plan = buildPlan({ localFiles: local, archiveFiles: archive, cloud, decisions, now: NOW });

test('plan: creates, status-only updates, holds and untouched cards are separated; nothing is guessed or truncated', () => {
  const ops = Object.fromEntries(plan.operations.map(op => [op.id, op]));
  assert.deepEqual(Object.keys(ops).sort(), ['N-1', 'N-2', 'T-1', 'T-2', 'T-3']);
  assert.deepEqual([ops['N-1'].kind, ops['N-1'].expectedVersion], ['create', 0]);
  assert.deepEqual([ops['N-2'].task.owner, ops['N-2'].task.group], ['', null], 'unset stays unset');
  assert.ok(plan.holds.find(h => h.id === 'N-3' && /100000/.test(h.reason)), 'over-limit body is held, never truncated');
  assert.ok(plan.holds.find(h => h.id === 'MISSING-1'));
  assert.ok(plan.holds.find(h => h.id === 'H-1' && h.reason === '本人確認待ち'));
  assert.ok(plan.holds.find(h => h.id === 'T-4' && /変更なし/.test(h.reason)), 'already equal is a no-op');
  // status op: only status (+ the local display group) change; the cloud body/title/owner are kept
  const t2 = ops['T-2'].task; assert.deepEqual([t2.status, t2.owner, t2.title, t2.detail, t2.group], ['Done', 'cloud-owner', 'Cloud title T-2', 'CLOUD BODY T-2', '現行']);
  assert.deepEqual(ops['T-1'].to, { status: 'Done', group: '完了履歴' }); assert.deepEqual(ops['T-1'].from, { status: 'In Progress', group: '現行' });
  assert.equal(ops['T-2'].expectedVersion, 2); assert.equal(ops['T-2'].requestId, 'sync20261022-T-2-v2');
  assert.equal(ops['N-1'].task.detail, local.find(f => f.filename === 'N-1.md').bytes.toString('utf8'), 'new card keeps the whole local source');
});

test('plan: cloud-only, archived-in-cloud, group mismatches and Done-in-現行 are reported, not changed', () => {
  assert.deepEqual(plan.cloudOnly, ['C-ONLY']);
  assert.deepEqual(plan.localArchivedInCloud, [{ id: 'A-1', localStatus: 'Done', cloudStatus: 'Done', cloudGroup: '現行' }]);
  assert.deepEqual(plan.groupMismatches.map(x => x.id), ['S-1'], 'S-1 differs in group only and is not in the decision list');
  const noGroup = buildPlan({ localFiles: local, archiveFiles: archive, cloud, decisions: { ...decisions, group: undefined }, now: NOW });
  assert.deepEqual(noGroup.operations.find(op => op.id === 'T-1').to, { status: 'Done', group: '現行' }, 'group stays as the cloud has it unless a decision names it');
  assert.ok(noGroup.groupMismatches.find(x => x.id === 'T-1'), 'and the difference is reported');
  assert.ok(plan.doneStillCurrent.cloud.includes('E-1') && plan.doneStillCurrent.cloud.includes('A-1'));
  assert.ok(plan.operations.every(op => op.id !== 'C-ONLY'));
  assert.ok(plan.privateRecords.find(r => r.id === 'N-2' && r.sourceUpdatedDate === null && r.ownerUnset && r.groupUnset), 'source dates stay in the private record; unknown stays null');
});

test('verify: a source file that changed after the plan is detected', () => {
  assert.deepEqual(verifyPlan(plan, local), []);
  const changed = local.map(f => (f.filename === 'T-2.md' ? file('T-2', md('T-2', 'Done', { body: 'edited later' })) : f));
  assert.deepEqual(verifyPlan(plan, changed), [{ id: 'T-2', file: 'T-2.md', reason: 'changed' }]);
  assert.deepEqual(verifyPlan(plan, local.filter(f => f.filename !== 'N-1.md')), [{ id: 'N-1', file: 'N-1.md', reason: 'missing' }]);
});

class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; this.attributes = {}; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } setAttribute(k, v) { this.attributes[k] = v; } showModal() {} addEventListener() {}
}
async function harness(t, { confirm = () => true } = {}) {
  const store = new FixtureStore(); store.state = { revision: 9, receipts: {}, audit: [], tasks: cloud.tasks.map(({ ...x }) => x) };
  const a = await app(store); t.after(() => a.close());
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, posts = [];
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID, subtle: webcrypto.subtle }, AbortSignal, setInterval() {}, Intl, confirm,
    fetch: (path, options) => { if (options?.method === 'POST') posts.push(JSON.parse(options.body)); return fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: env.DASHBOARD_ORIGIN } }); } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refresh()', context);
  const picked = (files = local, over = {}) => files.map(f => ({ name: f.filename, size: f.bytes.length, lastModified: PLAN_TIME - 3600000, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length), ...over }));
  const run = async (p, sources = picked()) => { el('planFile').files = [{ size: 1000, text: async () => JSON.stringify(p) }]; el('planSources').files = sources; await el('planSend').onclick(); return el('planNotice').textContent; };
  return { store, run, posts, el, picked };
}

test('apply UI: one validated POST per operation, deduplicated on repeat, history and versions correct, cloud body untouched', async t => {
  const h = await harness(t);
  const notice = await h.run(plan);
  assert.match(notice, /5件を適用しました/);
  const board = await h.store.read(), by = Object.fromEntries(board.tasks.map(x => [x.id, x]));
  assert.deepEqual([by['T-2'].status, by['T-2'].version, by['T-2'].detail, by['T-2'].owner], ['Done', 3, 'CLOUD BODY T-2', 'cloud-owner']);
  assert.deepEqual([by['T-1'].status, by['T-1'].group], ['Done', '完了履歴']);
  assert.deepEqual([by['N-2'].owner, by['N-2'].group, by['N-2'].version], ['', null, 1]);
  assert.equal(by['C-ONLY'].version, 8, 'cloud-only card untouched'); assert.equal(by['H-1'].status, 'Blocked'); assert.equal(by['A-1'].version, 7);
  assert.deepEqual(board.audit.filter(x => x.id === 'T-2').map(x => [x.from, x.to]), [['To Do', 'Done']]);
  assert.equal(board.revision, 14);
  const again = await h.run(plan);                                    // same requestIds: replayed, not committed twice
  assert.match(again, /5件を適用しました/); assert.equal((await h.store.read()).revision, 14);
  assert.deepEqual(Object.keys(h.posts[0]).sort(), ['expectedVersion', 'requestId', 'task']);
  assert.deepEqual(Object.keys(h.posts[0].task).sort(), ['detail', 'group', 'id', 'lastConfirmedAt', 'owner', 'status', 'title']);
});

test('apply UI: a changed card stops the run at that card; earlier ones stay, later ones are not sent', async t => {
  let h;
  h = await harness(t, { confirm: () => {
    // Race AFTER the freshly fetched preview baseline: only the server CAS can stop this write.
    h.store.state.tasks.find(x => x.id === 'T-2').version += 1; h.store.state.revision += 1; return true;
  } });
  const order = plan.operations.map(op => op.id), stopAt = order.indexOf('T-2');
  const notice = await h.run(plan);
  assert.match(notice, /T-2で中止しました.*409.*競合/); assert.match(notice, /自動では戻しません/);
  assert.equal(h.posts.length, stopAt + 1, 'nothing after the conflict is sent');
  const after = Object.fromEntries((await h.store.read()).tasks.map(x => [x.id, x]));
  assert.equal(after['T-2'].status, 'To Do');
  for (const id of order.slice(0, stopAt)) assert.ok(after[id]?.version >= 1, id + ' applied before the stop');
});

test('apply UI: stale, malformed, cancelled or empty plans send nothing', async t => {
  const h = await harness(t, { confirm: () => false });
  assert.match(await h.run(plan), /中止しました。何も送っていません/);
  const h2 = await harness(t);
  assert.match(await h2.run({ ...plan, generatedAt: new Date(Date.now() - 31 * 60000).toISOString() }), /古い/);
  assert.match(await h2.run({ ...plan, operations: [{ ...plan.operations[0], task: { ...plan.operations[0].task, group: 'bogus' } }] }), /形式が不正/);
  assert.match(await h2.run({ ...plan, operations: [{ ...plan.operations[0], expectedVersion: 3 }] }), /形式が不正/);
  assert.match(await h2.run({ ...plan, operations: [] }), /形式が不正/);
  assert.equal(h.posts.length + h2.posts.length, 0); assert.equal((await h2.store.read()).revision, 9);
});

test('apply UI: the plan is bound to the local source files; unverified, changed, newer or unbound inputs send nothing', async t => {
  const h = await harness(t); const sent = () => h.posts.length;
  assert.match(await h.run(plan, []), /ローカル検証に失敗.*選ばれていません/);                     // no source files selected: not a substitute for verification
  const changed = local.map(f => (f.filename === 'T-2.md' ? file('T-2', md('T-2', 'Done', { body: 'edited after the plan' })) : f));
  assert.match(await h.run(plan, h.picked(changed)), /T-2: 内容がプラン作成時と違います/);
  assert.match(await h.run(plan, h.picked(local, { lastModified: PLAN_TIME + 60000 })), /プラン作成後に更新されています/);
  assert.match(await h.run(plan, h.picked(local.filter(f => f.filename !== 'N-1.md'))), /N-1: N-1\.md が選ばれていません/);
  const unbound = { ...plan, operations: plan.operations.map(({ sourceSha256, sourceFile, sourceMtimeMs, ...rest }) => rest) };          // a plan made without source binding
  assert.match(await h.run(unbound), /形式が不正/);
  const noHash = { ...plan, operations: plan.operations.map(op => ({ ...op, sourceSha256: 'zz' })) }; assert.match(await h.run(noHash), /形式が不正/);
  const noMtime = { ...plan, operations: plan.operations.map(op => ({ ...op, sourceMtimeMs: null })) }; assert.match(await h.run(noMtime), /形式が不正/);
  assert.equal(sent(), 0, 'nothing was sent in any refused case'); assert.equal((await h.store.read()).revision, 9);
  assert.match(await h.run(plan), /5件を適用しました/);                                            // the same plan with the verified files goes through
});
