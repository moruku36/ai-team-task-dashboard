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
