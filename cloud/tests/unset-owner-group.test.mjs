import test from 'node:test';
import assert from 'node:assert/strict';
import { runInContext, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { taskInput, publicSnapshot, publicTask, mutate, emptyBoard, Problem } from '../model.mjs';
import { convertBacklogFiles } from '../import-snapshot.mjs';
import { app, FixtureStore, task } from './fixtures.mjs';

// Synthetic data only. "Unset" is owner '' and group null; nothing else is loosened.
const unset = { ...task, id: 'UNSET-1', owner: '', group: null };
const stored = (t, version = 1) => ({ ...t, version, updatedAt: '2026-10-20T00:00:00.000Z' });

test('model: unset owner/group are accepted; every other invalid value is still rejected', () => {
  assert.deepEqual([taskInput(unset).owner, taskInput(unset).group], ['', null]);
  assert.equal(taskInput({ ...task, owner: '', group: '現行' }).group, '現行');
  assert.equal(taskInput({ ...task, group: null }).owner, 'synthetic-agent');
  for (const bad of [{ owner: null }, { owner: undefined }, { owner: '   ' }, { owner: ['a'] }, { owner: 5 }, { owner: 'x'.repeat(101) },
    { group: undefined }, { group: '' }, { group: '未分類' }, { group: 'null' }, { group: 0 }, { group: ['現行'] }, { group: '不明な分類' }])
    assert.throws(() => taskInput({ ...task, ...bad }), Problem, JSON.stringify(bad));
  const withoutGroup = { ...task }; delete withoutGroup.group; assert.throws(() => taskInput(withoutGroup), Problem);
  assert.throws(() => taskInput({ ...unset, assignee: 'x' }), /Unknown field/);
});

test('read: an unset card does not break the snapshot, but a stored unknown value still does (503)', () => {
  const view = publicSnapshot({ revision: 2, tasks: [stored(task, 1), stored(unset, 2)], receipts: {}, audit: [] });
  assert.equal(view.tasks.length, 2);
  assert.deepEqual([view.tasks[1].owner, view.tasks[1].group], ['', null]);
  for (const bad of [{ group: undefined }, { group: '未分類' }, { owner: null }, { owner: '  ' }]) {
    const t = { ...stored(unset, 1), ...bad };
    assert.throws(() => publicTask(t), e => e instanceof Problem || e.status === 400 || e.status === 503, JSON.stringify(bad));
  }
});

test('HTTP: unset cards save, re-read, edit with CAS and dedupe; history and ordinary cards are unaffected', async t => {
  const store = new FixtureStore(); const a = await app(store); t.after(() => a.close());
  const cmd = (id, version, status, requestId, extra = {}) => ({ requestId, expectedVersion: version, task: { ...unset, id, status, ...extra } });
  assert.equal((await a.post({ requestId: 'ordinary-seed-1', expectedVersion: 0, task })).status, 200);
  const created = await a.post(cmd('UNSET-1', 0, 'To Do', 'unset-create-1'));
  assert.equal(created.status, 200);
  const first = await created.json(); assert.deepEqual([first.owner, first.group, first.version], ['', null, 1]);
  assert.equal((await a.post(cmd('UNSET-1', 0, 'To Do', 'unset-create-1'))).status, 200);          // duplicate request: one commit
  assert.equal((await store.read()).revision, 2);
  assert.equal((await a.post(cmd('UNSET-1', 0, 'Done', 'unset-create-2'))).status, 409);          // stale CAS
  assert.equal((await a.post(cmd('UNSET-1', 1, 'Blocked', 'unset-edit-1'))).status, 200);
  assert.equal((await a.post(cmd('UNSET-1', 1, 'Done', 'unset-edit-1'))).status, 409);            // request ID reuse with other content
  const board = await (await a.get('/api/tasks')).json();
  const card = board.tasks.find(x => x.id === 'UNSET-1');
  assert.deepEqual([card.owner, card.group, card.status, card.version], ['', null, 'Blocked', 2]);
  assert.deepEqual(board.tasks.find(x => x.id === 'SYNTH-1').group, '現行');
  const audit = (await store.read()).audit; assert.deepEqual(audit.at(-1).from, 'To Do'); assert.equal(audit.at(-1).to, 'Blocked');
  for (const bad of [{ owner: null }, { group: undefined }, { group: '未分類' }, { owner: ' ' }])
    assert.equal((await a.post(cmd('UNSET-BAD', 0, 'To Do', `bad-${Object.keys(bad)[0]}-${JSON.stringify(bad).length}`, bad))).status, 400, JSON.stringify(bad));
  assert.equal((await (await a.get('/api/tasks')).json()).tasks.length, 2);
});

test('converter: unset fields stay unset, source dates stay in a separate private record, malformed values still fail', () => {
  const file = (id, front) => ({ filename: id + '.md', base64: Buffer.from(`---\nid: ${id}\ntitle: 'Synthetic'\nstatus: Done\n${front}---\nbody\n`).toString('base64') });
  const out = convertBacklogFiles([
    file('T-1', "assignee:\n  - '@x'\nlabels:\n  - '表示:現行'\ncreated_date: '2026-10-11 09:54'\nupdated_date: '2026-10-12 10:00'\n"),
    file('T-2', "assignee:\n  - '@x'\nlabels: []\ncreated_date: '2026-10-11 09:54'\n"),
    file('T-3', "assignee: []\nlabels:\n  - '表示:要棚卸し'\ncreated_date: '2026-10-11 09:54'\nupdated_date: '2026-10-13 10:00'\n"),
    file('T-4', "labels:\n  - '分類:開発'\ncreated_date: '2026-10-11 09:54'\n")]);
  const by = Object.fromEntries(out.board.tasks.map(t => [t.id, t])), rec = Object.fromEntries(out.records.map(r => [r.id, r]));
  assert.deepEqual([by['T-1'].owner, by['T-1'].group], ['@x', '現行']);
  assert.deepEqual([by['T-2'].owner, by['T-2'].group], ['@x', null]);
  assert.deepEqual([by['T-3'].owner, by['T-3'].group], ['', '要棚卸し']);
  assert.deepEqual([by['T-4'].owner, by['T-4'].group], ['', null]);   // no placeholder person/category invented
  assert.deepEqual([rec['T-1'].sourceUpdatedDate, rec['T-1'].updatedAtBasis], ['2026-10-12 10:00', 'updated_date']);
  assert.deepEqual([rec['T-2'].sourceUpdatedDate, rec['T-2'].sourceCreatedDate, rec['T-2'].updatedAtBasis], [null, '2026-10-11 09:54', 'created_date']);
  assert.deepEqual([rec['T-4'].ownerUnset, rec['T-4'].groupUnset], [true, true]);
  assert.equal(JSON.stringify(out.board).includes('sourceUpdatedDate'), false, 'private record is not part of the board');
  for (const front of ["assignee: x\nlabels: []\ncreated_date: '2026-10-11 09:54'\n", "assignee: []\nlabels:\n  - '表示:現行'\n  - '表示:完了履歴'\ncreated_date: '2026-10-11 09:54'\n",
    "assignee: []\nlabels:\n  - '表示:謎'\ncreated_date: '2026-10-11 09:54'\n", "assignee: []\nlabels: []\n"])
    assert.throws(() => convertBacklogFiles([file('T-9', front)]), front);
});

class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {}
}
const text = e => [e.textContent, ...e.children.map(text)].join(' ');

test('UI: 未分類 tab keeps unset cards visible, counted and searchable; saving keeps owner/group unset; invalid group is rejected client-side', async () => {
  const store = new FixtureStore(); const a = await app(store);
  try {
    await mutate(store, { requestId: 'ui-seed-ordinary', expectedVersion: 0, task: { ...task, id: 'UI-A' } });
    await mutate(store, { requestId: 'ui-seed-unset-1', expectedVersion: 0, task: { ...unset, id: 'UI-U1', title: '未設定カード' } });
    await mutate(store, { requestId: 'ui-seed-unset-2', expectedVersion: 0, task: { ...unset, id: 'UI-U2', status: 'Blocked', group: '完了履歴', title: '担当のみ未設定' } });
    const elements = new Map(), posts = []; const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {},
      fetch: (path, options) => { if (options?.method === 'POST') posts.push(JSON.parse(options.body)); return fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } }); } });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
    await runInContext('refresh()', context);
    const tabs = el('groups').children.map(b => b.textContent);
    assert.deepEqual(tabs, ['現行 · 1', '要棚卸し · 0', '完了履歴 · 1', '未分類 · 1']);
    assert.equal(tabs.reduce((n, t) => n + Number(/· (\d+)/.exec(t)[1]), 0), 3, 'every card is counted exactly once');
    assert.equal(el('connection').textContent, '接続中', 'unset cards do not invalidate the whole snapshot');
    el('groups').children[3].onclick();
    const column = () => el('board').children.find(c => c.children[0].textContent.startsWith('To Do ·'));
    assert.match(text(column()), /未設定カード/); assert.match(text(column()), /主担当: 未設定/);
    el('search').value = '担当未設定'; runInContext('render()', context);
    assert.match(text(column()), /未設定カード/, 'search still finds the card');
    el('search').value = ''; runInContext('render()', context);
    const card = column().children[1]; card.onclick(); assert.match(el('detailBody').textContent, /主担当: 未設定/);
    el('status').value = 'Done'; await el('save').onclick();
    assert.equal(posts.length, 1); assert.deepEqual([posts[0].task.owner, posts[0].task.group], ['', null]);
    const saved = (await store.read()).tasks.find(t => t.id === 'UI-U1'); assert.deepEqual([saved.owner, saved.group, saved.status, saved.version], ['', null, 'Done', 2]);
    // a snapshot that carries an unknown group value is still refused by the client
    const bad = { revision: 9, observedAt: new Date().toISOString(), tasks: [{ ...task, group: '未分類', version: 1, updatedAt: '2026-10-20T00:00:00.000Z' }] };
    assert.equal(runInContext(`validSnapshot(${JSON.stringify(bad)})`, context), false);
  } finally { await a.close(); }
});
