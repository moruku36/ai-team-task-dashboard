import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mutate, Problem } from './model.mjs';
import { connectStore } from './postgres.mjs';
import { SyntheticStore } from './synthetic.mjs';
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
// Authentication is the outer Vercel boundary, not a caller-controlled header.
export function handler({ store, env = process.env }) {
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
        const board = await store.read();
        return json(200, { revision: board.revision, tasks: board.tasks, observedAt: new Date().toISOString() });
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
export function createVercelHandler({ connect = connectStore, env = process.env } = {}) {
  let connection;
  return async (req, res) => {
    try {
      const origin = new URL(env.DASHBOARD_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.DASHBOARD_ORIGIN || !env.DATABASE_URL) throw new Error('Configuration missing');
      connection ??= connect(env);
      return await handler({ store: await connection, env })(req, res);
    } catch {
      connection = undefined;
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Private dashboard not configured or storage unavailable' }));
    }
  };
}
export default createVercelHandler();
export async function startLocalServer(port = Number(process.env.PORT ?? 6421)) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
  // DATABASE_URL and deployment flags are never used by the local entry point.
  const env = {}, server = createServer(handler({ store: new SyntheticStore(), env }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  env.DASHBOARD_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startLocalServer();
  console.log(`Synthetic-only dashboard: http://127.0.0.1:${server.address().port}`);
}
