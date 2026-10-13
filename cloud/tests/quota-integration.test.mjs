import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { app, FixtureStore, command, env } from './fixtures.mjs';
import { syntheticOwnerAuthorize } from './synthetic-auth.mjs'; // TEST-ONLY synthetic owner callback
import { SyntheticQuotaStore } from '../synthetic.mjs';
import { createVercelHandler } from '../server.mjs';
import { emptyBoard } from '../model.mjs';
import { assets } from '../build.mjs';
// Synthetic fixtures only: no collector, no network beyond loopback test servers.
const NOW = new Date('2030-01-01T12:00:00.000Z');
const online = { status: 'online', heartbeatAt: '2030-01-01T11:59:30.000Z' };
const rec = (over = {}) => ({ provider: 'codex', source: 'native', state: 'ok', observedAt: '2030-01-01T11:58:00.000Z', collectedAt: '2030-01-01T11:58:30.000Z',
  lastSuccessAt: '2030-01-01T11:58:30.000Z', resetAt: '2030-01-01T17:00:00.000Z', usedPercent: 42, staleAfterSeconds: 3600, collector: online, ...over });
const quotaApp = (records, options = {}) => app(new FixtureStore(), { quotaStore: new SyntheticQuotaStore(records), now: () => NOW, ...options });
const entryOf = async (record, options) => { const a = await quotaApp([record], options); try { return (await (await a.get('/api/quota')).json()).entries[0]; } finally { await a.close(); } };
const spies = () => ({ store: { reads: 0, writes: 0, async read() { this.reads++; return emptyBoard(); }, async transaction() { this.writes++; throw new Error('must not write'); } },
  quotaStore: { reads: 0, async read() { this.reads++; return { records: [] }; } } });
const root = path => new URL('../../' + path, import.meta.url);

test('unauthenticated, rejected, errored and non-owner GET/POST fail closed with no storage access, including rewritten paths', async t => {
  const spoof = { 'x-vercel-authenticated': 'true', 'x-vercel-user': 'owner', 'x-dashboard-owner': '1', Authorization: 'Bearer synthetic', Cookie: 'session=owner' };
  const hostile = { ...env, VERCEL: '1', DASHBOARD_PROTECTION_VERIFIED: 'true', DASHBOARD_AUTH_BYPASS: '1' };
  const variants = [[undefined, 503], [() => null, 401], [async () => ({ verified: false, role: 'owner', subject: 'x' }), 401], [async () => ({ role: 'owner', subject: 'x' }), 401],
    [async () => ({ verified: 'true', role: 'owner', subject: 'x' }), 401], [async () => { throw new Error('SECRET_SENTINEL'); }, 503],
    [async () => ({ verified: true, role: 'viewer', subject: 'x' }), 403], [async () => ({ verified: true, role: 'owner', subject: '' }), 403]];
  const requests = [['GET', '/api/tasks'], ['POST', '/api/tasks'], ['GET', '/api/quota'], ['POST', '/api/quota'],
    ['GET', '/api/index?dashboard_path=api/tasks'], ['GET', '/api/index?dashboard_path=api/quota'], ['POST', '/api/index?dashboard_path=api/tasks'], ['GET', '/api?dashboard_path=api/quota']];
  for (const [authorize, expected] of variants) {
    const { store, quotaStore } = spies(), a = await app(store, { authorize, quotaStore, env: hostile }); t.after(() => a.close());
    for (const [method, path] of requests) {
      const response = await fetch(a.url + path, { method, headers: { ...spoof, Origin: hostile.DASHBOARD_ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: method === 'POST' ? JSON.stringify(command(0, 'To Do', 'denied-write')) : undefined });
      assert.equal(response.status, expected, `${method} ${path}`); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /SECRET_SENTINEL/);
    }
    assert.deepEqual([store.reads, store.writes, quotaStore.reads], [0, 0, 0]);
    // The 3 static assets (no data) load without a session so the sign-in UI is reachable; still no storage access.
    for (const path of ['/', '/app.js', '/style.css']) assert.equal((await fetch(a.url + path)).status, 200);
    assert.deepEqual([store.reads, store.writes, quotaStore.reads], [0, 0, 0]);
  }
});

test('createVercelHandler denies before DB initialization without a verified owner; default export has no auth adapter', async t => {
  const cfg = { DATABASE_URL: 'postgresql://synthetic.invalid/test', DASHBOARD_ORIGIN: 'https://synthetic.invalid', VERCEL: '1' };
  let connects = 0; const connect = async () => { connects++; return new FixtureStore(); };
  const cases = [[undefined, 503], [() => null, 401], [async () => ({ verified: true, role: 'viewer', subject: 'x' }), 403], [async () => { throw new Error('SECRET_SENTINEL'); }, 503]];
  for (const [authorize, expected] of cases) {
    const server = createServer(createVercelHandler({ env: cfg, connect, authorize })); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/tasks', '/api/quota', '/api/index?dashboard_path=api/quota']) { const response = await fetch(base + path, { headers: { 'x-vercel-authenticated': 'true' } }); assert.equal(response.status, expected); assert.doesNotMatch(await response.text(), /SECRET_SENTINEL/); }
  }
  assert.equal(connects, 0);
  const ok = createServer(createVercelHandler({ env: cfg, connect, authorize: syntheticOwnerAuthorize })); await new Promise(r => ok.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => ok.close(r)));
  const body = await (await fetch(`http://127.0.0.1:${ok.address().port}/api/quota`)).json(); assert.equal(connects, 1); assert.deepEqual(body.entries, []); // no real quota store is wired
  const { default: production } = await import('../../api/index.mjs'); let code;
  await production({ method: 'GET', url: '/api/tasks', headers: { 'x-vercel-authenticated': 'true' } }, { writeHead(c) { code = c; }, setHeader() {}, end() {} });
  assert.equal(code, 503); assert.doesNotMatch(await readFile(root('api/index.mjs'), 'utf8'), /synthetic|tests\//i);
});

test('authorized synthetic quota keeps collected/observed/last-success/reset separate from served time; TTL capped at 3600s', async () => {
  let a = await quotaApp([rec()]); let body = await (await a.get('/api/quota')).json(); await a.close();
  assert.deepEqual(Object.keys(body).sort(), ['entries', 'servedAt']); const e = body.entries[0];
  assert.equal(body.servedAt, '2030-01-01T12:00:00.000Z'); assert.equal(e.freshness, 'current'); assert.equal(e.freshnessBasis, 'observed'); assert.equal(e.usedPercent, 42);
  assert.deepEqual([e.observedAt, e.collectedAt, e.lastSuccessAt, e.resetAt], ['2030-01-01T11:58:00.000Z', '2030-01-01T11:58:30.000Z', '2030-01-01T11:58:30.000Z', '2030-01-01T17:00:00.000Z']);
  assert.equal(e.freshnessAgeMs, 120000);
  a = await quotaApp([rec()], { now: () => new Date('2030-01-01T12:02:00.000Z') }); body = await (await a.get('/api/quota')).json(); await a.close();
  assert.equal(body.servedAt, '2030-01-01T12:02:00.000Z'); assert.equal(body.entries[0].collectedAt, e.collectedAt); assert.equal(body.entries[0].observedAt, e.observedAt);
  const old = { observedAt: '2030-01-01T10:30:00.000Z', collectedAt: '2030-01-01T10:30:00.000Z' };
  const capped = await entryOf(rec({ ...old, staleAfterSeconds: 7200 })); assert.equal(capped.staleAfterSeconds, 3600); assert.equal(capped.freshness, 'stale');
  for (const bad of [undefined, 0, -5, NaN, '900', null]) assert.equal((await entryOf(rec({ staleAfterSeconds: bad }))).staleAfterSeconds, 3600);
  assert.equal((await entryOf(rec({ staleAfterSeconds: 60, observedAt: '2030-01-01T11:57:00.000Z', collectedAt: '2030-01-01T11:57:00.000Z' }))).freshness, 'stale');
  assert.equal((await entryOf(rec({ observedAt: '2030-01-01T11:00:30.000Z', collectedAt: '2030-01-01T11:59:00.000Z' }))).freshness, 'current'); // 59m30s: older of observed/collected, still inside 3600s
  assert.equal((await entryOf(rec({ observedAt: '2030-01-01T10:59:59.000Z', collectedAt: '2030-01-01T11:59:00.000Z' }))).freshness, 'stale'); // observation older than TTL even though collection is recent
});

test('collector offline, missing/silent/future heartbeat is reference and never current', async () => {
  for (const collector of [{ status: 'offline', heartbeatAt: '2030-01-01T11:59:59.000Z' }, { status: 'online', heartbeatAt: '2030-01-01T11:00:00.000Z' }, { status: 'online' }, undefined, { status: 'online', heartbeatAt: '2030-01-01T13:00:00Z' }, { status: 'online', heartbeatAt: '2030-02-31T11:59:00Z' }]) {
    const e = await entryOf(rec({ collector })); assert.equal(e.freshness, 'reference', JSON.stringify(collector)); assert.ok(e.reasons.includes('collector-offline'));
    assert.equal(e.collectedAt, '2030-01-01T11:58:30.000Z'); // collection time is not replaced by anything served
  }
});

test('future observed/collected/last-success timestamps are never current', async () => {
  for (const over of [{ observedAt: '2030-01-01T12:05:00.000Z' }, { collectedAt: '2030-01-01T12:05:00.000Z' }, { lastSuccessAt: '2030-01-01T12:05:00.000Z' }]) {
    const e = await entryOf(rec(over)); assert.notEqual(e.freshness, 'current', JSON.stringify(over)); assert.ok(['stale', 'unknown'].includes(e.freshness));
  }
  assert.equal((await entryOf(rec({ observedAt: '2030-01-01T12:05:00.000Z' }))).freshness, 'stale'); // existing local contract: future observation is stale
});

test('stale, reset awaiting_refresh, failed/ambiguous/missing state, and native observed_at vs AG fallback never become current', async () => {
  const stale = await entryOf(rec({ observedAt: '2030-01-01T10:00:00.000Z', collectedAt: '2030-01-01T10:00:00.000Z' })); assert.equal(stale.freshness, 'stale');
  const reset = await entryOf(rec({ resetAt: '2030-01-01T11:59:00.000Z' }));
  assert.equal(reset.resetState, 'awaiting_refresh'); assert.equal(reset.freshness, 'stale'); assert.equal(reset.resetAt, '2030-01-01T11:59:00.000Z'); assert.ok(reset.reasons.includes('reset-awaiting-refresh'));
  assert.equal((await entryOf(rec({ resetAt: 'not-a-time' }))).resetState, 'invalid');
  const known = { usedPercent: 31, observedAt: '2030-01-01T09:00:00.000Z' };
  for (const state of ['failed', 'ambiguous', 'missing']) {
    const kept = await entryOf(rec({ state, lastKnown: known })); assert.equal(kept.freshness, 'reference'); assert.equal(kept.usedPercent, null); assert.deepEqual(kept.lastKnown, known);
    const none = await entryOf(rec({ state })); assert.equal(none.freshness, 'unknown'); assert.equal(none.lastKnown, null); assert.ok(none.reasons.includes('state-' + state));
  }
  assert.equal((await entryOf(rec({ state: 'bogus' }))).freshness, 'unknown');
  // state "ok" without a valid percentage cannot claim availability; last-known is separate and must be valid, non-future history.
  for (const bad of [undefined, null, NaN, Infinity, -1, 101, '42']) {
    const e = await entryOf(rec({ usedPercent: bad })); assert.equal(e.state, 'missing', String(bad)); assert.equal(e.freshness, 'unknown'); assert.equal(e.usedPercent, null); assert.ok(e.reasons.includes('used-percent-invalid'));
  }
  const viaKnown = await entryOf(rec({ usedPercent: undefined, lastKnown: known })); assert.equal(viaKnown.freshness, 'reference'); assert.equal(viaKnown.usedPercent, null); assert.deepEqual(viaKnown.lastKnown, known);
  for (const lastKnown of [{ usedPercent: 31, observedAt: '2030-01-01T12:30:00.000Z' }, { usedPercent: 31, observedAt: '2030-02-31T09:00:00Z' }, { usedPercent: 131, observedAt: '2030-01-01T09:00:00Z' }, { usedPercent: 31 }]) {
    const e = await entryOf(rec({ state: 'failed', lastKnown })); assert.equal(e.lastKnown, null); assert.equal(e.freshness, 'unknown'); assert.equal(e.usedPercent, null);
  }
  const noObserved = { observedAt: undefined };
  assert.equal((await entryOf(rec(noObserved))).freshness, 'unknown'); assert.equal((await entryOf(rec({ ...noObserved, provider: 'claude' }))).freshness, 'unknown');
  assert.equal((await entryOf(rec({ ...noObserved, provider: 'ag', source: 'statusline' }))).freshness, 'unknown');
  const fallback = await entryOf(rec({ ...noObserved, provider: 'ag', source: 'cli' })); assert.equal(fallback.freshness, 'current'); assert.equal(fallback.freshnessBasis, 'collected_fallback'); assert.equal(fallback.observedAt, null);
  assert.equal((await entryOf(rec({ source: 'cli' }))).freshness, 'unknown'); // codex has no CLI fallback: unrecognized source
});

test('quota DTO is a strict allowlist: unknown/secret/path/per-model fields and unknown providers are dropped', async () => {
  const SENTINEL = 'SYNTHETIC_PRIVATE_FIELD';
  const dirty = rec({ token: SENTINEL, apiKey: SENTINEL, sourcePath: 'C:/' + SENTINEL, models: { 'model-a': { usedPercent: 9 } }, perModel: [SENTINEL], collector: { ...online, secret: SENTINEL, path: SENTINEL }, lastKnown: { usedPercent: 1, observedAt: '2030-01-01T09:00:00Z', token: SENTINEL } });
  const a = await quotaApp([dirty, rec({ provider: 'gemini' }), { provider: 'ag', source: 'cli', token: SENTINEL }, 'text', null, rec({ provider: 'codex', usedPercent: 150 }), rec({ usedPercent: 1 })]); {
    const text = await (await a.get('/api/quota')).text(); await a.close();
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_FIELD|token|apiKey|sourcePath|models|perModel|secret|gemini|C:/);
    const body = JSON.parse(text); assert.deepEqual(body.entries.map(e => `${e.provider}/${e.source}`), ['codex/native', 'ag/cli']); // one provider-level entry per key; duplicates collapse to one ambiguous entry
    const dup = body.entries[0]; assert.equal(dup.state, 'ambiguous'); assert.equal(dup.freshness, 'unknown'); assert.equal(dup.usedPercent, null); assert.equal(dup.lastKnown, null); assert.deepEqual(dup.reasons, ['duplicate-records', 'state-ambiguous']);
    assert.deepEqual([dup.observedAt, dup.collectedAt, dup.lastSuccessAt, dup.resetAt], [null, null, null, null]); // neither the first nor the last conflicting record is selected
    const allowed = ['provider', 'source', 'freshness', 'state', 'resetState', 'freshnessBasis', 'freshnessAgeMs', 'staleAfterSeconds', 'observedAt', 'collectedAt', 'lastSuccessAt', 'resetAt', 'usedPercent', 'lastKnown', 'reasons'].sort();
    for (const e of body.entries) assert.deepEqual(Object.keys(e).sort(), allowed);
    assert.equal(body.entries[1].freshness, 'unknown');
  }
  const single = await entryOf(dirty); assert.equal(single.usedPercent, 42); assert.equal(single.freshness, 'current'); // the same record alone is fine
  for (const records of [[rec(), rec()], [rec({ usedPercent: 10 }), rec({ usedPercent: 90 })], [rec({ usedPercent: 10 }), rec({ usedPercent: 90 })].reverse(), [rec(), rec({ state: 'failed' }), rec({ usedPercent: 5 })]]) {
    const a = await quotaApp(records); const { entries } = await (await a.get('/api/quota')).json(); await a.close();
    assert.equal(entries.length, 1); assert.deepEqual([entries[0].freshness, entries[0].usedPercent, entries[0].state], ['unknown', null, 'ambiguous']);
  }
  const bad = await app(new FixtureStore(), { quotaStore: { read: async () => ({ records: 'SYNTHETIC_PRIVATE_FIELD' }) } }); const failed = await bad.get('/api/quota');
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /SYNTHETIC_PRIVATE_FIELD|records/); await bad.close();
});

test('existing /api/tasks wire DTO, CAS and idempotency are unchanged when quota is attached', async () => {
  const a = await quotaApp([rec()]); try {
    const request = command(0, 'To Do', 'compat-create'); const created = await a.post(request); assert.equal(created.status, 200);
    assert.deepEqual(Object.keys(await created.json()).sort(), ['detail', 'group', 'id', 'lastConfirmedAt', 'owner', 'status', 'title', 'updatedAt', 'version']);
    const board = await (await a.get('/api/tasks')).json(); assert.deepEqual(Object.keys(board).sort(), ['observedAt', 'revision', 'tasks']); assert.equal(board.revision, 1);
    assert.equal((await a.post(request)).status, 200); assert.equal((await (await a.get('/api/tasks')).json()).revision, 1); // same requestId replays without a second commit
    assert.equal((await a.post(command(0, 'Done', 'compat-stale'))).status, 409); assert.equal((await a.post(command(1, 'Done', 'compat-create'))).status, 409);
    assert.equal((await a.post(command(1, 'Done', 'compat-next'))).status, 200); assert.equal((await a.get('/api/quota')).status, 200);
    assert.equal((await fetch(a.url + '/api/quota', { method: 'POST', headers: { Origin: env.DASHBOARD_ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: '{}' })).status, 404); // quota is read-only
  } finally { await a.close(); }
});

test('UI shows current/stale/reference/unknown with distinct timestamps; failure and malformed data are never shown as current; asset allowlist stays 3', async () => {
  class Element { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {} }
  const text = element => [element.textContent, ...element.children.map(text)].join(' ');
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString(), live = at(0.5);
  const records = [rec({ observedAt: at(2), collectedAt: at(2), lastSuccessAt: at(2), resetAt: new Date(Date.now() + 3600000).toISOString(), collector: { status: 'online', heartbeatAt: live } }),
    rec({ provider: 'claude', observedAt: at(2), collectedAt: at(2), lastSuccessAt: at(2), resetAt: at(1), collector: { status: 'online', heartbeatAt: live } }),
    rec({ provider: 'ag', source: 'cli', observedAt: undefined, collectedAt: at(2), lastSuccessAt: at(2), collector: { status: 'offline', heartbeatAt: live } }),
    rec({ provider: 'ag', source: 'statusline', observedAt: undefined, collectedAt: at(2), lastSuccessAt: at(2), collector: { status: 'online', heartbeatAt: live } })];
  const a = await app(new FixtureStore(), { quotaStore: new SyntheticQuotaStore(records) });
  try {
    const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }; let mode = 'live';
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {},
      fetch: async (path, options) => mode === 'down' ? Promise.reject(new Error('offline')) : mode === 'bad' ? { ok: true, json: async () => ({ servedAt: new Date().toISOString(), entries: [{ provider: 'codex', freshness: 'current-ish' }] }) } : fetch(a.url + path, options) });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
    await runInContext('refreshQuota()', context); const shown = text(el('quota'));
    for (const label of ['Codex · 最新', 'Claude · 古い可能性', 'AG · 参考値', 'AG · 不明', '更新待ち', '観測:', '収集:', '最終成功:', 'リセット:', '配信:']) assert.ok(shown.includes(label), label);
    mode = 'down'; await runInContext('refreshQuota()', context); assert.match(text(el('quota')), /取得できません/); assert.doesNotMatch(text(el('quota')), /最新|Codex/);
    mode = 'live'; await runInContext('refreshQuota()', context); mode = 'bad'; await runInContext('refreshQuota()', context); assert.match(text(el('quota')), /取得できません/); assert.doesNotMatch(text(el('quota')), /最新/);
  } finally { await a.close(); }
  assert.deepEqual([...assets].sort(), ['app.js', 'index.html', 'style.css']);
  assert.match(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), /id="quota"/);
  const config = JSON.parse(await readFile(root('vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites.map(r => r.source), ['/api/tasks', '/api/quota', '/api/auth/status', '/api/auth/sign-in/social', '/api/auth/callback/vercel', '/api/auth/sign-out']);
  for (const r of config.rewrites) assert.equal(r.destination, '/api/index?dashboard_path=' + r.source.slice(1)); // exact rewrites, no wildcards
});

test('no real collector, network, process or credential access in quota/auth modules; synthetic callback is not wired in production code', async () => {
  for (const name of ['cloud/quota.mjs', 'cloud/quota-freshness.mjs', 'cloud/auth.mjs', 'cloud/synthetic.mjs']) {
    const source = await readFile(root(name), 'utf8');
    assert.doesNotMatch(source, /node:(http|https|net|tls|dns|child_process|fs)|\bfetch\s*\(|process\.env|XMLHttpRequest|WebSocket|DATABASE_URL|from 'pg'/, name);
  }
  for (const name of ['api/index.mjs', 'cloud/server.mjs', 'cloud/build.mjs', 'cloud/build-deployment.mjs']) assert.doesNotMatch(await readFile(root(name), 'utf8'), /synthetic-auth|syntheticOwnerAuthorize|AUTH_BYPASS/, name);
  const server = await readFile(root('cloud/server.mjs'), 'utf8');
  assert.doesNotMatch(server.replace(/\/\/.*$/gm, ''), /x-vercel|req\.headers\.(authorization|cookie)|env\.VERCEL\b|DASHBOARD_PROTECTION_VERIFIED/i); // headers/env flags are never consulted for identity
});
