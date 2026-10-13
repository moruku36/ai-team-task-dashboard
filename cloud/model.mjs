import { createHash } from 'node:crypto';
export const statuses = ['To Do', 'In Progress', 'Awaiting Approval', 'Blocked', 'Verifying', 'Done'];
export const groups = ['現行', '要棚卸し', '完了履歴'];
export class Problem extends Error { constructor(status, message) { super(message); this.status = status; } }
export const emptyBoard = () => ({ revision: 0, tasks: [], receipts: {}, audit: [] });
const string = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Problem(400, 'Invalid text');
  return value;
};
export function canonicalTime(value) {
  if (typeof value !== 'string') throw new Problem(400, 'Invalid timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Problem(400, 'Invalid timestamp');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ms = Date.parse(value), parsed = new Date(ms);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(ms) || parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) throw new Problem(400, 'Invalid timestamp');
  return parsed.toISOString();
}
// Only this DTO crosses the HTTP boundary; storage extensions never do.
export function publicTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(503, 'Invalid stored task');
  const input = Object.fromEntries(['id', 'title', 'status', 'owner', 'group', 'detail', 'lastConfirmedAt'].map(key => [key, value[key]]));
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Problem(503, 'Invalid stored task');
  return { ...taskInput(input), version: value.version, updatedAt: canonicalTime(value.updatedAt) };
}
export function publicSnapshot(board) {
  if (!board || !Number.isSafeInteger(board.revision) || board.revision < 0 || !Array.isArray(board.tasks) || board.tasks.length > 1000) throw new Problem(503, 'Invalid stored board');
  const tasks = board.tasks.map(publicTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length || tasks.some(task => task.version > board.revision)) throw new Problem(503, 'Invalid stored board');
  return { revision: board.revision, tasks, observedAt: new Date().toISOString() };
}
export function taskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Problem(400, 'Invalid task');
  if (Object.keys(input).some(k => !['id', 'title', 'status', 'owner', 'group', 'detail', 'lastConfirmedAt'].includes(k))) throw new Problem(400, 'Unknown field');
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new Problem(400, 'Invalid ID');
  if (!statuses.includes(input.status) || !groups.includes(input.group)) throw new Problem(400, 'Invalid status/group');
  const confirmed = input.lastConfirmedAt == null ? null : canonicalTime(input.lastConfirmedAt);
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
    const prior = Object.hasOwn(board.receipts, command.requestId) ? board.receipts[command.requestId] : undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Problem(409, 'Request ID already used with another command');
      const result = publicTask(prior.result);
      if (result.version !== command.expectedVersion + 1 || Object.keys(task).some(key => result[key] !== task[key])) throw new Problem(503, 'Stored acknowledgement unavailable');
      return result;
    }
    const index = board.tasks.findIndex(t => t.id === task.id);
    const old = board.tasks[index];
    if ((old?.version ?? 0) !== command.expectedVersion) throw new Problem(409, 'Task changed; refresh before editing');
    if (!Number.isSafeInteger(board.revision) || board.revision < 0 || board.revision === Number.MAX_SAFE_INTEGER || command.expectedVersion === Number.MAX_SAFE_INTEGER) throw new Problem(409, 'Version limit reached');
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
