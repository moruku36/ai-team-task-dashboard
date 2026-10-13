import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handler, createVercelHandler, startLocalServer } from '../server.mjs';
import { emptyBoard, mutate } from '../model.mjs';
import { PostgresStore } from '../postgres.mjs';
import { app, FixtureStore, command, task, env } from './fixtures.mjs';
test('HTTP lifecycle, idempotency, concurrency and file-fixture restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-synthetic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.json'); await writeFile(file, JSON.stringify(emptyBoard()));
  let a = await app(new FixtureStore(file)); t.after(() => a.close());
  assert.equal(a.server.address().address, '127.0.0.1');
  for (const path of ['/', '/app.js', '/style.css', '/api?dashboard_path=app.js']) assert.equal((await a.get(path)).status, 200);
  for (const [i, status] of ['To Do', 'In Progress', 'Awaiting Approval', 'Done'].entries()) {
    assert.equal((await a.post(command(i, status, `lifecycle-${i}`))).status, 200);
    const board = await (await a.get('/api/tasks')).json(); assert.equal(board.tasks[0].status, status); assert.equal(board.tasks[0].version, i + 1); assert.ok(board.observedAt);
  }
  assert.equal((await (await a.post(command(3, 'Done', 'lifecycle-3'))).json()).version, 4);
  assert.equal((await a.post(command(3, 'Blocked', 'lifecycle-3'))).status, 409);
  assert.equal((await a.post(command(1, 'Blocked', 'stale-request'))).status, 409);
  const race = await Promise.all([a.post(command(4, 'Verifying', 'concurrent-a')), a.post(command(4, 'Blocked', 'concurrent-b'))]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  const before = await (await a.get('/api/tasks')).json(); await a.close(); a = await app(new FixtureStore(file));
  const after = await (await a.get('/api/tasks')).json(); assert.deepEqual(after.tasks, before.tasks); assert.equal(after.revision, 5);
});
test('HTTP write/read failures expose no secrets and same-ID retry commits once', async t => {
  const store = new FixtureStore(); const a = await app(store); t.after(() => a.close());
  const request = command(0, 'To Do', 'write-retry-id'); store.failWrite = true;
  const failed = await a.post(request); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /SECRET_SENTINEL/);
  assert.equal((await store.read()).revision, 0);
  store.failWrite = false;
  for (let i = 0; i < 2; i++) assert.equal((await a.post(request)).status, 200);
  assert.equal((await store.read()).revision, 1);
  const broken = await app({ read() { throw new Error('DATABASE_URL SECRET_SENTINEL'); } }); t.after(() => broken.close());
  const unavailable = await broken.get('/api/tasks'); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /DATABASE_URL|SECRET_SENTINEL/);
});
test('HTTP input boundaries, JSON/write header/origin, reserved IDs and single owner', async t => {
  const a = await app(); t.after(() => a.close());
  const request = command(0, 'To Do', 'boundary-task');
  const encoded = JSON.stringify(request);
  const exact = encoded + ' '.repeat(20000 - Buffer.byteLength(encoded));
  assert.equal((await a.post(exact)).status, 200);
  assert.equal((await a.post(exact + ' ')).status, 413);
  assert.equal((await a.post('{')).status, 400);
  assert.equal((await a.post('null')).status, 400);
  assert.equal((await a.post(request, { 'X-Dashboard-Write': '0' })).status, 403);
  assert.equal((await a.post(request, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await a.post(request, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await a.post(request, { Origin: '' })).status, 403);
  assert.equal((await a.post(request, { Origin: 'null' })).status, 403);
  assert.equal((await fetch(a.url + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify(request) })).status, 403);
  assert.equal((await a.post(command(1, 'Done', '__proto__'))).status, 400);
  for (const changed of [{ requestId: 12345678 }, { requestId: 'x'.repeat(101) }, { expectedVersion: '1' }, { unexpected: true }]) assert.equal((await a.post({ ...command(1, 'Done', 'bad-command'), ...changed })).status, 400);
  assert.equal((await a.post({ ...command(1, 'Done', 'numeric-task-id'), task: { ...task, id: 123 } })).status, 400);
  assert.equal((await a.post({ ...command(1, 'Done', 'array-owner'), task: { ...task, owner: ['a', 'b'] } })).status, 400);
  for (const [key, limit] of [['title', 300], ['owner', 100], ['detail', 10000]]) {
    const id = `LIMIT-${key}`;
    const base = { ...command(0, 'To Do', `limit-${key}-ok`), task: { ...task, id, [key]: 'x'.repeat(limit) } };
    assert.equal((await a.post(base)).status, 200);
    assert.equal((await a.post({ ...base, requestId: `limit-${key}-bad`, expectedVersion: 1, task: { ...base.task, [key]: 'x'.repeat(limit + 1) } })).status, 400);
  }
  for (const changed of [{ status: 'unknown' }, { group: 'unknown' }, { lastConfirmedAt: 'invalid' }, { unknownField: true }]) {
    assert.equal((await a.post({ ...command(1, 'Done', 'invalid-field'), task: { ...task, ...changed } })).status, 400);
  }
  assert.equal((await a.post(command(1, 'Done', 'x'.repeat(100)))).status, 200);
});
test('missing store/origin closes business routes despite spoofed headers/env flags', async t => {
  const spoof = { 'x-vercel-authenticated': 'true', 'x-vercel-user': 'owner', Authorization: 'Basic b3duZXI6c3ludGhldGlj' };
  for (const options of [{ store: undefined }, { env: {} }, { env: { DASHBOARD_ORIGIN: 'https://synthetic.invalid/path' } }]) {
    const a = await app(new FixtureStore(), options); t.after(() => a.close());
    for (const path of ['/', '/app.js', '/style.css', '/api/tasks', '/api/index?dashboard_path=api/tasks']) {
      const denied = await fetch(a.url + path, { headers: spoof }); assert.equal(denied.status, 503); assert.equal(denied.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await denied.text(), /SECRET_SENTINEL/);
    }
  }
});
test('Vercel entry connects store normally; missing config and connection failure return 503', async t => {
  for (const configuration of [{}, { DATABASE_URL: 'synthetic' }, { DATABASE_URL: 'synthetic', DASHBOARD_ORIGIN: 'http://synthetic.invalid' }]) {
    let called = 0;
    const server = createServer(createVercelHandler({ env: { ...configuration, VERCEL: '1', DASHBOARD_PROTECTION_VERIFIED: 'true' }, connect: async () => { called++; throw new Error('must not connect'); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, { headers: { 'x-vercel-authenticated': 'true' } })).status, 503); assert.equal(called, 0);
  }
  const configuration = { DATABASE_URL: 'postgresql://synthetic.invalid/test', DASHBOARD_ORIGIN: 'https://synthetic.invalid' };
  const store = new FixtureStore(); let calls = 0;
  const server = createServer(createVercelHandler({ env: configuration, connect: async supplied => { assert.equal(supplied, configuration); calls++; if (calls === 1) throw new Error('SECRET_SENTINEL'); return store; } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const failed = await fetch(base + '/api/tasks'); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /SECRET_SENTINEL/);
  assert.equal((await fetch(base + '/api/index?dashboard_path=api/tasks')).status, 200);
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { Origin: configuration.DASHBOARD_ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify(command(0, 'To Do', 'production-fixture')) })).status, 200);
  assert.equal(calls, 2); assert.equal((await store.read()).revision, 1);
});
test('local entry uses ephemeral synthetic store on loopback only', async t => {
  const first = await startLocalServer(0); t.after(() => new Promise(resolve => first.close(resolve)));
  assert.equal(first.address().address, '127.0.0.1'); const base = `http://127.0.0.1:${first.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' };
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify(command(0, 'To Do', 'local-synthetic')) })).status, 200);
  const second = await startLocalServer(0); t.after(() => new Promise(resolve => second.close(resolve)));
  assert.equal((await (await fetch(`http://127.0.0.1:${second.address().port}/api/tasks`)).json()).tasks.length, 0);
});
test('Postgres same-client commit and rollback; simulated commit failure', async () => {
  const calls = []; let releases = 0, failCommit = false;
  const pool = { async connect() { return { async query(sql) { calls.push(sql); if (failCommit && sql === 'COMMIT') throw new Error('uncertain commit'); return { rows: [{ document: emptyBoard() }] }; }, release() { releases++; } }; } };
  const store = new PostgresStore(pool);
  await mutate(store, command(0, 'To Do', 'postgres-create'));
  assert.equal(calls[0], 'BEGIN'); assert.match(calls[1], /FOR UPDATE/); assert.match(calls[2], /\$1::jsonb/); assert.equal(calls[3], 'COMMIT');
  calls.length = 0; await assert.rejects(store.transaction(() => { throw new Error('abort'); })); assert.equal(calls.at(-1), 'ROLLBACK');
  calls.length = 0; failCommit = true; await assert.rejects(mutate(store, command(0, 'Done', 'commit-failure'))); assert.equal(calls.at(-1), 'ROLLBACK'); assert.equal(releases, 3);
});
test('platform-preparsed JSON/rewrite and split UTF-8 with strict Origin', async () => {
  const store = new FixtureStore(); let code, body;
  const req = { method: 'POST', url: '/api/index?dashboard_path=api/tasks', query: { dashboard_path: 'api/tasks' }, headers: { origin: env.DASHBOARD_ORIGIN, 'content-type': 'application/json', 'x-dashboard-write': '1' }, body: command(0, 'To Do', 'platform-body') };
  const res = { setHeader() {}, writeHead(value) { code = value; }, end(value) { body = JSON.parse(value); } };
  await handler({ store, env })(req, res); assert.equal(code, 200); assert.equal(body.version, 1);
  req.body = undefined;
  const streamed = { ...command(1, 'In Progress', 'split-utf8-body'), task: { ...task, title: '分割された日本語' } };
  req[Symbol.asyncIterator] = async function* () { for (const byte of Buffer.from(JSON.stringify(streamed))) yield Buffer.from([byte]); };
  await handler({ store, env })(req, res);
  assert.equal(code, 200); assert.equal(body.title, streamed.task.title); assert.equal(body.version, 2);
  req.body = { oversized: 'x'.repeat(20001) };
  await handler({ store, env })(req, res); assert.equal(code, 413);
});
