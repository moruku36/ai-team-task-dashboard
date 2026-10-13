// Production owner authentication adapter: Better Auth 1.7.7 + its built-in "Sign in with Vercel" provider.
// STATUS: code only. NOT verified against a real Vercel App, real login, a real database, or the installed library version.
// - Created LAZILY: nothing is imported, constructed, or connected until every required setting is present.
// - Identity comes only from the library's server-side session lookup + linked-account lookup. A session role/subject,
//   browser-supplied values, VERCEL=1, x-vercel-* headers and outer cookies are never read here.
// - Owner = the verified Vercel account id (provider accountId) equals OWNER_VERCEL_SUBJECT. Anything else is denied.
import { createHash, timingSafeEqual } from 'node:crypto';
import { authorizeOwner } from './auth.mjs';
export const REQUIRED_ENV = Object.freeze(['DASHBOARD_ORIGIN', 'VERCEL_CLIENT_ID', 'VERCEL_CLIENT_SECRET', 'BETTER_AUTH_SECRET', 'DATABASE_URL', 'OWNER_VERCEL_SUBJECT']);
// Only the flow endpoints needed for sign-in/callback/sign-out reach the library; everything else under /api/auth is 404.
// Paths: callback default "/api/auth/callback/vercel" is documented; sign-in/social and sign-out paths are NOT confirmed in the fetched docs.
export const AUTH_ROUTES = Object.freeze([['POST', '/api/auth/sign-in/social'], ['GET', '/api/auth/callback/vercel'], ['POST', '/api/auth/sign-out']]);
export const SESSION_SECONDS = 12 * 3600;
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const sameSecret = (a, b) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };
export function readAuthConfig(env = {}) {
  const missing = REQUIRED_ENV.filter(name => !text(env[name]));
  if (missing.length) return { ok: false, missing };
  let origin;
  try { origin = new URL(env.DASHBOARD_ORIGIN); } catch { return { ok: false, missing: ['DASHBOARD_ORIGIN'] }; }
  if (origin.protocol !== 'https:' || origin.origin !== env.DASHBOARD_ORIGIN) return { ok: false, missing: ['DASHBOARD_ORIGIN'] };
  if (env.BETTER_AUTH_SECRET.length < 32) return { ok: false, missing: ['BETTER_AUTH_SECRET'] };
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(env.OWNER_VERCEL_SUBJECT)) return { ok: false, missing: ['OWNER_VERCEL_SUBJECT'] };
  try { if (!['postgres:', 'postgresql:'].includes(new URL(env.DATABASE_URL).protocol)) throw 0; } catch { return { ok: false, missing: ['DATABASE_URL'] }; }
  return { ok: true, config: { origin: origin.origin, clientId: env.VERCEL_CLIENT_ID, clientSecret: env.VERCEL_CLIENT_SECRET, secret: env.BETTER_AUTH_SECRET, databaseUrl: env.DATABASE_URL, ownerSubject: env.OWNER_VERCEL_SUBJECT } };
}
// Pre-provisioning gate (Better Auth `user.validateUserInfo`, documented: "Return nothing to allow provisioning. Return an object with `error` to reject it";
// runs before user creation / account linking / returning OAuth sign-in). Only a verified Vercel profile whose `sub` equals the configured owner may
// proceed, so non-owner accounts never get user/account/token rows. Missing/unverified profile, other providers/methods, or caller-supplied data -> reject.
// UNVERIFIED: the property holding the raw profile is read as `source.oauth.profile` (docs say "provider id and raw provider profile"; exact key not shown) -
// if it is named differently every sign-in is rejected (fail closed). The `error` code is generic (docs warn text may reach the client).
export const ownerOnlyValidation = ownerSubject => async ({ source } = {}) => {
  const oauth = source?.oauth, sub = oauth?.profile?.sub;
  if (oauth?.providerId !== 'vercel' || typeof sub !== 'string' || !text(sub) || !sameSecret(sub, ownerSubject)) return { error: 'owner_only' };
};
// Library boundary. Returns { api: { getSession, listUserAccounts }, handler(req,res), fromNodeHeaders }.
// Imports happen here only (after configuration is complete); pg Pool construction does not open a connection by itself.
export async function createLibraryAuth(config) {
  const [{ betterAuth }, { toNodeHandler, fromNodeHeaders }, { Pool }] = await Promise.all([import('better-auth'), import('better-auth/node'), import('pg')]);
  const url = new URL(config.databaseUrl);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key); // same strict-TLS handling as postgres.mjs
  const pool = new Pool({ connectionString: url.href, ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  const auth = betterAuth({
    baseURL: config.origin, secret: config.secret, trustedOrigins: [config.origin], database: pool,
    emailAndPassword: { enabled: false },
    disabledPaths: ['/sign-up/email', '/sign-in/email'],
    socialProviders: { vercel: { clientId: config.clientId, clientSecret: config.clientSecret } }, // PKCE is handled by the library (documented)
    user: { validateUserInfo: ownerOnlyValidation(config.ownerSubject) },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: SESSION_SECONDS, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: true, disableOriginCheck: false, defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax' } },
    rateLimit: { enabled: true }
  });
  return { api: auth.api, handler: toNodeHandler(auth), fromNodeHeaders };
}
export function createOwnerAuth({ env = process.env, factory = createLibraryAuth } = {}) {
  let pending;
  const library = async () => {
    const read = readAuthConfig(env);
    if (!read.ok) return null; // missing/invalid settings: no import, no DB, no network
    try { pending ??= Promise.resolve(factory(read.config)).then(lib => ({ lib, config: read.config })); return await pending; }
    catch { pending = undefined; return null; }
  };
  // Returns a verified principal, null (no valid session), or throws (adapter unavailable -> 503 in auth.mjs).
  async function authorize(req) {
    const ready = await library();
    if (!ready) throw new Error('Authentication unavailable');
    const { lib, config } = ready;
    const headers = lib.fromNodeHeaders(req.headers);
    const session = await lib.api.getSession({ headers }); // server-side validation by the library
    if (!session || !session.session || !session.user) return null;
    if (typeof lib.api.listUserAccounts !== 'function') throw new Error('Account lookup unavailable');
    const accounts = await lib.api.listUserAccounts({ headers });
    if (!Array.isArray(accounts)) throw new Error('Account lookup failed');
    const linked = accounts.filter(a => a && a.providerId === 'vercel' && text(a.accountId));
    const owner = linked.some(a => sameSecret(a.accountId, config.ownerSubject));
    // Subject is an opaque digest (never the account id, never a name/email); the principal never leaves the server.
    const subject = createHash('sha256').update(linked[0]?.accountId ?? 'none').digest('hex').slice(0, 16);
    return { verified: true, role: owner ? 'owner' : 'viewer', subject };
  }
  // Handles /api/auth/*. `url` is the canonical URL (rewrite parameter already removed). Returns true when handled.
  async function route(req, res, url) {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); return true; };
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const access = await authorizeOwner(authorize, req);
      const state = access.principal ? 'owner' : access.status === 401 ? 'anonymous' : access.status === 403 ? 'forbidden' : null;
      return state ? send(200, { state }) : send(503, { error: 'Authentication unavailable' }); // no identity fields
    }
    if (!AUTH_ROUTES.some(([method, path]) => method === req.method && path === url.pathname)) return send(404, { error: 'Not found' });
    const ready = await library();
    if (!ready) return send(503, { error: 'Authentication unavailable' });
    req.url = url.pathname + url.search;
    await ready.lib.handler(req, res);
    return true;
  }
  return { authorize, route };
}
