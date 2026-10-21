// Saving a card that is stored with a legacy status: the display mapping is never persisted without an explicit choice.
// Real update requests through the HTTP handler and the real client code (synthetic data only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { app, FixtureStore, task } from './fixtures.mjs';
import { emptyBoard } from '../model.mjs';

class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  showModal() {}
}
const stored = (id, status, version = 1) => ({ ...task, id, title: `Legacy ${id}`, status, version, updatedAt: '2026-10-20T00:00:00.000Z' });
const legacyStore = () => { const store = new FixtureStore(); store.state = { ...emptyBoard(), revision: 2, tasks: [stored('L-1', 'Verifying', 1), stored('L-2', 'Awaiting Approval', 2)] }; return store; };
const raw = async (store, id) => (await store.read()).tasks.find(t => t.id === id);

async function ui(a) {
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const bodies = [];
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {},
    fetch: (path, options) => { if (options?.method === 'POST') bodies.push(JSON.parse(options.body)); return fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } }); } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refresh()', context);
  const cardOf = id => el('board').children.flatMap(c => c.children).find(c => c.children?.[0]?.textContent === id);
  const open = id => { cardOf(id).onclick(); };
  const save = async () => { await el('save').onclick(); };
  return { el, bodies, open, save, context, optionValues: () => el('status').children.map(o => o.value) };
}

test('unchanged save of a legacy card sends no explicit status change and leaves the stored legacy status in place', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const page = await ui(a);
  page.open('L-1');
  assert.equal(page.el('status').value, 'keep-legacy', 'the dialog defaults to "keep as is"');
  assert.match(page.el('detailBody').textContent, /保存上の旧状態: Verifying（表示上は In Progress 列/);
  await page.save();
  assert.equal(page.bodies.length, 1);
  assert.equal(page.bodies[0].statusChange, undefined);
  assert.equal(page.bodies[0].task.status, 'In Progress', 'the request carries the displayed status, which the server does not persist');
  const after = await raw(store, 'L-1');
  assert.equal(after.status, 'Verifying', 'stored status unchanged');
  assert.equal(after.version, 2, 'the save itself was recorded');
  assert.match(page.el('saveNotice').textContent, /保存しました/);
  const view = await (await a.get('/api/tasks')).json();
  assert.equal(view.tasks.find(x => x.id === 'L-1').legacyStatus, 'Verifying');
  assert.equal(view.tasks.find(x => x.id === 'L-1').status, 'In Progress');
});

test('explicit status choices are persisted (including choosing the same status that is displayed); legacy cards keep the keep option', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const page = await ui(a);
  assert.ok(page.optionValues().includes('keep-legacy'));
  page.open('L-1'); page.el('status').value = 'In Progress'; await page.save();
  assert.equal(page.bodies.at(-1).statusChange, 'explicit');
  let after = await raw(store, 'L-1');
  assert.equal(after.status, 'In Progress', 'explicitly chosen status is stored');
  assert.equal((await (await a.get('/api/tasks')).json()).tasks.find(x => x.id === 'L-1').legacyStatus, undefined);
  await runInContext('refresh()', page.context);
  page.open('L-2'); page.el('status').value = 'Done'; await page.save();
  after = await raw(store, 'L-2');
  assert.equal(after.status, 'Done', 'a different explicit choice is stored as chosen');
  assert.equal(page.bodies.at(-1).statusChange, 'explicit');
});

test('API: editing another field alone keeps the legacy status; explicit change writes only one of the four statuses', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const cmd = (over, task2 = {}, id = 'edit-other-field') => ({ requestId: id, expectedVersion: 1, task: { ...task, id: 'L-1', title: 'Legacy L-1', status: 'In Progress', ...task2 }, ...over });
  const edited = await a.post(cmd({}, { detail: 'edited detail only' }));
  assert.equal(edited.status, 200);
  let after = await raw(store, 'L-1');
  assert.deepEqual([after.status, after.detail, after.version], ['Verifying', 'edited detail only', 2]);
  assert.equal((await edited.json()).legacyStatus, 'Verifying');
  // replay of the same request is idempotent and still does not persist the mapping
  const replay = await a.post(cmd({}, { detail: 'edited detail only' }));
  assert.equal(replay.status, 200); assert.equal((await raw(store, 'L-1')).version, 2); assert.equal((await raw(store, 'L-1')).status, 'Verifying');
  // explicit change with the same request id but different intent is rejected as a reused id
  assert.equal((await a.post(cmd({ statusChange: 'explicit' }, { detail: 'edited detail only' }))).status, 409);
  // explicit change
  const changed = await a.post(cmd({ statusChange: 'explicit', expectedVersion: 2 }, { status: 'Blocked' }, 'explicit-change'));
  assert.equal(changed.status, 200);
  after = await raw(store, 'L-1'); assert.equal(after.status, 'Blocked');
  const board = await store.read(); assert.deepEqual([board.audit.at(-1).from, board.audit.at(-1).to], ['Verifying', 'Blocked']);
});

test('the four-status write rule is unchanged: legacy values and bad intents are still rejected', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const send = (over, status = 'In Progress') => a.post({ requestId: `reject-${Math.random().toString(36).slice(2, 10)}`, expectedVersion: 1, task: { ...task, id: 'L-1', title: 'Legacy L-1', status }, ...over });
  assert.equal((await send({}, 'Verifying')).status, 400);
  assert.equal((await send({ statusChange: 'explicit' }, 'Awaiting Approval')).status, 400);
  assert.equal((await send({ statusChange: 'yes' })).status, 400);
  assert.equal((await send({ statusChange: true })).status, 400);
  assert.equal((await raw(store, 'L-1')).status, 'Verifying'); assert.equal((await raw(store, 'L-1')).version, 1);
});

test('a non-legacy card is unaffected by the intent flag', async t => {
  const store = new FixtureStore(); store.state = { ...emptyBoard(), revision: 1, tasks: [stored('N-1', 'To Do', 1)] };
  const a = await app(store); t.after(() => a.close());
  const r = await a.post({ requestId: 'plain-card-1', expectedVersion: 1, task: { ...task, id: 'N-1', title: 'Legacy N-1', status: 'Blocked' } });
  assert.equal(r.status, 200); assert.equal((await raw(store, 'N-1')).status, 'Blocked');
});

test('closing the dialog while the save is in flight still acknowledges a correct response (no mutable "selected" involved)', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const page = await ui(a);
  for (const [id, choose, expectStatus, expectLegacy] of [['L-1', 'keep-legacy', 'Verifying', 'Verifying'], ['L-2', 'Done', 'Done', undefined]]) {
    page.open(id); page.el('status').value = choose;
    const saving = page.el('save').onclick();
    page.el('detail').onclose();                       // the dialog closes before the response is processed
    await saving;
    assert.equal(runInContext('pendingRequests.size', page.context), 0, `${id}: the acknowledged request is no longer pending`);
    assert.equal(runInContext('pendingLegacy.size', page.context), 0, `${id}: nothing left behind`);
    assert.equal((await raw(store, id)).status, expectStatus, `${id}: stored status`);
    const shown = (await (await a.get('/api/tasks')).json()).tasks.find(x => x.id === id);
    assert.equal(shown.legacyStatus, expectLegacy, `${id}: legacy marker`);
    await runInContext('refresh()', page.context);
    const cardText = JSON.stringify(page.el('board'), (k, v) => (k === 'onclick' ? undefined : v));
    assert.doesNotMatch(cardText, /保存結果が未確認/, `${id}: no false "unconfirmed" badge`);
  }
});

test('a lost response is still reported as unconfirmed and re-sent with the same request id (retry behaviour is unchanged)', async t => {
  const store = legacyStore(), a = await app(store); t.after(() => a.close());
  const page = await ui(a);
  let failNext = true, firstBody;
  const original = page.context.fetch;
  page.context.fetch = (path, options) => { if (options?.method === 'POST' && failNext) { failNext = false; firstBody = JSON.parse(options.body); return Promise.reject(new Error('offline')); } return original(path, options); };
  page.open('L-1'); await page.save();
  assert.match(page.el('saveNotice').textContent, /保存結果が未確認/);
  assert.equal(runInContext('pendingRequests.size', page.context), 1);
  page.open('L-1'); await page.save();
  assert.equal(runInContext('pendingRequests.size', page.context), 0);
  assert.equal((await raw(store, 'L-1')).status, 'Verifying'); assert.equal((await raw(store, 'L-1')).version, 2, 'the retry did not double-apply');
  assert.ok(firstBody?.requestId, 'the lost attempt was a real request');
  assert.equal(page.bodies.at(-1).requestId, firstBody.requestId, 'the retry re-sends the same request id');
  assert.deepEqual(page.bodies.at(-1).task, firstBody.task);
});
