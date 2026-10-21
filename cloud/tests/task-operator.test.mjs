import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperatorBatch, inspectOperatorMatches } from '../task-operator.mjs';
import { emptyBoard } from '../model.mjs';
const operation = (over = {}) => ({ requestId: 'synthetic_job_001', matchUrl: 'https://example.invalid/application', expectedVersion: 0,
  task: { id: 'SYNTH-APP', title: 'Synthetic application', owner: 'synthetic-owner', group: '現行', status: 'Blocked', detail: 'https://example.invalid/application\nReply pending; exact send time unknown', lastConfirmedAt: null }, ...over });
function fixture() { let board = { ...emptyBoard(), quota: { synthetic: true }, migrationArchive: { synthetic: true } }; return {
  read: async () => structuredClone(board), transaction: async change => { const draft = structuredClone(board); const result = await change(draft); board = draft; return result; } }; }
const batch = (...operations) => ({ version: 1, operations });
test('atomic Web-only create, inspection, replay and CAS update preserve unrelated state', async () => {
  const store = fixture(), op = operation(); const created = await applyOperatorBatch(store, batch(op));
  assert.equal(created.results[0].version, 1); assert.equal((await inspectOperatorMatches(store, batch(op)))[0].matches.length, 1);
  assert.deepEqual(await applyOperatorBatch(store, batch(op)), created); assert.equal((await store.read()).tasks.length, 1);
  await applyOperatorBatch(store, batch(operation({ requestId: 'synthetic_job_002', expectedVersion: 1, task: { ...op.task, status: 'Done' } })));
  const actual = await store.read(); assert.equal(actual.tasks[0].status, 'Done'); assert.deepEqual(actual.quota, { synthetic: true }); assert.deepEqual(actual.migrationArchive, { synthetic: true });
});
test('stale and reused requests fail; batch failure rolls back every operation', async () => {
  const store = fixture(), op = operation(); await applyOperatorBatch(store, batch(op));
  await assert.rejects(applyOperatorBatch(store, batch(operation({ requestId: 'synthetic_job_003' }))));
  await assert.rejects(applyOperatorBatch(store, batch({ ...op, task: { ...op.task, status: 'Done' } })));
  await assert.rejects(applyOperatorBatch(store, batch(operation({ requestId: 'synthetic_new_001', matchUrl: 'https://example.invalid/second', task: { ...op.task, id: 'SYNTH-SECOND', title: 'Second', detail: 'https://example.invalid/second' } }), operation({ requestId: 'synthetic_job_004' }))));
  assert.equal((await store.read()).tasks.length, 1);
});

test('operator update of a legacy-status card: the stored status is not rewritten by the display mapping, and the result says so', async () => {
  const store = fixture();
  await store.transaction(async board => { board.tasks.push({ id: 'SYNTH-LEG', title: 'Synthetic legacy', status: 'Verifying', owner: 'synthetic-owner', group: '現行', detail: 'https://example.invalid/legacy', lastConfirmedAt: null, version: 1, updatedAt: '2026-10-20T00:00:00.000Z' }); board.revision = 1; });
  const legacyOp = (over = {}, task = {}) => operation({ requestId: 'synthetic_leg_001', matchUrl: 'https://example.invalid/legacy', expectedVersion: 1, task: { ...operation().task, id: 'SYNTH-LEG', title: 'Synthetic legacy', status: 'In Progress', detail: 'operator note', ...task }, ...over });
  const kept = await applyOperatorBatch(store, batch(legacyOp()));
  assert.deepEqual([kept.results[0].status, kept.results[0].storedLegacyStatus, kept.results[0].statusPersisted], ['In Progress', 'Verifying', false]);
  assert.equal((await store.read()).tasks.find(t => t.id === 'SYNTH-LEG').status, 'Verifying', 'stored status unchanged');
  assert.equal((await inspectOperatorMatches(store, batch(legacyOp({ requestId: 'synthetic_leg_002' }))))[0].matches[0].status, 'Verifying', 'inspect reports the real stored status');
  assert.deepEqual((await applyOperatorBatch(store, batch(legacyOp()))).results[0], kept.results[0], 'replay returns the recorded result');
  // a different status is a real change and is stored as given (one of the four statuses); no legacy flag
  const changed = await applyOperatorBatch(store, batch(legacyOp({ requestId: 'synthetic_leg_003', expectedVersion: 2 }, { status: 'Blocked' })));
  assert.equal(changed.results[0].statusPersisted, undefined); assert.equal((await store.read()).tasks.find(t => t.id === 'SYNTH-LEG').status, 'Blocked');
  // a legacy status can never be written through the operator either
  await assert.rejects(applyOperatorBatch(store, batch(legacyOp({ requestId: 'synthetic_leg_004', expectedVersion: 3 }, { status: 'Verifying' }))));
});
