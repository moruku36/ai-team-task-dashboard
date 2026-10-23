import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { app, FixtureStore, env } from './fixtures.mjs';
import { mutate } from '../model.mjs';
import { buildPlan } from '../../scripts/ticket-sync-plan.mjs';

// Synthetic data only. Covers the body-only sync contract: expectedVersion is the card's own version from a well-formed snapshot, the preview names the body replacement,
// the status is never changed or reopened implicitly, and differing bodies are listed (sizes only) for a decision.
const md = (id, status, body) => `---\nid: ${id}\ntitle: 'Synthetic ${id}'\nstatus: ${status}\nassignee: []\nlabels: []\ncreated_date: '2026-10-11 09:00'\n---\n${body}\n`;
const T = Date.now() - 3600000;
const file = (id, text) => { const bytes = Buffer.from(text); return { filename: `${id}.md`, bytes, base64: bytes.toString('base64'), mtimeMs: T }; };
const card = (id, status, version, detail) => ({ id, title: `Synthetic ${id}`, status, owner: 'cloud-owner', group: '現行', detail, lastConfirmedAt: null, version, updatedAt: '2026-10-22T00:00:00.000Z' });
const NOW = new Date();

test('plan: expectedVersion is the target card\'s own version (not the board revision); a malformed snapshot is refused whole', () => {
  const cloud = { revision: 40, tasks: [card('P-1', 'In Progress', 7, 'old')] };
  const plan = buildPlan({ localFiles: [file('P-1', md('P-1', 'In Progress', 'new'))], cloud, decisions: { date: '20261023', body: ['P-1'] }, now: NOW });
  const [op] = plan.operations;
  assert.equal(op.kind, 'content'); assert.equal(op.expectedVersion, 7); assert.notEqual(op.expectedVersion, cloud.revision);
  assert.equal(op.task.status, 'In Progress', 'a body-only change keeps the status'); assert.equal(op.task.lastConfirmedAt, null, 'no confirmation time is invented');
  assert.deepEqual([op.bodyChange.fromChars, op.bodyChange.toChars], [3, op.task.detail.length]); assert.match(op.bodyChange.fromSha256, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(op.bodyChange).includes('old'), 'no body text in the summary');
  const bad = [{ ...cloud, revision: -1 }, { tasks: cloud.tasks }, { revision: 40 }, { revision: 40, tasks: [card('P-1', 'Done', 0, 'x')] }, { revision: 3, tasks: [card('P-1', 'Done', 7, 'x')] },
    { revision: 40, tasks: [card('P-1', 'Done', 7, 'x'), card('P-1', 'Done', 8, 'y')] }, { revision: 40, tasks: [{ ...card('P-1', 'Done', 7, 'x'), detail: undefined }] }];
  for (const snapshot of bad) assert.throws(() => buildPlan({ localFiles: [], cloud: snapshot, decisions: { create: ['N-1'] }, now: NOW }), /スナップショットが不正/, JSON.stringify(snapshot).slice(0, 60));
});

test('plan: a Done card with a changed local body is listed as a difference, and naming it replaces only the body (never reopens it)', () => {
  const cloud = { revision: 9, tasks: [card('D-1', 'Done', 4, 'finished text'), card('D-2', 'To Do', 2, md('D-2', 'To Do', 'same'))] };
  const files = [file('D-1', md('D-1', 'Done', 'finished text, edited')), file('D-2', md('D-2', 'To Do', 'same'))];
  const listed = buildPlan({ localFiles: files, cloud, decisions: { date: '20261023' }, now: NOW });
  assert.equal(listed.operations.length, 0, 'nothing is planned without a decision');
  assert.deepEqual(listed.bodyDifferences.map(d => d.id), ['D-1']); assert.equal(listed.bodyDifferences[0].sameStatus, true);
  assert.ok(!JSON.stringify(listed.bodyDifferences).includes('finished'), 'sizes only');
  const named = buildPlan({ localFiles: files, cloud, decisions: { date: '20261023', body: ['D-1'] }, now: NOW });
  assert.deepEqual([named.operations[0].kind, named.operations[0].task.status, named.operations[0].from.status], ['content', 'Done', 'Done']);
  const reopening = buildPlan({ localFiles: [file('D-1', md('D-1', 'In Progress', 'finished text'))], cloud, decisions: { date: '20261023', status: { 'D-1': 'Done' } }, now: NOW });
  assert.equal(reopening.operations.length, 0); assert.match(reopening.holds[0].reason, /決定表.*一致しません/, 'a local status that disagrees with the decision never changes the card');
});

const Elem = class { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } setAttribute() {} showModal() {} addEventListener() {} };
async function boot(t, tasks) {
  const store = new FixtureStore(); const a = await app(store); t.after(() => a.close());
  for (const [i, task] of tasks.entries()) await mutate(store, { requestId: `seed-${i}-${task.id}`, expectedVersion: 0, task });
  const els = new Map(), el = id => { if (!els.has(id)) els.set(id, new Elem()); return els.get(id); }, posts = [], shown = [], control = {};
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Elem(), addEventListener() {} }, crypto: { randomUUID, subtle: webcrypto.subtle }, TextEncoder, AbortSignal, setInterval() {}, Intl,
    confirm: message => { shown.push(message); return true; },
    fetch: async (path, options) => {
      const write = options?.method === 'POST';
      if (write) posts.push(JSON.parse(options.body));
      if (!write && control.failReads) throw new Error('synthetic read failure');
      const response = await fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: env.DASHBOARD_ORIGIN } });
      return write && control.postReply ? control.postReply(response) : response;
    } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refresh()', context);
  return { store, el, posts, shown, context, control };
}
const send = async (h, plan, files) => { h.el('planFile').files = [{ size: 1000, text: async () => JSON.stringify(plan) }];
  h.el('planSources').files = files.map(f => ({ name: f.filename, size: f.bytes.length, lastModified: f.mtimeMs, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length) })); await h.el('planSend').onclick(); return h.el('planNotice').textContent; };

test('apply preview: the confirm dialog names each body replacement with old/new size and says the status stays, flags a reopening, and never shows body text', async t => {
  const h = await boot(t, [{ id: 'V-1', title: 'Synthetic V-1', status: 'Done', owner: 'cloud-owner', group: '現行', detail: 'SECRET-OLD', lastConfirmedAt: null }, { id: 'V-2', title: 'Synthetic V-2', status: 'Done', owner: 'cloud-owner', group: '現行', detail: 'x', lastConfirmedAt: null }]);
  const snapshot = await h.store.read(); const files = [file('V-1', md('V-1', 'Done', 'SECRET-NEW body')), file('V-2', md('V-2', 'In Progress', 'x'))];
  const plan = buildPlan({ localFiles: files, cloud: snapshot, decisions: { date: '20261023', body: ['V-1'], status: { 'V-2': 'In Progress' } }, now: new Date() });
  const notice = await send(h, plan, files);
  assert.match(notice, /2件を適用しました/);
  const preview = h.shown[0];
  assert.match(preview, /本文更新 1/); assert.match(preview, /V-1: 本文を置き換え\(\d+→\d+文字・状態はDoneのまま\)/);
  assert.match(preview, /V-2: 状態 Done→In Progress\(完了からの再開\)\(本文は変更しない\)/);
  assert.doesNotMatch(preview, /SECRET/);
  assert.deepEqual(h.posts.map(p => Object.keys(p).sort().join()), ['expectedVersion,requestId,task', 'expectedVersion,requestId,task']);
});

test('apply: a content operation whose summary is missing, inconsistent or a non-content operation carrying one is refused before anything is sent', async t => {
  const h = await boot(t, [{ id: 'W-1', title: 'Synthetic W-1', status: 'To Do', owner: 'cloud-owner', group: '現行', detail: 'old', lastConfirmedAt: null }]);
  const files = [file('W-1', md('W-1', 'To Do', 'new'))];
  const good = buildPlan({ localFiles: files, cloud: await h.store.read(), decisions: { date: '20261023', body: ['W-1'] }, now: new Date() });
  const variants = [p => delete p.operations[0].bodyChange, p => { p.operations[0].bodyChange.toChars += 1; }, p => { p.operations[0].bodyChange.toSha256 = p.operations[0].bodyChange.fromSha256; }, p => { p.operations[0].kind = 'status'; }, p => { delete p.operations[0].from; }];
  for (const mutateOp of variants) { const p = structuredClone(good); mutateOp(p); assert.match(await send(h, p, files), /プランの形式が不正/); }
  assert.equal(h.posts.length, 0, 'nothing was sent'); assert.equal(h.shown.length, 0);
  assert.match(await send(h, good, files), /1件を適用しました/);
});

test('plan: an ID collision with a different title holds a body copy; malformed snapshots and body decisions fail closed', () => {
  const local = file('IDENTITY-1', md('IDENTITY-1', 'To Do', 'different purpose'));
  const cloud = { revision: 1, tasks: [{ ...card('IDENTITY-1', 'To Do', 1, 'retain this'), title: 'Another project' }] };
  const plan = buildPlan({ localFiles: [local], cloud, decisions: { body: ['IDENTITY-1'] } });
  assert.equal(plan.operations.length, 0);
  assert.match(plan.holds[0].reason, /名称が一致しません/);
  for (const change of [{ title: '' }, { owner: null }, { group: 'invented' }, { status: 'invented' }, { updatedAt: 'unknown' }, { id: '../bad' }]) {
    assert.throws(() => buildPlan({ localFiles: [], cloud: { revision: 1, tasks: [{ ...card('VALID-1', 'To Do', 1, ''), ...change }] }, decisions: {} }), /スナップショットが不正/);
  }
  assert.throws(() => buildPlan({ localFiles: [], cloud, decisions: { body: 'IDENTITY-1' } }), /body/);
});

test('apply: older source copies and forged same-length body/hash summaries send nothing', async t => {
  const h = await boot(t, [{ id: 'HASH-1', title: 'Synthetic HASH-1', status: 'To Do', owner: '', group: null, detail: 'old', lastConfirmedAt: null }]);
  const files = [file('HASH-1', md('HASH-1', 'To Do', 'new'))];
  const plan = buildPlan({ localFiles: files, cloud: await h.store.read(), decisions: { body: ['HASH-1'] } });
  const older = files.map(f => ({ ...f, mtimeMs: f.mtimeMs - 1 }));
  assert.match(await send(h, plan, older), /更新時刻がプランと一致しません/);
  const wrongHash = structuredClone(plan); wrongHash.operations[0].bodyChange.toSha256 = 'f'.repeat(64);
  assert.match(await send(h, wrongHash, files), /本文と元ファイルのハッシュが一致しません/);
  const wrongBody = structuredClone(plan); wrongBody.operations[0].task.detail = wrongBody.operations[0].task.detail.replace('new', 'bad');
  assert.match(await send(h, wrongBody, files), /本文と元ファイルのハッシュが一致しません/);
  assert.equal(h.posts.length, 0); assert.equal(h.shown.length, 0);
});

test('apply: a malformed or wrong successful ACK stops later writes, preserves request IDs, and can be reconciled without a duplicate commit', async t => {
  for (const reply of ['html', 'version', 'body']) {
    const tasks = ['ACK-1', 'ACK-2'].map(id => ({ id, title: `Synthetic ${id}`, status: 'To Do', owner: '', group: null, detail: 'old', lastConfirmedAt: null }));
    const h = await boot(t, tasks);
    const files = tasks.map(task => file(task.id, md(task.id, 'To Do', 'new')));
    const plan = buildPlan({ localFiles: files, cloud: await h.store.read(), decisions: { body: tasks.map(t => t.id) } });
    h.control.postReply = async response => {
      if (reply === 'html') return new Response('<html>sign in</html>', { status: 200 });
      const saved = await response.json();
      if (reply === 'version') saved.version += 1; else saved.detail = 'wrong';
      return new Response(JSON.stringify(saved), { status: 200 });
    };
    assert.match(await send(h, plan, files), /ACK-1の結果が未確認/);
    assert.equal(h.posts.length, 1, 'no later operation is sent after an uncertain ACK');
    assert.equal((await h.store.read()).tasks.find(t => t.id === 'ACK-2').detail, 'old');
    const firstId = h.posts[0].requestId;
    h.control.postReply = undefined;
    assert.match(await send(h, plan, files), /2件を適用しました/);
    assert.equal(h.posts[1].requestId, firstId);
    assert.equal((await h.store.read()).tasks.find(t => t.id === 'ACK-1').version, 2);
  }
});

test('apply: preview baseline rejects hidden status-body edits, changed immutable fields, forged old-body summaries and offline reads', async t => {
  const h = await boot(t, [{ id: 'BASE-1', title: 'Synthetic BASE-1', status: 'To Do', owner: '', group: null, detail: 'old', lastConfirmedAt: null }]);
  const files = [file('BASE-1', md('BASE-1', 'To Do', 'new'))];
  const plan = buildPlan({ localFiles: files, cloud: await h.store.read(), decisions: { body: ['BASE-1'] } });
  for (const change of [
    op => { op.kind = 'status'; delete op.bodyChange; },
    op => { op.task.owner = 'unexpected'; },
    op => { op.task.title = 'Another purpose'; },
    op => { op.task.lastConfirmedAt = '2026-10-23T00:00:00.000Z'; },
    op => { op.bodyChange.fromChars += 1; },
    op => { op.bodyChange.fromSha256 = 'e'.repeat(64); },
  ]) {
    const bad = structuredClone(plan); change(bad.operations[0]);
    assert.match(await send(h, bad, files), /適用前の照合で中止/);
  }
  h.control.failReads = true;
  assert.match(await send(h, plan, files), /最新一覧を取得できません.*何も送っていません/);
  assert.equal(h.posts.length, 0); assert.equal(h.shown.length, 0);
  assert.equal((await h.store.read()).tasks[0].detail, 'old');
});
