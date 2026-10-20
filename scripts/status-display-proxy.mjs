// Dependency-free, loopback-only display adapter. The official server owns all state.
import http from 'node:http';
import net from 'node:net';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readUsageFile} from './usage-metadata.mjs';

const assetPath = '/__dashboard/status-display.js';
const asset = readFileSync(new URL('./status-display.js', import.meta.url));
const injection = `<script defer src="${assetPath}"></script>`;
const usageAsset = readFileSync(new URL('./usage-display.js', import.meta.url));
const usagePath = '/__dashboard/usage';
const loopbackHost = request => {
  try {const value = new URL(`http://${request.headers.host}`); return ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash;}
  catch {return false;}
};

export function createDisplayProxy(upstreamPort, {usageFile = null} = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid upstream port');
  const server = http.createServer((request, response) => {
    if (!loopbackHost(request)) {response.writeHead(403, {'cache-control':'no-store'}); response.end('Loopback host required.'); return;}
    if (request.url === usagePath) {
      const headers = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'};
      if (request.method !== 'GET') {response.writeHead(405, {...headers, allow: 'GET'}); response.end('{"status":"read_only"}'); return;}
      try {
        if (!usageFile) throw new Error('Not configured');
        const value = readUsageFile(usageFile);
        response.writeHead(200, headers); response.end(JSON.stringify(value));
      } catch {response.writeHead(503, headers); response.end('{"status":"unavailable"}');}
      return;
    }
    if (usageFile && request.url === '/__dashboard/usage-display.js' && request.method === 'GET') {
      response.writeHead(200, {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'});
      response.end(usageAsset); return;
    }
    if (request.url === assetPath && request.method === 'GET') {
      response.writeHead(200, {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'});
      response.end(asset);
      return;
    }
    const upstream = http.request({host: '127.0.0.1', port: upstreamPort, path: request.url,
      method: request.method, headers: {...request.headers, 'accept-encoding': 'identity'}}, incoming => {
      const headers = {...incoming.headers};
      const html = String(headers['content-type'] ?? '').includes('text/html');
      if (!html || request.method === 'HEAD') {
        response.writeHead(incoming.statusCode, headers);
        incoming.pipe(response);
        return;
      }
      delete headers['content-length'];
      delete headers.etag;
      delete headers['last-modified'];
      headers['cache-control'] = 'no-store';
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        response.writeHead(incoming.statusCode, headers);
        const scripts = injection + (usageFile ? '<script defer src="/__dashboard/usage-display.js"></script>' : '');
        response.end(body.includes('</head>') ? body.replace('</head>', `${scripts}</head>`) : `${body}${scripts}`);
      });
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, {'content-type': 'text/plain; charset=utf-8'});
      response.end('Official Backlog.md server unavailable.');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!loopbackHost(request)) {socket.destroy(); return;}
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      for (let i = 0; i < request.rawHeaders.length; i += 2) upstream.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i+1]}\r\n`);
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 3) throw new Error('Usage: node scripts/status-display-proxy.mjs [display-port] [official-port] [private-usage-json]');
  const port = Number(args[0] ?? 6421);
  const upstreamPort = Number(args[1] ?? 6420);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === upstreamPort) throw new Error('Invalid display port');
  createDisplayProxy(upstreamPort, {usageFile: args[2] || null}).listen(port, '127.0.0.1', () => console.log(`Display: http://127.0.0.1:${port} (official server: 127.0.0.1:${upstreamPort})`));
}
