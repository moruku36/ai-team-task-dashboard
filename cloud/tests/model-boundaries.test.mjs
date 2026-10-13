import test from 'node:test';
import assert from 'node:assert/strict';
import { mutate } from '../model.mjs';
import { FixtureStore, command, task } from './fixtures.mjs';
test('task limit and receipt/audit retention boundaries reject stale retry', async () => {
  const store = new FixtureStore();
  store.state.tasks = Array.from({ length: 1000 }, (_, i) => ({ ...task, id: `SYNTH-${i}`, version: 1 }));
  await assert.rejects(mutate(store, { ...command(0, 'Done', 'task-limit'), task: { ...task, id: 'OVER-LIMIT' } }), e => e.status === 409);
  const history = new FixtureStore();
  for (let i = 0; i < 1001; i++) await mutate(history, command(i, 'To Do', `history-${i}`));
  const board = await history.read(); assert.equal(board.audit.length, 1000); assert.equal(Object.keys(board.receipts).length, 1000); assert.equal(board.receipts['history-0'], undefined);
  await assert.rejects(mutate(history, command(0, 'To Do', 'history-0')), e => e.status === 409);
  assert.equal((await mutate(history, command(1000, 'To Do', 'history-1000'))).version, 1001);
});
