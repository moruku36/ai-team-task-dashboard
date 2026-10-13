import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createOwnerAuth, readAuthConfig, ownerOnlyValidation, REQUIRED_ENV, AUTH_ROUTES } from '../owner-auth.mjs';
import { createVercelHandler } from '../server.mjs';
import { FixtureStore } from './fixtures.mjs';
// IMPORTANT: every "library" below is a MOCK of the Better Auth boundary (getSession / listUserAccounts / node handler).
// These tests prove OUR decision logic only. They are NOT proof of real Better Auth behaviour, real Sign in with Vercel OIDC,
// real PKCE/state/nonce handling, a real database, or real cookies. Genuine provider/login/DB acceptance is still pending.
const OWNER = 'own_synthetic_0001', SENTINEL = 'SYNTHETIC_SECRET_SENTINEL';
const goodEnv = { DASHBOARD_ORIGIN: 'https://synthetic.invalid', VERCEL_CLIENT_ID: 'cl_synthetic', VERCEL_CLIENT_SECRET: SENTINEL + '_CLIENT', BETTER_AUTH_SECRET: SENTINEL + '_' + 'x'.repeat(40),
  DATABASE_URL: 'postgresql://synthetic.invalid/db', OWNER_VERCEL_SUBJECT: OWNER };
const mockLib = ({ session = null, accounts = [], calls = [] } = {}) => ({
  api: { getSession: async arg => { calls.push(['getSession', arg.headers]); return session; }, listUserAccounts: async () => accounts },
  handler: async (req, res) => { calls.push(['handler', req.method, req.url]); res.writeHead(204); res.end(); },
  fromNodeHeaders: headers => ({ viaLibrary: true, headers }) });
const valid = { session: { id: 's' }, user: { id: 'u', role: 'owner' } };
const serve = async (t, handler) => { const server = createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r))); return `http://127.0.0.1:${server.address().port}`; };
const wire = (env, factory, connect) => { const oa = createOwnerAuth({ env, factory }); return createVercelHandler({ env, connect, authorize: oa.authorize, authRoutes: oa.route }); };

test('lazy creation: missing/invalid settings give 503 without importing, constructing, connecting or leaking secrets', async t => {
  for (const name of REQUIRED_ENV) { const read = readAuthConfig({ ...goodEnv, [name]: undefined }); assert.equal(read.ok, false); assert.deepEqual(read.missing, [name]); }
  for (const bad of [{ DASHBOARD_ORIGIN: 'http://synthetic.invalid' }, { DASHBOARD_ORIGIN: 'https://synthetic.invalid/path' }, { BETTER_AUTH_SECRET: 'short' }, { OWNER_VERCEL_SUBJECT: 'a b' }, { DATABASE_URL: 'mysql://x/y' }, { VERCEL_CLIENT_ID: ' ' }]) assert.equal(readAuthConfig({ ...goodEnv, ...bad }).ok, false, JSON.stringify(Object.keys(bad)));
  assert.equal(readAuthConfig(goodEnv).ok, true);
  let factories = 0, connects = 0; const factory = async () => { factories++; throw new Error(SENTINEL + ' factory failure'); };
  const connect = async () => { connects++; return new FixtureStore(); };
  const incomplete = await serve(t, wire({ ...goodEnv, VERCEL_CLIENT_SECRET: undefined }, factory, connect));
  for (const [method, path] of [['GET', '/api/tasks'], ['GET', '/api/quota'], ['GET', '/api/auth/status'], ['POST', '/api/auth/sign-in/social'], ['GET', '/api/auth/callback/vercel']]) {
    const response = await fetch(incomplete + path, { method }); assert.equal(response.status, 503, path); assert.doesNotMatch(await response.text(), new RegExp(SENTINEL));
  }
  assert.deepEqual([factories, connects], [0, 0]);
  // Complete settings but a failing library: still 503, no DB connect, secrets not echoed, and the next request retries creation.
  const failing = await serve(t, wire(goodEnv, factory, connect));
  for (let i = 0; i < 2; i++) { const response = await fetch(failing + '/api/tasks'); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), new RegExp(SENTINEL)); }
  assert.deepEqual([factories, connects], [2, 0]);
});

test('owner decision uses only the library session + linked Vercel account id; role/subject/headers from the caller are ignored', async () => {
  const calls = []; const make = options => createOwnerAuth({ env: goodEnv, factory: async () => mockLib({ calls, ...options }) });
  const req = { headers: { 'x-vercel-authenticated': 'true', 'x-vercel-id': 'owner', cookie: 'role=owner; subject=' + OWNER, authorization: 'Bearer ' + OWNER } };
  assert.equal(await make({ session: null }).authorize(req), null); // spoofed identity headers/cookies do not create a session
  assert.deepEqual(calls[0][1], { viaLibrary: true, headers: req.headers }); // headers reach ONLY the library, via fromNodeHeaders
  const owner = await make({ session: valid, accounts: [{ providerId: 'vercel', accountId: OWNER }] }).authorize(req);
  assert.deepEqual([owner.verified, owner.role], [true, 'owner']); assert.doesNotMatch(JSON.stringify(owner), new RegExp(OWNER)); // opaque subject, no account id
  for (const accounts of [[{ providerId: 'vercel', accountId: 'someone_else' }], [{ providerId: 'github', accountId: OWNER }], [], [{ providerId: 'vercel', accountId: '' }]]) {
    const viewer = await make({ session: { ...valid, user: { id: 'u', role: 'owner', admin: true, subject: OWNER } }, accounts }).authorize(req);
    assert.equal(viewer.role, 'viewer', JSON.stringify(accounts)); // session role/subject claims are not trusted
  }
  await assert.rejects(createOwnerAuth({ env: goodEnv, factory: async () => ({ ...mockLib({ session: valid }), api: { getSession: async () => valid } }) }).authorize(req)); // no account lookup -> unavailable, never owner
  await assert.rejects(createOwnerAuth({ env: goodEnv, factory: async () => ({ ...mockLib(), api: { getSession: async () => { throw new Error('db'); }, listUserAccounts: async () => [] } }) }).authorize(req));
  await assert.rejects(createOwnerAuth({ env: goodEnv, factory: async () => ({ ...mockLib({ session: valid }), api: { getSession: async () => valid, listUserAccounts: async () => 'nope' } }) }).authorize(req));
});

test('only the sign-in/callback/sign-out flow reaches the library; everything else under /api/auth is 404; rewritten URLs are canonicalized', async t => {
  const calls = []; const oa = createOwnerAuth({ env: goodEnv, factory: async () => mockLib({ calls }) });
  const base = await serve(t, createVercelHandler({ env: goodEnv, connect: async () => assert.fail('no DB for auth routes'), authorize: oa.authorize, authRoutes: oa.route }));
  for (const [method, path] of [['GET', '/api/auth/get-session'], ['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/sign-in/email'], ['GET', '/api/auth/list-accounts'], ['GET', '/api/auth/sign-out'],
    ['POST', '/api/auth/callback/vercel'], ['GET', '/api/auth/sign-in/social'], ['POST', '/api/auth/delete-user'], ['GET', '/api/auth/callback/github']]) assert.equal((await fetch(base + path, { method })).status, 404, `${method} ${path}`);
  assert.equal(calls.length, 0);
  assert.deepEqual(AUTH_ROUTES.map(([m, p]) => `${m} ${p}`), ['POST /api/auth/sign-in/social', 'GET /api/auth/callback/vercel', 'POST /api/auth/sign-out']);
  assert.equal((await fetch(base + '/api/auth/sign-in/social', { method: 'POST' })).status, 204);
  assert.equal((await fetch(base + '/api/index?dashboard_path=api/auth/callback/vercel&code=C1&state=S1')).status, 204);
  assert.equal((await fetch(base + '/api/auth/sign-out', { method: 'POST' })).status, 204);
  assert.deepEqual(calls.map(c => c.slice(1)), [['POST', '/api/auth/sign-in/social'], ['GET', '/api/auth/callback/vercel?code=C1&state=S1'], ['POST', '/api/auth/sign-out']]); // dashboard_path removed, library params kept
});

test('end to end with a mock library: anonymous 401, non-owner 403, owner 200; DB connects only after owner approval; no identity in responses', async t => {
  let connects = 0; const store = new FixtureStore(); const connect = async () => { connects++; return store; };
  const states = {};
  const bases = {};
  for (const [name, options] of Object.entries({ anonymous: { session: null }, viewer: { session: valid, accounts: [{ providerId: 'vercel', accountId: 'not_the_owner' }] }, owner: { session: valid, accounts: [{ providerId: 'vercel', accountId: OWNER }] } })) {
    bases[name] = await serve(t, wire(goodEnv, async () => mockLib(options), connect));
  }
  const spoof = { 'x-vercel-authenticated': 'true', 'x-vercel-user': OWNER, Cookie: 'role=owner' };
  for (const [name, status] of [['anonymous', 401], ['viewer', 403]]) {
    for (const path of ['/api/tasks', '/api/quota', '/api/index?dashboard_path=api/tasks']) assert.equal((await fetch(bases[name] + path, { headers: spoof })).status, status, `${name} ${path}`);
    assert.equal((await fetch(bases[name] + '/api/tasks', { method: 'POST', headers: { ...spoof, Origin: goodEnv.DASHBOARD_ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: '{}' })).status, status);
  }
  assert.equal(connects, 0);
  for (const name of ['anonymous', 'viewer', 'owner']) { const response = await fetch(bases[name] + '/api/auth/status'); states[name] = await response.json(); assert.deepEqual(Object.keys(states[name]), ['state']); }
  assert.deepEqual(states, { anonymous: { state: 'anonymous' }, viewer: { state: 'forbidden' }, owner: { state: 'owner' } });
  assert.equal(connects, 0); // status/assets never open the database
  for (const name of ['anonymous', 'viewer', 'owner']) assert.equal((await fetch(bases[name] + '/app.js')).status, 200);
  const board = await fetch(bases.owner + '/api/tasks'); assert.equal(board.status, 200); assert.equal(connects, 1); assert.doesNotMatch(await board.text(), new RegExp(OWNER + '|owner@|email'));
  assert.equal((await fetch(bases.owner + '/api/quota')).status, 200); // task/quota behaviour is unchanged behind the real-adapter gate
});

test('library configuration (static): single provider, no password/email signup, secure HttpOnly SameSite cookies, exact origin, lazy imports, pinned dependencies', async () => {
  const code = (await readFile(new URL('../owner-auth.mjs', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^import .*['"]better-auth/m); assert.match(code, /import\('better-auth'\)/); assert.match(code, /import\('better-auth\/node'\)/); // loaded only after complete settings
  for (const required of [/emailAndPassword: \{ enabled: false \}/, /socialProviders: \{ vercel: \{ clientId: config\.clientId, clientSecret: config\.clientSecret \} \}/, /trustedOrigins: \[config\.origin\]/, /baseURL: config\.origin/,
    /useSecureCookies: true/, /httpOnly: true/, /secure: true/, /sameSite: 'lax'/, /disableOriginCheck: false/, /accountLinking: \{ enabled: false \}/, /rejectUnauthorized: true/]) assert.match(code, required, String(required));
  assert.doesNotMatch(code, /github|google|discord|apple|twitter|microsoft|genericOAuth|magicLink|anonymous\(/i);
  assert.doesNotMatch(code, /process\.env\.|x-vercel|\bVERCEL\b/); // env is injected; no env-flag or platform-identity shortcuts
  assert.match(code, /validateUserInfo: ownerOnlyValidation\(config\.ownerSubject\)/);
  // validateUserInfo gate (MOCK inputs; the real callback argument shape is unverified): only the owner's Vercel profile.sub may pass.
  const gate = ownerOnlyValidation(OWNER), reject = { error: 'owner_only' };
  assert.equal(await gate({ source: { action: 'create-user', oauth: { providerId: 'vercel', profile: { sub: OWNER } } } }), undefined);
  for (const input of [{ source: { oauth: { providerId: 'vercel', profile: { sub: 'other' } } } }, { source: { oauth: { providerId: 'vercel', profile: {} } } }, { source: { oauth: { providerId: 'vercel' } } },
    { source: { oauth: { providerId: 'github', profile: { sub: OWNER } } } }, { source: { method: 'email', action: 'sign-in' } }, { source: { oauth: { providerId: 'vercel', profile: { sub: 7 } } }, role: 'owner' }, {}, undefined]) assert.deepEqual(await gate(input), reject);
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual([manifest.dependencies['better-auth'], manifest.dependencies.pg, manifest.engines.node], ['1.7.7', '8.23.1', '22.x']);
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  for (const [, path] of AUTH_ROUTES) assert.ok(config.rewrites.some(r => r.source === path && r.destination === '/api/index?dashboard_path=' + path.slice(1)), path);
  assert.doesNotMatch(await readFile(new URL('../../api/index.mjs', import.meta.url), 'utf8'), /synthetic|tests\//i);
});

test('sign-in UI: server-driven state, redirect only to the Vercel authorization host, sign-out, and no personal identity shown', async () => {
  class Element { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {} }
  const text = element => [element.textContent, ...element.children.map(text)].join(' ');
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const posts = [], assigned = []; let status = { ok: true, body: { state: 'anonymous', email: 'person@example.invalid', name: 'Synthetic Person', sub: OWNER } }, signInBody = { url: 'https://vercel.com/oauth/authorize?x=1' };
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {}, location: { assign: url => assigned.push(url) },
    fetch: async (path, options) => {
      if (path === '/api/auth/status') return { ok: status.ok, json: async () => status.body };
      if (options?.method === 'POST') { posts.push([path, JSON.parse(options.body)]); return { ok: true, json: async () => path.endsWith('sign-out') ? {} : signInBody }; }
      return { ok: false, status: 401, json: async () => ({}) };
    } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refreshAuth()', context);
  assert.match(text(el('auth')), /サインインしてください/); assert.match(text(el('auth')), /Vercelでサインイン/); assert.doesNotMatch(text(el('auth')), /person@|Synthetic Person|own_synthetic/);
  await el('auth').children[1].onclick(); assert.deepEqual(posts[0], ['/api/auth/sign-in/social', { provider: 'vercel', callbackURL: '/' }]); assert.deepEqual(assigned, ['https://vercel.com/oauth/authorize?x=1']);
  for (const url of ['https://vercel.com.evil.invalid/x', 'http://vercel.com/x', 'javascript:alert(1)', undefined]) { signInBody = { url }; await runInContext('signIn()', context); assert.match(text(el('auth')), /開始できません/); }
  assert.equal(assigned.length, 1); // unexpected library responses never navigate
  status = { ok: true, body: { state: 'owner' } }; await runInContext('refreshAuth()', context); assert.match(text(el('auth')), /サインイン済み/); assert.match(text(el('auth')), /サインアウト/);
  await el('auth').children[1].onclick(); assert.equal(posts.at(-1)[0], '/api/auth/sign-out');
  status = { ok: true, body: { state: 'forbidden' } }; await runInContext('refreshAuth()', context); assert.match(text(el('auth')), /権限がありません/);
  for (const bad of [{ ok: false, body: {} }, { ok: true, body: { state: 'admin' } }]) { status = bad; await runInContext('refreshAuth()', context); assert.match(text(el('auth')), /認証が利用できません/); }
});
