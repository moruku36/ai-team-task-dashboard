import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mutate, Problem, publicSnapshot } from './model.mjs';
import { connectStore } from './postgres.mjs';
import { SyntheticStore } from './synthetic.mjs';
import { authorizeOwner } from './auth.mjs';
import { publicQuota } from './quota.mjs';
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
// Authentication is an explicitly injected callback returning a verified owner principal (default deny, see auth.mjs).
// Headers, query, cookies, env flags, VERCEL=1, x-vercel identity and Origin are never treated as authentication.
export function handler({ store, env = process.env, authorize, quotaStore, now = () => new Date() }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      let origin;
      try { origin = new URL(env.DASHBOARD_ORIGIN); } catch { return json(503, { error: 'Private dashboard not configured' }); }
      if (!store || origin.origin !== env.DASHBOARD_ORIGIN || !['http:', 'https:'].includes(origin.protocol)) return json(503, { error: 'Private dashboard not configured' });
      // Authorize every request (including rewritten paths and assets) before routing, body reads or any storage access.
      const access = await authorizeOwner(authorize, req);
      if (access.status) return json(access.status, { error: access.error });
      const url = new URL(req.url, 'http://localhost');
      // Explicit rewrite path also works when the platform exposes the destination URL.
      if (url.pathname === '/api' || url.pathname === '/api/index') {
        const path = req.query?.dashboard_path ?? url.searchParams.get('dashboard_path');
        if (typeof path === 'string') url.pathname = '/' + path.replace(/^\/+/, '');
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }); return res.end(content);
      }
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
          for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 20000) throw new Problem(413, 'Body too large'); chunks.push(bytes); }
          body = Buffer.concat(chunks).toString('utf8');
        }
        if (Buffer.byteLength(body) > 20000) throw new Problem(413, 'Body too large');
        let command; try { command = JSON.parse(body); } catch { throw new Problem(400, 'Invalid JSON'); }
        return json(200, await mutate(store, command, 'owner'));
      }
      return json(404, { error: 'Not found' });
    } catch (error) { return json(error instanceof Problem ? error.status : 503, { error: error instanceof Problem ? error.message : 'Storage unavailable; refresh or retry the same request ID' }); }
  };
}
// `authorize` is the production auth adapter: still a pending approval/integration gate, so the exported default has none and denies everything.
// Denial happens before DB initialization (connect) when the adapter is absent or the caller is not a verified owner.
export function createVercelHandler({ connect = connectStore, env = process.env, authorize, quotaStore } = {}) {
  let connection;
  return async (req, res) => {
    try {
      if (typeof authorize !== 'function') throw new Error('Authentication adapter missing');
      const origin = new URL(env.DASHBOARD_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.DASHBOARD_ORIGIN || !env.DATABASE_URL) throw new Error('Configuration missing');
      const access = await authorizeOwner(authorize, req);
      if (access.status) {
        res.writeHead(access.status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        return res.end(JSON.stringify({ error: access.error }));
      }
      connection ??= connect(env);
      return await handler({ store: await connection, env, authorize: async () => access.principal, quotaStore })(req, res);
    } catch {
      connection = undefined;
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Private dashboard not configured or storage unavailable' }));
    }
  };
}
export default createVercelHandler();
// The local entry has no built-in auth either: without an injected `authorize` it denies every request (no bypass flag).
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
  console.log(`Synthetic-only dashboard: http://127.0.0.1:${server.address().port} (denies all requests: no authorize adapter injected)`);
}
