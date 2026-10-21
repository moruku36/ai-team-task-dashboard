// Synthetic CLI/HTTP/WebSocket transport integration test for the official Backlog.md v1.53.0 (Windows).
// Usage: node tests/integration.mjs [--exe <backlog.exe>] [--results-dir <dir>]
// This does NOT drive the browser UI: the WebSocket here is a hand-made client, so reconnect/restart checks prove the
// server side only. UI behaviour (incl. continued updates after a restart) is covered by tests/frontend.mjs.
// No npm dependencies. Uses only an isolated temp no-git data root and synthetic tasks; never the default data root.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const exeCandidates = [arg('--exe'), path.join(repo, '.runtime', 'backlog.exe'), path.join(repo, '..', '.runtime', 'backlog.exe')].filter(Boolean);
const foundExe = exeCandidates.find((p) => fs.existsSync(p));
const exe = foundExe ? path.resolve(foundExe) : undefined;
const resultsDir = path.resolve(arg('--results-dir', path.join(repo, 'results')));
const LIMIT_MS = 10_000;
const TOTAL = 30;
const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const checks = [];
const timings = {};
const children = new Set();
let root;
let ws;
const wsMessages = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
async function until(what, fn, timeoutMs = 15_000, step = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(step);
  }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    children.add(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { kill(p); reject(new Error(`timeout: ${cmd} ${args.slice(0, 3).join(' ')}`)); }, 60_000);
    p.on('close', (code) => { clearTimeout(timer); children.delete(p); resolve({ code, out }); });
    p.on('error', reject);
  });
}
const cli = (...args) => run(exe, args, { env: { ...process.env, BACKLOG_CWD: root, USE_GLOBAL_TASK_ID_LOCK: 'true' } });
async function cliOk(...args) {
  const r = await cli(...args);
  if (r.code !== 0) throw new Error(`backlog ${args.slice(0, 2).join(' ')} failed (${r.code}): ${r.out.slice(0, 300)}`);
  return r.out;
}
function kill(p) {
  if (!p || p.pid === undefined) return;
  spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
}
const meta = (n, next) =>
  `observed_at: ${new Date().toISOString()}\nreported_at: ${new Date().toISOString()}\nsource: synthetic-test\nnext_action: ${next}\nwait_reason: none\nsynthetic task ${n}`
    .replace(/\n/g, ' | ');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

let server;
let base;
async function startServer() {
  const port = await freePort();
  server = spawn(exe, ['browser', '--no-open', '--non-interactive', '--port', String(port)], {
    env: { ...process.env, BACKLOG_CWD: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(server);
  server.stdout.resume(); server.stderr.resume(); // output is discarded, never stored
  server.on('close', () => children.delete(server));
  base = `http://127.0.0.1:${port}`;
  await until('server ready', async () => (await fetch(`${base}/api/tasks`)).ok, 30_000, 250);
  return port;
}
async function stopServer() {
  const p = server;
  kill(p);
  await until('server exit', async () => p.exitCode !== null || p.signalCode !== null, 10_000);
}
// The real UI loads tasks from GET /api/search (upstream App.tsx loadAllData/refreshTasksData) and keeps the
// results with type === 'task' (App.applySearchResults: `results.filter(r => r.type === 'task').map(r => r.task)`).
const getTasks = async () => {
  const r = await fetch(`${base}/api/search`);
  if (!r.ok) throw new Error(`/api/search ${r.status}`);
  return (await r.json()).filter((result) => result.type === 'task').map((result) => result.task);
};

function connectWs() {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(base.replace('http', 'ws'));
    const timer = setTimeout(() => reject(new Error('timeout waiting for WebSocket open')), 10_000);
    s.onopen = () => { clearTimeout(timer); resolve(s); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket error')); };
    s.onmessage = (e) => wsMessages.push({ t: performance.now(), data: String(e.data) });
  });
}

async function withMcp(fn) {
  const p = spawn(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'backlog.ps1'), '-DataRoot', root, '-ExePath', exe, 'mcp', 'start'], { env: { ...process.env, USE_GLOBAL_TASK_ID_LOCK: 'false' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(p); p.stderr.resume();
  let buffer = '', sequence = 0;
  const pending = new Map();
  p.stdout.on('data', chunk => {
    buffer += chunk;
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
      try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); } catch {}
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10_000);
    pending.set(id, msg => { clearTimeout(timer); pending.delete(id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } });
    check('official pinned stdio MCP handshake', init.serverInfo.version === '1.53.0');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn(rpc);
  } finally { kill(p); children.delete(p); }
}

// Runs `action` (a CLI update), then waits for tasks-updated and the follow-up /api/search refetch
// that the UI performs, and asserts `predicate(tasks)` within LIMIT_MS of the save being confirmed.
async function expectLive(label, action, predicate) {
  const t0 = performance.now();
  await action();
  const saved = performance.now();
  const msg = await until(`tasks-updated (${label})`, async () => wsMessages.find((m) => m.t >= t0 && m.data === 'tasks-updated'), LIMIT_MS + 5_000, 20);
  let tasks;
  await until(`refetch reflects ${label}`, async () => predicate((tasks = await getTasks())), LIMIT_MS, 100);
  const done = performance.now();
  const wsMs = Math.round(Math.max(0, msg.t - saved));
  const totalMs = Math.round(done - saved);
  timings[label] = { cliMs: Math.round(saved - t0), wsAfterSaveMs: wsMs, refetchAfterSaveMs: totalMs };
  check(`live update <10s: ${label}`, totalMs < LIMIT_MS, timings[label]);
  return tasks;
}
const find = (tasks, id) => tasks.find((t) => String(t.id).toLowerCase() === id.toLowerCase());

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  if (!exe) throw new Error('backlog.exe not found (use --exe or scripts\\Install-Backlog.ps1)');
  if (typeof WebSocket === 'undefined') throw new Error('Node built-in WebSocket unavailable (need Node 22+)');

  // Isolated temp root must be outside the repo and any git workspace.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ttd-test-'));
  let git = false;
  for (let d = root; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) git = true; if (path.dirname(d) === d) break; }
  check('temp data root is outside any git workspace', !git && !root.toLowerCase().startsWith(repo.toLowerCase()), { root });

  // Scripts: refuse data root inside the repo; initialize temp root; statuses configured.
  const inRepo = path.join(repo, 'data-should-be-refused');
  const refuse = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', inRepo, '-ExePath', exe]);
  check('init refuses data root inside the code repo', refuse.code !== 0 && /Refused/.test(refuse.out) && !fs.existsSync(inRepo));
  const init = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe]);
  check('Initialize-DataRoot.ps1 succeeds', init.code === 0, init.code === 0 ? undefined : init.out.slice(0, 400));
  const config = fs.readFileSync(path.join(root, 'backlog', 'config.yml'), 'utf8');
  check('four statuses configured', /^statuses: \["To Do", "In Progress", "Blocked", "Done"\]/m.test(config));
  const before = config;
  const again = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe]);
  check('re-init preserves existing config', again.code === 0 && fs.readFileSync(path.join(root, 'backlog', 'config.yml'), 'utf8') === before);

  const unsafe = path.join(root, 'existing-uninitialized');
  fs.mkdirSync(unsafe); fs.writeFileSync(path.join(unsafe, 'keep.txt'), 'synthetic sentinel');
  const preserved = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', unsafe, '-ExePath', exe]);
  check('nonempty uninitialized folder is preserved and refused', preserved.code !== 0 && !fs.existsSync(path.join(unsafe, 'backlog')) && fs.readFileSync(path.join(unsafe, 'keep.txt'), 'utf8') === 'synthetic sentinel');
  const configPath = path.join(root, 'backlog', 'config.yml');
  fs.writeFileSync(configPath, before.replace('filesystem_only: true', 'filesystem_only: false'));
  const invalid = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe]);
  check('existing git-enabled config refused without modification', invalid.code !== 0 && fs.readFileSync(configPath, 'utf8').includes('filesystem_only: false'));
  fs.writeFileSync(configPath, before);

  // 29 seed tasks across statuses, one assignee each; the 30th (lifecycle) is created while live.
  const statuses = ['To Do', 'In Progress', 'Blocked', 'Done'];
  const seedIds = [];
  for (let i = 1; i < TOTAL; i++) {
    const out = await cliOk('task', 'create', `Synthetic task ${i}`, '-d', meta(i, 'none'), '-a', `@ai-${(i % 5) + 1}`, '-s', statuses[i % statuses.length], '--plain');
    const m = out.match(/\b([A-Za-z]+-\d+)\b/);
    if (!m) throw new Error(`cannot parse task id from: ${out.slice(0, 200)}`);
    seedIds.push(m[1]);
  }
  check('29 seed tasks created', seedIds.length === 29);

  // Server: loopback only.
  const port = await startServer();
  const lis = spawnSync(PS[0], [...PS.slice(1), '-Command',
    `Get-NetTCPConnection -State Listen -OwningProcess ${server.pid} | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
  const listeners = [].concat(JSON.parse(lis.stdout || '[]'));
  check('server listens on 127.0.0.1 only (PowerShell Get-NetTCPConnection)',
    listeners.length > 0 && listeners.every((l) => l.LocalAddress === '127.0.0.1') && listeners.some((l) => l.LocalPort === port), listeners);
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (lan) {
    const reachable = await new Promise((res) => { const s = net.connect({ host: lan.address, port, timeout: 3000 }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); }); });
    check('non-loopback address refuses connection', !reachable, { tried: 'local non-loopback IPv4' });
  }

  // UI asset delivery.
  const html = await (await fetch(`${base}/`)).text();
  const assetRef = html.match(/(?:src|href)="(\/[^"]+\.(?:js|css))"/);
  check('UI index served', html.includes('<html') && !!assetRef);
  const asset = await fetch(base + assetRef[1]);
  check('UI asset delivered', asset.ok && (await asset.arrayBuffer()).byteLength > 1000, { asset: assetRef[1] });
  const jsRef = html.match(/src="(\/[^\"]+\.js)"/);
  check('UI JavaScript entry served', !!jsRef && (await fetch(base + jsRef[1])).ok);

  ws = await connectWs();
  check('WebSocket connected', ws.readyState === WebSocket.OPEN);
  check(`${TOTAL - 1} seed tasks visible via /api/search (UI task path)`, (await getTasks()).length === TOTAL - 1);

  // Lifecycle: create -> In Progress -> Blocked -> Done.
  let life;
  let tasks = await expectLive('create', async () => {
    const out = await cliOk('task', 'create', 'Synthetic lifecycle', '-d', meta('life', 'start'), '-a', '@ai-1', '-s', 'To Do', '--plain');
    life = out.match(/\b([A-Za-z]+-\d+)\b/)?.[1];
    if (!life) throw new Error('cannot parse lifecycle id');
  }, (t) => t.length === TOTAL && find(t, life));
  check(`${TOTAL} tasks present`, tasks.length === TOTAL);
  for (const [label, status, next] of [['in-progress', 'In Progress', 'work'], ['blocked', 'Blocked', 'user decision (approval is not authorization to act)'], ['done', 'Done', 'none']]) {
    tasks = await expectLive(label, () => cliOk('task', 'edit', life, '-s', status, '--append-notes', meta(label, next)), (t) => find(t, life)?.status === status);
  }

  await withMcp(async rpc => {
    const tools = await rpc('tools/list', {});
    check('official MCP task_edit available', tools.tools.some(t => t.name === 'task_edit'));
    await expectLive('mcp-update', async () => {
      const result = await rpc('tools/call', { name: 'task_edit', arguments: { id: seedIds[8], status: 'In Progress', description: meta('mcp', 'work') } });
      check('MCP task_edit accepted', !result.isError);
    }, t => find(t, seedIds[8])?.status === 'In Progress');
  });

  // Concurrent updates of different tasks.
  const targets = seedIds.slice(0, 5);
  tasks = await expectLive('concurrent-5-different-tasks',
    () => Promise.all(targets.map((id) => cliOk('task', 'edit', id, '-s', 'Blocked', '--append-notes', meta('concurrent', 'verify')))),
    (t) => targets.every((id) => find(t, id)?.status === 'Blocked'));
  check('no task lost after concurrent updates', tasks.length === TOTAL);

  const sameId = seedIds[9];
  const same = await Promise.all(Array.from({ length: 5 }, (_, i) => cli('task', 'edit', sameId, '--append-notes', `synthetic-concurrent-${i}`)));
  check('same-task contention is success or explicit lock conflict', same.some(r => r.code === 0) && same.every(r => r.code === 0 || /lock|ELOCKED|conflict/i.test(r.out)));
  await until('same-task accepted notes visible', async () => {
    const task = find(await getTasks(), sameId);
    return task && same.every((r, i) => r.code !== 0 || String(task.implementationNotes).includes(`synthetic-concurrent-${i}`));
  });
  check('same-task concurrent accepted notes preserved', true, { accepted: same.filter(r => r.code === 0).length, rejected: same.filter(r => r.code !== 0).length });

  // Transport-only: this test script closes its own WebSocket and opens a new one by hand. The standard UI does not
// do this for its data socket (see tests/frontend.mjs), so this is not evidence of UI reconnect behaviour.
  ws.close();
  await sleep(300);
  ws = await connectWs();
  tasks = await expectLive('after-manual-ws-reconnect', () => cliOk('task', 'edit', seedIds[5], '-s', 'Blocked', '--append-notes', meta('reconnect', 'unblock')), (t) => find(t, seedIds[5])?.status === 'Blocked');

  // Restart (transport-only): state persisted and down-time update visible after restart; a NEW hand-made WebSocket
// client then receives updates. Says nothing about an already-open browser page.
  ws.close();
  await stopServer();
  await cliOk('task', 'edit', seedIds[6], '-s', 'Done', '--append-notes', meta('while-down', 'none'));
  await startServer();
  tasks = await getTasks();
  check('state persisted and down-time update visible after restart', tasks.length === TOTAL && find(tasks, seedIds[6])?.status === 'Done' && find(tasks, life)?.status === 'Done');
  wsMessages.length = 0;
  ws = await connectWs();
  await expectLive('after-server-restart-new-manual-ws', () => cliOk('task', 'edit', seedIds[7], '-s', 'In Progress', '--append-notes', meta('restart', 'work')), (t) => find(t, seedIds[7])?.status === 'In Progress');

  // Explicitly demonstrate the product boundary: old intent is accepted, not rejected by CAS.
  const staleId = seedIds[10];
  await cliOk('task', 'edit', staleId, '-s', 'In Progress');
  await cliOk('task', 'edit', staleId, '-s', 'Done');
  await cliOk('task', 'edit', staleId, '-s', 'In Progress');
  await until('stale intent visible', async () => find(await getTasks(), staleId)?.status === 'In Progress');
  check('stale status intent is accepted: CAS is not enforced', true);

  // Exercise the actual wrapper in PowerShell 5.1, whose native binding otherwise drops empty args/quotes.
  const wrapper = async (...args) => {
    const payload = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const psQuote = s => "'" + s.replaceAll("'", "''") + "'";
    const script = `$ProgressPreference='SilentlyContinue'; $a = [string[]]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json); & ${psQuote(path.join(repo, 'scripts', 'backlog.ps1'))} -DataRoot ${psQuote(root)} -ExePath ${psQuote(exe)} @a; exit $LASTEXITCODE`;
    const result = await run(PS[0], [...PS.slice(1), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, USE_GLOBAL_TASK_ID_LOCK: 'false' } });
    if (result.code !== 0) throw new Error(`wrapper failed (${result.code}): ${result.out.slice(0, 2000)}`);
    return result.out;
  };
  const title = 'Synthetic 日本語 "quoted"';
  const description = 'Synthetic 日本語 "embedded quotes"\nsecond line\ntrailing backslash\\';
  await cliOk('config', 'set', 'defaultAssignee', 'synthetic-default');
  await wrapper('task', 'create', title, '-d', description, '-a', '', '--plain');
  let wrapped;
  await until('wrapper-created task visible', async () => (wrapped = (await getTasks()).find(t => t.title === title)));
  check('PowerShell 5.1 wrapper preserves empty assignee, quotes, Japanese and newline', wrapped.assignee.length === 0 && wrapped.description === description);
  await wrapper('task', 'edit', wrapped.id, '-a', 'synthetic-owner', '-s', 'In Progress', '--append-notes', description);
  await until('wrapper edit visible', async () => { wrapped = find(await getTasks(), wrapped.id); return wrapped?.status === 'In Progress'; });
  check('PowerShell 5.1 wrapper edit preserves quoted multiline notes', wrapped.assignee.length === 1 && wrapped.assignee[0] === 'synthetic-owner' && wrapped.implementationNotes.includes(description));
  await cliOk('task', 'archive', wrapped.id);
  await until('wrapper synthetic cleanup reflected', async () => (await getTasks()).length === TOTAL);
  check('wrapper synthetic task archived; original 30 retained', true);
  const listed = JSON.parse(await wrapper('task', 'list', '--json'));
  check('wrapper keeps machine-readable stdout streaming', listed.kind === 'task-list' && listed.tasks.length === TOTAL);
}

let failure;
const watchdog = setTimeout(() => { console.error('FAIL global timeout'); for (const p of children) kill(p); process.exit(2); }, 240_000);
const started = new Date().toISOString();
try { await main(); } catch (e) { failure = e; console.error(`FAIL ${e.message}`); }
finally {
  clearTimeout(watchdog);
  try { ws?.close(); } catch {}
  for (const p of children) kill(p);
  await sleep(500);
  try {
    if (root) {
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('ai-ttd-test-')) throw new Error('Invalid cleanup target');
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (fs.existsSync(root)) throw new Error('Temp root still exists after cleanup');
    }
  } catch (e) { failure ??= new Error(`cleanup failed: ${e.message}`); console.error(`FAIL ${failure.message}`); }
  const result = { started, finished: new Date().toISOString(), node: process.version, backlogExe: path.basename(exe ?? ''), ok: !failure, error: failure?.message, checks, timings, tempRootRemoved: root ? !fs.existsSync(root) : null };
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `integration-${started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`${result.ok ? 'OK' : 'FAILED'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks; results: ${file}`);
  process.exit(result.ok ? 0 : 1);
}
