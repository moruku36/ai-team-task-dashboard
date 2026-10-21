// Explicit operator jobs only; not imported by the HTTP server or ordinary build.
import { createHash } from 'node:crypto';
import { mutate, taskInput, publicSnapshot } from './model.mjs';
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const taskDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function validate(batch) {
  if (!batch || Object.keys(batch).some(k => !['version', 'operations'].includes(k)) || batch.version !== 1 || !Array.isArray(batch.operations) || batch.operations.length < 1 || batch.operations.length > 10) throw Error('Invalid batch');
  for (const op of batch.operations) {
    if (!op || Object.keys(op).some(k => !['requestId', 'matchUrl', 'task', 'expectedVersion'].includes(k)) || typeof op.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(op.requestId) || typeof op.matchUrl !== 'string' || op.matchUrl.length > 500) throw Error('Invalid operation');
    const url = new URL(op.matchUrl); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Invalid URL');
    taskInput(op.task); if (!Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 0) throw Error('Expected version required');
  }
}
const find = (board, op) => board.tasks.filter(t => t.id === op.task.id || t.detail.includes(op.matchUrl) || t.title.toLocaleLowerCase() === op.task.title.toLocaleLowerCase());
export async function inspectOperatorMatches(store, batch) {
  validate(batch); const board = await store.read(); publicSnapshot(board);
  return batch.operations.map(op => ({ requestId: op.requestId, matches: find(board, op).map(t => ({ id: t.id, version: t.version, status: t.status })) }));
}
export async function applyOperatorBatch(store, batch) {
  validate(batch);
  return store.transaction(async board => {
    publicSnapshot(board); const results = [];
    for (const op of batch.operations) {
      const key = 'operator_' + op.requestId, fingerprint = taskDigest(op);
      board.operatorReceipts ??= {};
      const receipt = board.operatorReceipts[key];
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw Error('Request reused'); results.push(receipt.result); continue; }
      const matches = find(board, op); if (matches.length > 1) throw Error('Ambiguous task');
      const current = matches[0]; if ((current?.version ?? 0) !== op.expectedVersion) throw Error('Task changed; inspect and review');
      const task = current ? { ...op.task, id: current.id, detail: `${current.detail}\n\n--- Operator update ---\n${op.task.detail}` } : op.task;
      const saved = await mutate({ transaction: async change => change(board) }, { requestId: op.requestId, expectedVersion: op.expectedVersion, task }, 'owner-operator');
      // The operator job cannot make an explicit status choice (no statusChange). For a card stored with a legacy status, an update that
      // keeps the displayed status leaves the stored legacy status in place; say so instead of letting `status` suggest it was persisted.
      const result = { id: saved.id, version: saved.version, status: saved.status, taskDigest: taskDigest(saved),
        ...(saved.legacyStatus ? { storedLegacyStatus: saved.legacyStatus, statusPersisted: false } : {}) };
      board.operatorReceipts[key] = { fingerprint, result };
      for (const key of Object.keys(board.operatorReceipts).slice(0, Math.max(0, Object.keys(board.operatorReceipts).length - 1000))) delete board.operatorReceipts[key];
      results.push(result);
    }
    return { revision: board.revision, results };
  });
}
