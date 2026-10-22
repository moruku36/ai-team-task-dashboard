import test from 'node:test';
import assert from 'node:assert/strict';
import { runInContext, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
// Synthetic DOM data harness (rendering logic only). Verifies that "0 tasks" / "last received" are never claimed before a real, validated snapshot.
class Element { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {} }
const text = element => [element.textContent, ...element.children.map(text)].join(' ');
async function load(responder) {
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {}, fetch: path => responder(path) });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  return { el, refresh: () => runInContext('refresh()', context) };
}
const snapshot = tasks => ({ revision: tasks.length, observedAt: new Date().toISOString(), tasks });
const task = { id: 'SYNTH-1', title: '合成', owner: 'synthetic-agent', group: '現行', status: 'To Do', detail: '', lastConfirmedAt: null, version: 1, updatedAt: new Date().toISOString() };
const ok = body => ({ ok: true, json: async () => body });

test('first fetch failure: counts are unfetched (—), never 0, and no "last received" claim is made', async () => {
  const ui = await load(async () => { throw new Error('offline'); });
  await ui.refresh();
  const board = text(ui.el('board')), groups = text(ui.el('groups'));
  assert.match(groups, /現行 · —/); assert.doesNotMatch(groups + board, /· 0\b/); assert.equal((board.match(/· —/g) ?? []).length, 4);
  assert.equal(ui.el('times').textContent, '未取得'); assert.match(ui.el('notice').textContent, /まだタスクを取得できていません/);
  assert.doesNotMatch(ui.el('times').textContent + ui.el('notice').textContent, /最後に取得|最終取得|タスク一覧の同期/); assert.equal(ui.el('connection').textContent, '接続できません');
});

test('validated empty success shows true 0 and a received time; a malformed response is not an accepted snapshot', async () => {
  const ui = await load(async () => ok(snapshot([])));
  await ui.refresh();
  assert.match(text(ui.el('groups')), /現行 · 0/); assert.equal((text(ui.el('board')).match(/· 0/g) ?? []).length, 4);
  assert.match(ui.el('times').textContent, /タスク一覧の同期/); assert.equal(ui.el('notice').textContent, ''); assert.equal(ui.el('connection').textContent, '接続中');
  const rejected = await load(async () => ok({ revision: 0, observedAt: new Date().toISOString() })); // missing tasks array: not an accepted snapshot
  await rejected.refresh(); assert.match(text(rejected.el('groups')), /現行 · —/); assert.equal(rejected.el('times').textContent, '未取得');
});

test('prior accepted snapshot then failure: snapshot is preserved and marked possibly stale (only then is "last received" claimed)', async () => {
  let mode = 'ok';
  const ui = await load(async () => { if (mode === 'down') throw new Error('offline'); return ok(snapshot([task])); });
  await ui.refresh(); assert.match(text(ui.el('groups')), /現行 · 1/); assert.match(text(ui.el('board')), /合成/);
  mode = 'down'; await ui.refresh();
  assert.match(text(ui.el('groups')), /現行 · 1/); assert.match(text(ui.el('board')), /合成/); // preserved, not reset to 0 or —
  assert.match(ui.el('times').textContent, /タスク一覧の同期.*古い可能性/); assert.match(ui.el('notice').textContent, /最後に取得した状態.*古い可能性/); assert.equal(ui.el('connection').textContent, '接続できません');
});
