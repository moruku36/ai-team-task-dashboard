import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mutate, Problem, publicSnapshot } from './model.mjs';
import { connectStore } from './postgres.mjs';
import { SyntheticStore } from './synthetic.mjs';
import { authorizeOwner } from './auth.mjs';
import { createOwnerAuth } from './owner-auth.mjs';
import { publicQuota } from './quota.mjs';
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const securityHeaders = res => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
};
// Canonical URL: the explicit rewrite parameter also works when the platform exposes the destination URL.
export function resolveUrl(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api' || url.pathname === '/api/index') {
    const path = req.query?.dashboard_path ?? url.searchParams.get('dashboard_path');
    if (typeof path === 'string') { url.pathname = '/' + path.replace(/^\/+/, ''); url.searchParams.delete('dashboard_path'); }
  }
  return url;
}
const isAsset = (req, url) => req.method === 'GET' && assets.has(url.pathname);
async function serveAsset(res, pathname) {
  const [file, type] = assets.get(pathname);
  const content = await readFile(new URL(`./public/${file}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': type }); res.end(content);
}
// Static assets (3 files, no task/quota data) are served without a session so the sign-in UI can load; every data route requires an owner.
// Authentication is an explicitly injected callback returning a verified owner principal (default deny, see auth.mjs).
// Headers, query, cookies, env flags, VERCEL=1, x-vercel identity and Origin are never treated as authentication.
export function handler({ store, env = process.env, authorize, quotaStore, now = () => new Date() }) {
  return async (req, res) => {
    securityHeaders(res);
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      let origin;
      try { origin = new URL(env.DASHBOARD_ORIGIN); } catch { return json(503, { error: 'Private dashboard not configured' }); }
      if (!store || origin.origin !== env.DASHBOARD_ORIGIN || !['http:', 'https:'].includes(origin.protocol)) return json(503, { error: 'Private dashboard not configured' });
      const url = resolveUrl(req);
      if (isAsset(req, url)) return await serveAsset(res, url.pathname);
      // Authorize every data request (including rewritten paths) before routing, body reads or any storage access.
      const access = await authorizeOwner(authorize, req);
      if (access.status) return json(access.status, { error: access.error });
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        try { return json(200, publicSnapshot(await store.read())); }
        catch { return json(503, { error: 'Storage unavailable; refresh or retry the same request ID' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/quota') {
        try { return json(200, await publicQuota(quotaStore, now())); }
        catch { return json(503, { error: 'Quota unavailable' }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        if (req.headers['x-dashboard-write'] !== '1' || typeof req.headers['content-type'] !== 'string' || req.headers['content-type'].split(';')[0] !== 'application/json') throw new Problem(403, 'Write header and JSON required');
        if (req.headers.origin !== env.DASHBOARD_ORIGIN) throw new Problem(403, 'Origin rejected');
        let body = typeof req.body === 'string' ? req.body : req.body === undefined ? '' : JSON.stringify(req.body);
        if (req.body === undefined) {
          const chunks = []; let size = 0;
          for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 500000) throw new Problem(413, 'Body too large'); chunks.push(bytes); }
          body = Buffer.concat(chunks).toString('utf8');
        }
        if (Buffer.byteLength(body) > 500000) throw new Problem(413, 'Body too large');
        let command; try { command = JSON.parse(body); } catch { throw new Problem(400, 'Invalid JSON'); }
        return json(200, await mutate(store, command, 'owner'));
      }
      return json(404, { error: 'Not found' });
    } catch (error) { return json(error instanceof Problem ? error.status : 503, { error: error instanceof Problem ? error.message : 'Storage unavailable; refresh or retry the same request ID' }); }
  };
}
// `authorize` is the production auth adapter (owner-auth.mjs, wired lazily below); without it everything is denied (503) before DB initialization.
// `authRoutes(req, res, url)` serves only the allowlisted /api/auth/* login flow; it never touches task data or the task store.
// Order: configuration -> assets / auth flow (no DB) -> owner authorization -> DB connect -> routes.
export function createVercelHandler({ connect = connectStore, env = process.env, authorize, authRoutes, quotaStore } = {}) {
  let connection;
  return async (req, res) => {
    try {
      if (typeof authorize !== 'function') throw new Error('Authentication adapter missing');
      const origin = new URL(env.DASHBOARD_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.DASHBOARD_ORIGIN) throw new Error('Configuration missing');
      const url = resolveUrl(req);
      if (isAsset(req, url)) { securityHeaders(res); return await serveAsset(res, url.pathname); }
      if (url.pathname.startsWith('/api/auth/')) {
        securityHeaders(res);
        if (typeof authRoutes !== 'function') { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'Not found' })); }
        return await authRoutes(req, res, url);
      }
      if (!env.DATABASE_URL) throw new Error('Configuration missing');
      const access = await authorizeOwner(authorize, req);
      if (access.status) {
        res.writeHead(access.status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        return res.end(JSON.stringify({ error: access.error }));
      }
      connection ??= connect(env);
      const store = await connection;
      const connectedQuota = quotaStore ?? (typeof store.readQuota === 'function' ? { read: () => store.readQuota() } : undefined);
      return await handler({ store, env, authorize: async () => access.principal, quotaStore: connectedQuota })(req, res);
    } catch {
      connection = undefined;
      if (res.headersSent) return res.end();
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Private dashboard not configured or storage unavailable' }));
    }
  };
}
// Production entry: the real owner adapter is created LAZILY per process; missing settings -> 503 without any DB/network access.
// allowOwnerDiscovery: with OWNER_VERCEL_SUBJECT absent the ordinary sign-in flow runs as a diagnostic that always rejects (no session, no data access).
const ownerAuth = createOwnerAuth({ allowOwnerDiscovery: true });
export default createVercelHandler({ authorize: ownerAuth.authorize, authRoutes: ownerAuth.route });
// The local entry has no built-in auth either: without an injected `authorize` it denies every data request (no bypass flag).
export async function startLocalServer(port = Number(process.env.PORT ?? 6422), { authorize, quotaStore } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
  // DATABASE_URL and deployment flags are never used by the local entry point.
  const env = {}, server = createServer(handler({ store: new SyntheticStore(), env, authorize, quotaStore }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  env.DASHBOARD_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startLocalServer();
  console.log(`Synthetic-only dashboard: http://127.0.0.1:${server.address().port} (denies all data requests: no authorize adapter injected)`);
}
