import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDisplayProxy} from '../scripts/status-display-proxy.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections?.();});

test('HTML gets display asset; JSON and writes keep original status, UTF-8 and bytes', async () => {
  let received;
  const fixture = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {received = Buffer.concat(chunks); res.end(received);});
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html><head></head><body>日本語</body></html>');
    } else {
      res.setHeader('content-type', 'application/json'); res.end('["Verifying","Done"]');
    }
  });
  const upstreamPort = await listen(fixture);
  const proxy = createDisplayProxy(upstreamPort);
  const port = await listen(proxy);
  try {
    const root = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(root)).text(), /日本語.*<\/body>/);
    assert.match(await (await fetch(root)).text(), /defer src="\/__dashboard\/status-display.js"/);
    assert.equal(await (await fetch(`${root}/api/statuses`)).text(), '["Verifying","Done"]');
    const payload = JSON.stringify({status:'Verifying', description:'確認'});
    assert.equal(await (await fetch(`${root}/api/tasks`, {method:'POST', body:payload})).text(), payload);
    assert.equal(received.toString('utf8'), payload);
    assert.match(await (await fetch(`${root}/__dashboard/status-display.js`)).text(), /完了とは限りません/);
  } finally {await stop(proxy); await stop(fixture);}
});

test('WebSocket upgrades and stream bytes remain unchanged', async () => {
  const fixture = http.createServer();
  const sockets = new Set();
  fixture.on('upgrade', (req, socket, head) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  const upstreamPort = await listen(fixture);
  const proxy = createDisplayProxy(upstreamPort);
  const port = await listen(proxy);
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(5000, () => {socket.destroy(); reject(new Error('upgrade timeout'));});
      let upgraded = false; let bytes = Buffer.alloc(0);
      socket.on('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
      socket.on('error', reject);
      socket.on('data', chunk => {
        if (!upgraded) {assert.match(chunk.toString(), /101 Switching Protocols/); upgraded = true; socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));}
        else {bytes = Buffer.concat([bytes, chunk]); if(bytes.length >= 4){assert.deepEqual(bytes, Buffer.from([0x81, 0x02, 0x6f, 0x6b])); socket.destroy(); resolve();}}
      });
    });
  } finally {for(const socket of sockets) socket.destroy(); await stop(proxy); await stop(fixture);}
});

test('headless synthetic DOM: label, description, live rerender, select value and submission', async () => {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.ok(existsSync(chrome), 'Set CHROME_PATH to a Chrome executable for this CLI-only test');
  let submission;
  const fixture = http.createServer((req, res) => {
    if(req.method === 'POST') {let raw=''; req.on('data', chunk => raw+=chunk); req.on('end', () => {submission=JSON.parse(raw); res.end('ok');}); return;}
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end(`<html><head></head><body>
      <div class="flex items-center justify-between mb-4"><h3 id="column">Verifying</h3></div>
      <select id="status"><option value="Verifying">Verifying</option><option value="Done">Done</option></select>
      <span id="badge" class="rounded-circle">Verifying</span>
      <h3 id="task-title">Verifying</h3><p id="prose">Verifying</p>
      <script>document.addEventListener('DOMContentLoaded',()=>setTimeout(async()=>{
        const added=document.createElement('span'); added.className='rounded-circle'; added.id='new-badge'; added.textContent='Verifying'; document.body.append(added);
        document.getElementById('badge').firstChild.data='Done';
        await fetch('/api/tasks',{method:'POST',body:JSON.stringify({status:document.getElementById('status').value})});
        document.body.dataset.submitted='yes';
      },50));</script></body></html>`);
  });
  const upstreamPort = await listen(fixture);
  const proxy = createDisplayProxy(upstreamPort);
  const port = await listen(proxy);
  const profile = mkdtempSync(path.join(tmpdir(), 'backlog-display-test-'));
  try {
    const {stdout} = await promisify(execFile)(chrome, ['--headless','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=2000',`http://127.0.0.1:${port}`], {timeout:30000, maxBuffer:2*1024*1024});
    assert.match(stdout, /id="column"[^>]*>旧「最終確認」（要確認）<\/h3>/);
    assert.match(stdout, /旧状態です。完了とは限りません/);
    assert.match(stdout, /option value="Verifying"[^>]*>旧「最終確認」（要確認）<\/option>/);
    assert.match(stdout, /id="task-title">Verifying<\/h3>/);
    assert.match(stdout, /id="prose">Verifying<\/p>/);
    assert.match(stdout, /id="badge" class="rounded-circle">Done<\/span>/);
    assert.match(stdout, /id="new-badge"[^>]*>旧「最終確認」（要確認）<\/span>/);
    assert.doesNotMatch(stdout,/aria-label="ステータスの説明"/);assert.deepEqual(submission, {status:'Verifying'});
  } finally {
    await stop(proxy); await stop(fixture);
    // This test-created, isolated profile is the only directory removed.
    assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir())+path.sep));
    rmSync(profile, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  }
});
