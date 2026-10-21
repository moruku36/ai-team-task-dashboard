import test from 'node:test';
import assert from 'node:assert/strict';
import { statuses, publicSnapshot, normalizeStatus, mutate, emptyBoard, Problem } from '../model.mjs';
import { FixtureStore, task } from './fixtures.mjs';

const stored = (id, status, version = 1) => ({ ...task, id, status, version, updatedAt: '2026-10-20T00:00:00.000Z' });

test('the board shows exactly four statuses and no final-check column', () => {
  assert.deepEqual(statuses, ['To Do', 'In Progress', 'Blocked', 'Done']);
});

test('legacy stored statuses stay readable, keep their original value and are never promoted to Done', () => {
  const board = { revision: 3, tasks: [stored('OLD-1', 'Verifying', 1), stored('OLD-2', 'Awaiting Approval', 2), stored('NEW-1', 'Done', 3)], receipts: {}, audit: [] };
  const view = publicSnapshot(board);
  assert.equal(view.tasks.length, 3, 'no card disappears');
  const byId = Object.fromEntries(view.tasks.map(t => [t.id, t]));
  assert.deepEqual([byId['OLD-1'].status, byId['OLD-1'].legacyStatus], ['In Progress', 'Verifying']);
  assert.deepEqual([byId['OLD-2'].status, byId['OLD-2'].legacyStatus], ['Blocked', 'Awaiting Approval']);
  assert.equal(byId['NEW-1'].legacyStatus, undefined);
  for (const t of view.tasks.filter(t => t.legacyStatus)) { assert.notEqual(t.status, 'Done'); assert.equal(t.title, task.title); assert.equal(t.detail, task.detail); }
  assert.equal(board.tasks[0].status, 'Verifying', 'storage is not rewritten by reading');
});

test('unknown statuses are still rejected and writes accept only the four statuses', async () => {
  assert.deepEqual(normalizeStatus('Done'), { status: 'Done' });
  assert.throws(() => publicSnapshot({ revision: 1, tasks: [stored('X', 'Nonsense')], receipts: {}, audit: [] }), Problem);
  const store = new FixtureStore();
  for (const legacy of ['Verifying', 'Awaiting Approval']) await assert.rejects(mutate(store, { requestId: `legacy-${legacy.length}-write`, expectedVersion: 0, task: { ...task, status: legacy } }), /Invalid status/);
  const ok = await mutate(store, { requestId: 'four-col-ok1', expectedVersion: 0, task: { ...task, status: 'Blocked' } });
  assert.equal(ok.status, 'Blocked');
});

test('re-saving a legacy card records the old status in the audit trail', async () => {
  const store = new FixtureStore(); store.state = { ...emptyBoard(), revision: 1, tasks: [stored('SYNTH-1', 'Verifying', 1)] };
  await mutate(store, { requestId: 'legacy-resave-1', expectedVersion: 1, task: { ...task, id: 'SYNTH-1', status: 'In Progress' } });
  const board = await store.read();
  assert.deepEqual([board.audit.at(-1).from, board.audit.at(-1).to], ['Verifying', 'In Progress']);
});

test('cloud stylesheet lays out exactly as many columns as the board has statuses (static check, not a browser measurement)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const counts = [...css.matchAll(/#board\{[^}]*grid-template-columns:repeat\((\d+),/g)].map(m => Number(m[1]));
  assert.ok(counts.length >= 2, 'wide and narrow board rules found');
  for (const n of counts) assert.equal(n, statuses.length);
  assert.doesNotMatch(css, /repeat\(6/);
});
