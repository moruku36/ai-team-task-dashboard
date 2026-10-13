import { createHash } from 'node:crypto';
export const statuses = ['To Do', 'In Progress', 'Awaiting Approval', 'Blocked', 'Verifying', 'Done'];
export const groups = ['現行', '要棚卸し', '完了履歴'];
export class Problem extends Error { constructor(status, message) { super(message); this.status = status; } }
export const emptyBoard = () => ({ revision: 0, tasks: [], receipts: {}, audit: [] });
const string = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Problem(400, 'Invalid text');
  return value;
};
export function taskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Problem(400, 'Invalid task');
  if (Object.keys(input).some(k => !['id', 'title', 'status', 'owner', 'group', 'detail', 'lastConfirmedAt'].includes(k))) throw new Problem(400, 'Unknown field');
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new Problem(400, 'Invalid ID');
  if (!statuses.includes(input.status) || !groups.includes(input.group)) throw new Problem(400, 'Invalid status/group');
  const confirmed = input.lastConfirmedAt ?? null;
  if (confirmed !== null && (typeof confirmed !== 'string' || !Number.isFinite(Date.parse(confirmed)))) throw new Problem(400, 'Invalid confirmation date');
  return { id: input.id, title: string(input.title, 300, true), status: input.status,
    owner: string(input.owner, 100, true), group: input.group, detail: string(input.detail ?? '', 10000), lastConfirmedAt: confirmed };
}
export async function mutate(store, command, actor = 'owner') {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).some(key => !['requestId', 'expectedVersion', 'task'].includes(key)) ||
      typeof command.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(command.requestId) ||
      ['__proto__', 'constructor', 'prototype'].includes(command.requestId) ||
      !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) throw new Problem(400, 'Request ID and expected version required');
  const task = taskInput(command.task);
  const fingerprint = createHash('sha256').update(JSON.stringify({ task, expectedVersion: command.expectedVersion, actor })).digest('hex');
  return store.transaction(board => {
    const prior = board.receipts[command.requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Problem(409, 'Request ID already used with another command');
      return prior.result;
    }
    const index = board.tasks.findIndex(t => t.id === task.id);
    const old = board.tasks[index];
    if ((old?.version ?? 0) !== command.expectedVersion) throw new Problem(409, 'Task changed; refresh before editing');
    if (!old && board.tasks.length >= 1000) throw new Problem(409, 'Task limit reached');
    const now = new Date().toISOString();
    const result = { ...task, version: (old?.version ?? 0) + 1, updatedAt: now };
    if (old) board.tasks[index] = result; else board.tasks.push(result);
    board.revision++;
    board.audit.push({ revision: board.revision, id: task.id, actor, at: now, from: old?.status ?? null, to: task.status });
    board.audit = board.audit.slice(-1000);
    board.receipts[command.requestId] = { fingerprint, result };
    const keys = Object.keys(board.receipts);
    for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) delete board.receipts[k];
    return result;
  });
}
