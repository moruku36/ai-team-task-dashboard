import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../postgres.mjs';
function fixture() { const calls = []; const client = { query: async (sql, params) => { calls.push(sql); if (sql.startsWith('SELECT')) return { rows: [{ document: { revision: 0 } }] }; return { rows: [] }; }, release() { calls.push('release'); } }; return { calls, store: new PostgresStore({ connect: async () => client }) }; }
test('operator asynchronous mutation finishes before UPDATE/COMMIT', async () => {
  const { store, calls } = fixture(); const result = await store.transaction(async board => { await Promise.resolve(); board.revision++; return 1; });
  assert.equal(result, 1); assert.match(calls[2], /^UPDATE/); assert.equal(calls[3], 'COMMIT');
});
test('operator asynchronous rejection rolls back without UPDATE/COMMIT', async () => {
  const { store, calls } = fixture(); await assert.rejects(store.transaction(async () => { await Promise.resolve(); throw Error('synthetic failure'); }));
  assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT')); assert.ok(!calls.some(sql => sql.startsWith('UPDATE')));
});
