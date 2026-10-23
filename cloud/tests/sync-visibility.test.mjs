import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { app, FixtureStore, env } from './fixtures.mjs';
import { mutate } from '../model.mjs';
import { buildPlan } from '../../scripts/ticket-sync-plan.mjs';

// Synthetic data only: no real task, no private plan, no network. Covers (1) the planner's opt-in display group on create, (2) body-only sync on an unchanged status,
// (3) the board's cross-group / ID search with a visible group label, (4) "applied" vs "read back from the public snapshot" in the apply notice.
const md = (id, status, { labels = [], body = 'local body' } = {}) =>
  `---\nid: ${id}\ntitle: 'Synthetic ${id}'\nstatus: ${status}\nassignee: []\n${labels.length ? `labels:\n${labels.map(l => `  - '${l}'`).join('\n')}\n` : 'labels: []\n'}created_date: '2026-10-11 09:00'\nupdated_date: '2026-10-20 09:00'\n---\n## Description\n${body}\n`;
const PLAN_TIME = Date.now();
const file = (id, text) => { const bytes = Buffer.from(text); return { filename: `${id}.md`, bytes, base64: bytes.toString('base64'), mtimeMs: PLAN_TIME - 3600000 }; };
const cloudTask = (id, status, version, over = {}) => ({ id, title: `Synthetic ${id}`, status, owner: 'cloud-owner', group: '現行', detail: `OLD BODY ${id}`, lastConfirmedAt: null, version, updatedAt: '2026-10-15T00:00:00.000Z', ...over });
const NOW = new Date();

test('plan/create: the display group is opt-in per card; without it the card stays 未分類, an invalid group is refused', () => {
  const localFiles = [file('N-1', md('N-1', 'To Do')), file('N-2', md('N-2', 'To Do', { labels: ['表示:要棚卸し'] }))];
  const base = { localFiles, cloud: { revision: 1, tasks: [] }, now: NOW };
  const plain = buildPlan({ ...base, decisions: { date: '20261023', create: ['N-1', 'N-2'] } });
  const ops = Object.fromEntries(plain.operations.map(op => [op.id, op]));
  assert.deepEqual([ops['N-1'].task.group, ops['N-2'].task.group], [null, '要棚卸し'], 'unlabeled stays unset; a local 表示: label is still honoured');
  const named = buildPlan({ ...base, decisions: { date: '20261023', create: ['N-1', 'N-2'], group: { 'N-1': '現行' } } });
  const named1 = named.operations.find(op => op.id === 'N-1');
  assert.deepEqual([named1.task.group, named1.to.group], ['現行', '現行']);
  assert.equal(named.operations.find(op => op.id === 'N-2').task.group, '要棚卸し', 'cards not named keep their own group');
  assert.throws(() => buildPlan({ ...base, decisions: { date: '20261023', create: ['N-1'], group: { 'N-1': '未分類' } } }), /Invalid status\/group/, 'nothing outside the three groups / null is accepted');
});

test('plan/body: a body-only change on the same status becomes ONE content operation, only when the card is named in decisions.body', () => {
  const edited = file('B-1', md('B-1', 'In Progress', { body: 'NEW local body' }));
  const cloud = { revision: 5, tasks: [cloudTask('B-1', 'In Progress', 3)] };
  const unlisted = buildPlan({ localFiles: [edited], cloud, decisions: { date: '20261023', status: { 'B-1': 'In Progress' } }, now: NOW });
  assert.equal(unlisted.operations.length, 0, 'without body the cloud body is never touched');
  assert.ok(unlisted.holds.find(h => h.id === 'B-1' && /変更なし/.test(h.reason)));
  const listed = buildPlan({ localFiles: [edited], cloud, decisions: { date: '20261023', status: { 'B-1': 'In Progress' }, body: ['B-1'] }, now: NOW });
  assert.equal(listed.operations.length, 1);
  const [op] = listed.operations;
  assert.deepEqual([op.kind, op.expectedVersion, op.from, op.to], ['content', 3, { status: 'In Progress', group: '現行' }, { status: 'In Progress', group: '現行' }]);
  assert.equal(op.task.detail, edited.bytes.toString('utf8'), 'the whole local source, not a truncation');
  assert.deepEqual([op.task.title, op.task.owner, op.task.status, op.task.group], ['Synthetic B-1', 'cloud-owner', 'In Progress', '現行'], 'only the body (and decided status/group) change');
  assert.match(op.requestId, /^sync20261023-B-1-v3-b[0-9a-f]{12}$/);
  assert.equal(op.requestId.endsWith(op.sourceSha256.slice(0, 12)), true, 'the request ID is bound to the exact source bytes');
  const again = buildPlan({ localFiles: [edited], cloud, decisions: { date: '20261023', body: ['B-1'] }, now: NOW });
  assert.equal(again.operations[0].requestId, op.requestId, 'listing the card without a status decision yields the same operation (status kept as the cloud has it)');
  const other = buildPlan({ localFiles: [file('B-1', md('B-1', 'In Progress', { body: 'DIFFERENT' }))], cloud, decisions: { date: '20261023', body: ['B-1'] }, now: NOW });
  assert.notEqual(other.operations[0].requestId, op.requestId, 'a different body can never reuse an earlier request ID');
});

test('plan/body: identical body, missing card or conflicting status hold; status plus body is a single operation', () => {
  const same = file('S-1', md('S-1', 'Done'));
  const cloud = { revision: 5, tasks: [cloudTask('S-1', 'Done', 2, { detail: same.bytes.toString('utf8') }), cloudTask('S-2', 'To Do', 4)] };
  const identical = buildPlan({ localFiles: [same], cloud, decisions: { date: '20261023', body: ['S-1'] }, now: NOW });
  assert.equal(identical.operations.length, 0); assert.ok(identical.holds.find(h => h.id === 'S-1' && /本文とも同一/.test(h.reason)));
  const missing = buildPlan({ localFiles: [], cloud, decisions: { date: '20261023', body: ['GONE'] }, now: NOW });
  assert.ok(missing.holds.find(h => h.id === 'GONE'));
  const conflict = buildPlan({ localFiles: [file('S-2', md('S-2', 'Done'))], cloud, decisions: { date: '20261023', status: { 'S-2': 'In Progress' }, body: ['S-2'] }, now: NOW });
  assert.equal(conflict.operations.length, 0); assert.ok(conflict.holds.find(h => h.id === 'S-2' && /一致しません/.test(h.reason)), 'a status decision that disagrees with the local file still holds');
  const both = buildPlan({ localFiles: [file('S-2', md('S-2', 'Done', { body: 'edited' }))], cloud, decisions: { date: '20261023', status: { 'S-2': 'Done' }, body: ['S-2'] }, now: NOW });
  assert.equal(both.operations.filter(op => op.id === 'S-2').length, 1, 'one operation per card (the apply UI refuses duplicate IDs)');
  assert.deepEqual([both.operations[0].kind, both.operations[0].task.status], ['content', 'Done']);
});

class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; this.attributes = {}; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } setAttribute(k, v) { this.attributes[k] = v; } showModal() {} addEventListener() {}
}
const text = n => [n.textContent, ...(n.children ?? []).map(text)].join(' ');
async function boot(t, { tasks = [], confirm = () => true } = {}) {
  const store = new FixtureStore(); const a = await app(store); t.after(() => a.close());
  for (const [i, task] of tasks.entries()) await mutate(store, { requestId: `seed-${i}-${task.id}`, expectedVersion: 0, task });
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, posts = [], control = { failReads: false };
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID, subtle: webcrypto.subtle }, TextEncoder, AbortSignal, setInterval() {}, Intl, confirm,
    fetch: (path, options) => { if (options?.method === 'POST') posts.push(JSON.parse(options.body)); else if (control.failReads) return Promise.reject(new Error('synthetic read failure')); return fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: env.DASHBOARD_ORIGIN } }); } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refresh()', context);
  return { store, el, posts, context, control, board: () => text(el('board')) };
}
const input = (id, over = {}) => ({ id, title: `Synthetic ${id}`, status: 'To Do', owner: 'synthetic-agent', group: '現行', detail: 'body without the identifier', lastConfirmedAt: null, ...over });

test('board search: a query spans every group (including 未分類) by ID or text and labels each hit with its group; counts and the empty-query view are unchanged', async t => {
  const h = await boot(t, { tasks: [input('KEEP-1'), input('LOST-9', { group: null, title: '未分類の合成カード' }), input('DONE-3', { group: '完了履歴', status: 'Done' })] });
  assert.deepEqual(h.el('groups').children.map(b => b.textContent), ['現行 · 1', '要棚卸し · 0', '完了履歴 · 1', '未分類 · 1']);
  assert.match(h.board(), /KEEP-1/); assert.doesNotMatch(h.board(), /LOST-9/, 'without a query the 現行 tab still shows only 現行');
  h.el('search').value = 'LOST-9'; runInContext('render()', h.context);
  assert.match(h.board(), /LOST-9/, 'found by ID from another tab, although the ID is not in the body');
  assert.match(h.board(), /表示グループ: 未分類/); assert.doesNotMatch(h.board(), /KEEP-1|DONE-3/);
  h.el('search').value = 'done-3'; runInContext('render()', h.context);
  assert.match(h.board(), /DONE-3/); assert.match(h.board(), /表示グループ: 完了履歴/, 'case-insensitive, across the Done column of another group');
  h.el('search').value = '   '; runInContext('render()', h.context);
  assert.doesNotMatch(h.board(), /表示グループ/); assert.doesNotMatch(h.board(), /LOST-9/, 'a blank query behaves as no query');
  h.el('search').value = 'NO-SUCH-ID'; runInContext('render()', h.context);
  assert.doesNotMatch(h.board(), /KEEP-1|LOST-9|DONE-3/);
  assert.deepEqual(h.el('groups').children.map(b => b.textContent), ['現行 · 1', '要棚卸し · 0', '完了履歴 · 1', '未分類 · 1'], 'tab counts are never changed by searching');
});

test('apply UI: a body-only content operation is one validated POST, keeps status/owner/title, replays without a second commit, stops on conflict, and reports the public read-back', async t => {
  const cloudDetail = 'OLD BODY';
  const h = await boot(t, { tasks: [input('B-1', { status: 'In Progress', title: 'Synthetic B-1', owner: 'cloud-owner', detail: cloudDetail })] });
  const before = (await h.store.read()).tasks.find(x => x.id === 'B-1');
  const edited = file('B-1', md('B-1', 'In Progress', { body: 'NEW local body' }));
  const plan = buildPlan({ localFiles: [edited], cloud: { revision: (await h.store.read()).revision, tasks: [before] }, decisions: { date: '20261023', body: ['B-1'] }, now: new Date() });
  assert.equal(plan.operations[0].kind, 'content');
  const run = async (p, files = [edited]) => {
    h.el('planFile').files = [{ size: 1000, text: async () => JSON.stringify(p) }];
    h.el('planSources').files = files.map(f => ({ name: f.filename, size: f.bytes.length, lastModified: f.mtimeMs, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length) }));
    await h.el('planSend').onclick(); return h.el('planNotice').textContent;
  };
  const notice = await run(plan);
  assert.match(notice, /1件を適用しました: B-1/); assert.match(notice, /公開側の読み戻し: 1\/1件がプラン内容と一致/);
  assert.equal(h.posts.length, 1); assert.deepEqual(Object.keys(h.posts[0]).sort(), ['expectedVersion', 'requestId', 'task']);
  const after = (await h.store.read()).tasks.find(x => x.id === 'B-1');
  assert.deepEqual([after.version, after.status, after.owner, after.title, after.group], [before.version + 1, 'In Progress', 'cloud-owner', 'Synthetic B-1', '現行']);
  assert.equal(after.detail, edited.bytes.toString('utf8'));
  const revision = (await h.store.read()).revision;
  assert.match(await run(plan), /1件を適用しました/); assert.equal((await h.store.read()).revision, revision, 'same request ID: replayed, not committed twice');
  // someone else edited the card after the plan was made: CAS stops the run, nothing is overwritten
  const stale = buildPlan({ localFiles: [file('B-1', md('B-1', 'In Progress', { body: 'THIRD local body' }))], cloud: { revision, tasks: [{ ...after, version: after.version - 1 }] }, decisions: { date: '20261023', body: ['B-1'] }, now: new Date() });
  assert.match(await run(stale, [file('B-1', md('B-1', 'In Progress', { body: 'THIRD local body' }))]), /B-1で中止しました.*409.*競合/);
  assert.equal((await h.store.read()).tasks.find(x => x.id === 'B-1').detail, edited.bytes.toString('utf8'), 'the conflicting write changed nothing');
});

test('read-back: only a snapshot that carries the written version and every written field counts; a content-kind operation is accepted by the plan validator', async t => {
  const h = await boot(t);
  const op = { id: 'R-1', expectedVersion: 2, task: input('R-1', { status: 'Done', detail: 'written' }) };
  const count = (tasks, ops = [op]) => runInContext(`readBackConfirmed(${JSON.stringify(ops)}, ${JSON.stringify(tasks)})`, h.context);
  const ok = { ...op.task, version: 3 };
  assert.equal(count([ok]), 1);
  assert.equal(count([{ ...ok, version: 2 }]), 0, 'the old version is not a confirmation');
  assert.equal(count([{ ...ok, detail: 'someone else' }]), 0, 'a different body is not a confirmation of this plan');
  assert.equal(count([{ ...ok, group: null }]), 0); assert.equal(count([]), 0, 'a card missing from the snapshot is not confirmed');
  assert.equal(count([{ ...ok, version: 9 }]), 1, 'a later version that still carries the written fields is fine');
  const valid = JSON.stringify({ kind: 'content', requestId: 'sync20261023-R-1-v2-babcdef012345', expectedVersion: 2, id: 'R-1', from: { status: 'Done', group: '現行' }, bodyChange: { fromChars: 3, toChars: op.task.detail.length, fromSha256: 'b'.repeat(64), toSha256: 'c'.repeat(64) }, task: op.task, sourceFile: 'R-1.md', sourceSha256: 'a'.repeat(64), sourceMtimeMs: 1790000000000 });
  assert.equal(runInContext(`validPlanOperation(${valid})`, h.context), true);
  assert.equal(runInContext(`validPlanOperation({ ...${valid}, kind: 'delete' })`, h.context), false, 'unknown kinds are still refused');
  assert.equal(runInContext(`validPlanOperation({ ...${valid}, expectedVersion: 0 })`, h.context), false, 'only create may use version 0');
});

test('apply UI: when the snapshot cannot be re-read after the writes, the notice says the read-back is unconfirmed instead of implying the board shows them', async t => {
  const h = await boot(t, { tasks: [input('U-1', { detail: 'OLD BODY' })] });
  const current = (await h.store.read()).tasks.find(x => x.id === 'U-1');
  const edited = file('U-1', md('U-1', 'To Do', { body: 'edited' }));
  const plan = buildPlan({ localFiles: [edited], cloud: { revision: 1, tasks: [current] }, decisions: { date: '20261023', body: ['U-1'] }, now: new Date() });
  h.el('planFile').files = [{ size: 1000, text: async () => JSON.stringify(plan) }];
  h.el('planSources').files = [{ name: 'U-1.md', size: edited.bytes.length, lastModified: edited.mtimeMs, arrayBuffer: async () => edited.bytes.buffer.slice(edited.bytes.byteOffset, edited.bytes.byteOffset + edited.bytes.length) }];
  h.control.failReads = true;
  await h.el('planSend').onclick();
  const notice = h.el('planNotice').textContent;
  assert.match(notice, /1件を適用しました: U-1/); assert.match(notice, /公開側の読み戻しは未確認/); assert.doesNotMatch(notice, /\d\/\d件がプラン内容と一致/);
  assert.equal((await h.store.read()).tasks.find(x => x.id === 'U-1').detail, edited.bytes.toString('utf8'), 'the write itself did commit; only its read-back is unconfirmed');
});
