import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { createOwnerAuth, readAuthConfig, ownerOnlyValidation, diagnosticValidation, defaultDiagnosticSink, correlationId, REQUIRED_ENV, AUTH_ROUTES } from '../owner-auth.mjs';
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
  assert.match(code, /validateUserInfo: config\.diagnostic \? diagnosticValidation\(\{ sink \}\) : ownerOnlyValidation\(config\.ownerSubject\)/);
  assert.match(code, /logger: \{ disabled: true \}/); assert.match(code, /onAPIError: \{ errorURL: config\.origin \+ '\/' \}/); // raw library logger off; auth errors return to the absolute same-origin root (config.origin is https-only and path-free by readAuthConfig)
  assert.doesNotMatch(code, /errorURL: '\//);
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

// ---- Owner-discovery diagnostic (OWNER_VERCEL_SUBJECT absent). All inputs below are fixed synthetic fixtures; mocks are NOT proof of real OIDC. ----
const noOwner = { ...goodEnv, OWNER_VERCEL_SUBJECT: undefined };
const STATE = 'STATE_SYNTHETIC_FIXTURE_0001', SUB = 'sub_synthetic_9999';
const callback = (sub, state, providerId = 'vercel') => [{ source: { action: 'create-user', oauth: { providerId, profile: { sub } } } }, { query: { state } }]; // no defaults: undefined means "absent"
const fixture = () => callback(SUB, STATE);

test('diagnostic: missing owner never authorizes data/session; strict config by default; matching correlation grants nothing', async t => {
  assert.equal(readAuthConfig(noOwner).ok, false); // strict by default for existing consumers
  const relaxed = readAuthConfig(noOwner, { allowMissingOwner: true }); assert.equal(relaxed.ok, true); assert.deepEqual([relaxed.config.diagnostic, relaxed.config.ownerSubject], [true, null]);
  for (const owner of ['', undefined, null]) assert.equal(readAuthConfig({ ...goodEnv, OWNER_VERCEL_SUBJECT: owner }, { allowMissingOwner: true }).config.diagnostic, true);
  assert.equal(readAuthConfig({ ...goodEnv, OWNER_VERCEL_SUBJECT: 'a b' }, { allowMissingOwner: true }).ok, false); // present-but-invalid stays rejected
  assert.equal(readAuthConfig({ ...noOwner, VERCEL_CLIENT_SECRET: undefined }, { allowMissingOwner: true }).ok, false); // every other setting stays required
  let connects = 0; const calls = [];
  const lib = mockLib({ calls, session: valid, accounts: [{ providerId: 'vercel', accountId: SUB }, { providerId: 'vercel', accountId: OWNER }] }); // even a "perfect" session must not matter
  const oa = createOwnerAuth({ env: noOwner, factory: async () => lib, allowOwnerDiscovery: true, diagnosticSink: () => assert.fail('no sink use here') });
  const base = await serve(t, createVercelHandler({ env: noOwner, connect: async () => { connects++; return new FixtureStore(); }, authorize: oa.authorize, authRoutes: oa.route }));
  const correlated = { cookie: 'auth_correlation=' + correlationId(STATE), 'x-auth-correlation': correlationId(STATE), authorization: 'Bearer ' + SUB };
  assert.equal(await oa.authorize({ headers: correlated }), null);
  for (const path of ['/api/tasks', '/api/quota', '/api/index?dashboard_path=api/tasks']) assert.equal((await fetch(base + path, { headers: correlated })).status, 401, path);
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { ...correlated, Origin: goodEnv.DASHBOARD_ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: '{}' })).status, 401);
  assert.deepEqual([connects, calls.filter(c => c[0] === 'getSession').length], [0, 0]); // no DB, and the session lookup is never consulted while the owner is absent
  const status = await (await fetch(base + '/api/auth/status', { headers: correlated })).json(); assert.deepEqual(status, { state: 'diagnostic' });
  assert.equal((await fetch(base + '/api/auth/sign-in/social', { method: 'POST' })).status, 204); // ordinary sign-in route only; no new endpoint
  assert.equal((await fetch(base + '/api/auth/diagnostic')).status, 404);
  // Without the explicit opt-in an absent owner stays an unavailable adapter (503), never diagnostic and never authorized.
  const strict = createOwnerAuth({ env: noOwner, factory: async () => lib }); await assert.rejects(strict.authorize({ headers: {} }));
  const strictBase = await serve(t, createVercelHandler({ env: noOwner, connect: async () => assert.fail('no DB'), authorize: strict.authorize, authRoutes: strict.route }));
  for (const path of ['/api/tasks', '/api/auth/status', '/api/auth/sign-in/social']) assert.equal((await fetch(strictBase + path, { method: path.endsWith('social') ? 'POST' : 'GET' })).status, 503, path);
  // An invalid (present) owner value is not diagnostic even with the opt-in.
  const invalid = createOwnerAuth({ env: { ...goodEnv, OWNER_VERCEL_SUBJECT: 'a b' }, factory: async () => lib, allowOwnerDiscovery: true }); await assert.rejects(invalid.authorize({ headers: {} }));
});

test('diagnostic validator: always rejects; sink gets only sub + timestamp + sha256-derived correlation id; invalid inputs emit nothing; default sink prints fixed fields', async () => {
  const events = [], at = new Date('2026-01-02T03:04:05.000Z'), validate = diagnosticValidation({ sink: e => events.push(e), now: () => at }), reject = { error: 'owner_unconfirmed' };
  assert.deepEqual(await validate(...fixture()), reject); assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]), ['event', 'provider', 'sub', 'at', 'correlationId']);
  assert.deepEqual(events[0], { event: 'owner_discovery_rejected', provider: 'vercel', sub: SUB, at: '2026-01-02T03:04:05.000Z', correlationId: createHash('sha256').update(STATE).digest('hex').slice(0, 16) });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(STATE)); assert.ok(Object.isFrozen(events[0]));
  assert.deepEqual(await validate(...callback(OWNER, STATE)), reject); assert.equal(events.length, 2); // a sub equal to anything (even a would-be owner) is still rejected
  const before = events.length;
  const [good] = fixture();
  for (const args of [callback(SUB, undefined), callback(SUB, ''), callback(SUB, 'short'), callback(SUB, 'bad state with spaces'), callback(SUB, 'S'.repeat(513)), callback(SUB, 7), callback(undefined), callback(''), callback('a b'), callback('s'.repeat(129)), callback(7),
    callback(SUB, STATE, 'github'), [{ source: { oauth: { providerId: 'vercel', profile: {} } } }, { query: { state: STATE } }], [{ source: { oauth: { providerId: 'vercel' } } }, { query: { state: STATE } }],
    [{ source: { method: 'email' } }, { query: { state: STATE } }], [good], [good, {}], [good, { query: null }], [{}, { query: { state: STATE } }], [undefined, undefined], []]) {
    assert.deepEqual(await validate(...args), reject); // invalid input is rejected too
  }
  assert.equal(events.length, before, 'no sink output for missing/invalid state or sub');
  assert.deepEqual(await diagnosticValidation({ sink: () => { throw new Error(SENTINEL); } })(...fixture()), reject); // a failing sink cannot change the decision
  assert.deepEqual(await diagnosticValidation({ sink: async () => { throw new Error(SENTINEL); } })(...fixture()), reject);
  const info = mock.method(console, 'info', () => {});
  try {
    await diagnosticValidation({ now: () => at })(...fixture()); await diagnosticValidation({ now: () => at })(...callback(SUB, 'bad state'));
    defaultDiagnosticSink({ event: 'owner_discovery_rejected', provider: 'vercel', sub: SUB, at: '2026-01-02T03:04:05.000Z', correlationId: 'abcdef0123456789', state: STATE, token: SENTINEL, profile: { email: 'x@y.invalid' } });
    assert.equal(info.mock.callCount(), 2); // only valid inputs print
    for (const [line] of info.mock.calls.map(c => c.arguments)) { assert.deepEqual(Object.keys(JSON.parse(line)), ['event', 'provider', 'sub', 'at', 'correlationId']); assert.doesNotMatch(line, new RegExp(STATE + '|' + SENTINEL + '|x@y')); }
  } finally { info.mock.restore(); }
});

test('confirmed-owner regression: strict sub equality + linked-account check are unchanged even when discovery is allowed; diagnostic UI shows only the correlation id', async t => {
  const seen = []; const lib = mockLib({ session: valid, accounts: [{ providerId: 'vercel', accountId: OWNER }] });
  const oa = createOwnerAuth({ env: goodEnv, factory: async config => { seen.push(config); return lib; }, allowOwnerDiscovery: true });
  const base = await serve(t, wire(goodEnv, async () => mockLib({ session: valid, accounts: [{ providerId: 'vercel', accountId: OWNER }] }), async () => new FixtureStore()));
  const owner = await oa.authorize({ headers: {} }); assert.deepEqual([owner.verified, owner.role], [true, 'owner']);
  assert.deepEqual([seen[0].diagnostic, seen[0].ownerSubject], [false, OWNER]); // owner configured -> owner mode, never diagnostic
  assert.equal((await fetch(base + '/api/tasks')).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/auth/status')).json(), { state: 'owner' });
  const viewer = await createOwnerAuth({ env: goodEnv, factory: async () => mockLib({ session: valid, accounts: [{ providerId: 'vercel', accountId: SUB }] }), allowOwnerDiscovery: true }).authorize({ headers: {} });
  assert.equal(viewer.role, 'viewer'); // a different (e.g. just-discovered) sub is not the owner
  const gate = ownerOnlyValidation(OWNER); assert.equal(await gate(callback(OWNER, STATE)[0], callback(OWNER, STATE)[1]), undefined);
  for (const input of [callback(SUB, STATE)[0], callback(OWNER, STATE, 'github')[0], {}]) assert.deepEqual(await gate(input, fixture()[1]), { error: 'owner_only' });
  // Diagnostic UI (vm harness): status "diagnostic" shows the sign-in button + stored correlation id only; never logged-in/owner wording or the sub.
  class Element { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {} }
  const text = element => [element.textContent, ...element.children.map(text)].join(' ');
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, store = new Map(), assigned = [];
  const stateParam = 'UI_STATE_SYNTHETIC_FIXTURE', expected = createHash('sha256').update(stateParam).digest('hex').slice(0, 16);
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID, subtle: { digest: async (name, data) => { assert.equal(name, 'SHA-256'); return Uint8Array.from(createHash('sha256').update(data).digest()).buffer; } } },
    AbortSignal, URL, TextEncoder, Uint8Array, setInterval() {}, sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, location: { search: '', assign: url => assigned.push(url) },
    fetch: async (path, options) => path === '/api/auth/status' ? { ok: true, json: async () => ({ state: 'diagnostic', sub: SUB }) } : options?.method === 'POST' ? { ok: true, json: async () => ({ url: 'https://vercel.com/oauth/authorize?state=' + stateParam }) } : { ok: false, status: 401, json: async () => ({}) } });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refreshAuth()', context);
  assert.match(text(el('auth')), /診断モード/); assert.match(text(el('auth')), /Vercelでサインイン/); assert.doesNotMatch(text(el('auth')), /サインイン済み|オーナーです|相関ID/); assert.doesNotMatch(text(el('auth')), new RegExp(SUB));
  store.set('authCorrelation', 'deadbeefdeadbeef'); // stale label from an earlier attempt
  await el('auth').children[1].onclick(); assert.deepEqual([...store.entries()], [['authCorrelation', expected]]); assert.doesNotMatch(JSON.stringify([...store.entries()]), new RegExp(stateParam)); assert.equal(assigned.length, 1);
  // Only the exact error=owner_unconfirmed may state the owner-specific rejection (with the matching hash); other errors must not.
  context.location.search = '?x=error=owner_unconfirmed'; await runInContext('refreshAuth()', context); assert.doesNotMatch(text(el('auth')), /オーナー未確認|相関ID|エラー/); // not an error= parameter at all
  for (const search of ['?error=access_denied', '?error=owner_unconfirmed_x', '?error=Owner_Unconfirmed', '?error=']) {
    context.location.search = search; await runInContext('refreshAuth()', context);
    assert.doesNotMatch(text(el('auth')), /オーナー未確認|相関ID/, search); assert.match(text(el('auth')), /ログインは成立していません/, search); assert.doesNotMatch(text(el('auth')), new RegExp(SUB + '|' + stateParam + '|' + expected));
  }
  context.location.search = '?error=email_not_found'; await runInContext('refreshAuth()', context);
  assert.match(text(el('auth')), /メール情報を取得できず/); assert.match(text(el('auth')), /scope設定の確認/); assert.match(text(el('auth')), new RegExp('相関ID: ' + expected)); assert.doesNotMatch(text(el('auth')), /オーナー未確認.*拒否/); assert.doesNotMatch(text(el('auth')), new RegExp(SUB + '|' + stateParam));
  context.location.search = '?error=owner_unconfirmed'; await runInContext('refreshAuth()', context);
  assert.match(text(el('auth')), new RegExp('相関ID: ' + expected)); assert.match(text(el('auth')), /ログインもオーナー認定も成立していません/); assert.doesNotMatch(text(el('auth')), new RegExp(SUB + '|' + stateParam));
  // A sign-in whose authorization URL has no usable state clears the old label: nothing stale is reused.
  const baseFetch = context.fetch; context.fetch = async (path, options) => path === '/api/auth/status' ? baseFetch(path, options) : { ok: true, json: async () => ({ url: 'https://vercel.com/oauth/authorize?x=1' }) };
  await runInContext('signIn()', context); assert.equal(store.has('authCorrelation'), false);
  context.location.search = '?error=owner_unconfirmed'; await runInContext('refreshAuth()', context); assert.doesNotMatch(text(el('auth')), /相関ID: [0-9a-f]/); assert.match(text(el('auth')), /相関IDなし/);
});
