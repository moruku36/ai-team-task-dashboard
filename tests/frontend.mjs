// Real headless-browser test of the OFFICIAL standard Backlog.md v1.53.0 web UI (/board) on Windows.
// Usage: node tests/frontend.mjs [--exe <backlog.exe>] [--browser chrome|edge] [--results-dir <dir>] [--preflight-only]
// No npm dependencies: Chrome DevTools Protocol over Node 22's built-in WebSocket. No GUI (headless=new).
// Uses an isolated temp no-git data root, a COPY of the pinned binary, synthetic tasks and a throw-away
// browser profile. It never reads the browser profile or its logs.
//
// What it measures (see upstream src/web/App.tsx and hooks/useHealthCheck.tsx):
//  * The UI loads data via GET /api/search (not /api/tasks) and re-fetches it on the "tasks-updated" WS frame.
//  * The data WebSocket (App.tsx effect) has no reconnect code. A separate health-check WebSocket reconnects every
//    5 s, and on recovery App triggers ONE loadAllData(). Whether later CLI updates reach the same page after a
//    server restart is the "standard UI continued updates" verdict; FAIL always gives a nonzero exit.
//    A manual reconnect or page reload is NOT the same as automatic UI continuity and is reported separately.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const exeCandidates = [arg('--exe'), path.join(repo, '.runtime', 'backlog.exe'), path.join(repo, '..', '.runtime', 'backlog.exe')].filter(Boolean);
const srcExe = exeCandidates.find((p) => fs.existsSync(p));
const resultsDir = path.resolve(arg('--results-dir', path.join(repo, 'results')));
const browsers = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
const browserName = arg('--browser', 'chrome');
const preflightOnly = process.argv.includes('--preflight-only');
const PINNED_SHA256 = 'f5d4678ababa11e36866186e897a86e68e9f1f3c263d6c97034f674622abc689';
const LIMIT_MS = 10_000;
const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const checks = [];
const metrics = { childProcessStarts: 0 };
const children = new Set();
const ownedDirs = [];
let root, exe, binDir, profileDir, server, base, port, chrome, cdp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
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
// Like until(), but returns undefined instead of throwing and reports elapsed ms.
async function tryUntil(fn, timeoutMs, step = 100) {
  const t0 = now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return { value: v, ms: Math.round(now() - t0) };
    if (now() - t0 > timeoutMs) return { value: undefined, ms: Math.round(now() - t0) };
    await sleep(step);
  }
}
function kill(p) {
  if (!p || p.pid === undefined) return;
  spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    metrics.childProcessStarts++;
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    children.add(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { kill(p); reject(new Error(`timeout: ${path.basename(cmd)} ${args.slice(0, 3).join(' ')}`)); }, 60_000);
    p.on('close', (code) => { clearTimeout(timer); children.delete(p); resolve({ code, out }); });
    p.on('error', reject);
  });
}
const cliOk = async (...args) => {
  const r = await run(exe, args, { env: { ...process.env, BACKLOG_CWD: root } });
  if (r.code !== 0) throw new Error(`backlog ${args.slice(0, 2).join(' ')} failed (${r.code}): ${r.out.slice(0, 300)}`);
  return r.out;
};
const meta = (n, next) =>
  `observed_at: ${new Date().toISOString()} | reported_at: ${new Date().toISOString()} | source: synthetic-test | next_action: ${next} | wait_reason: none | synthetic task ${n}`;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.on('error', reject);
});
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---- official server (same port across restarts) ----
async function startServer() {
  metrics.childProcessStarts++;
  server = spawn(exe, ['browser', '--no-open', '--non-interactive', '--port', String(port)], {
    env: { ...process.env, BACKLOG_CWD: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(server);
  server.stdout.resume(); server.stderr.resume(); // output is discarded, never stored
  server.on('close', () => children.delete(server));
  await until('server ready', async () => (await fetch(`${base}/api/tasks`)).ok, 30_000, 250); // readiness only
}
async function stopServer() {
  const p = server;
  kill(p);
  await until('server exit', async () => p.exitCode !== null || p.signalCode !== null, 10_000);
  await until('port released', async () => (await fetch(`${base}/api/tasks`).then(() => false, () => true)), 10_000, 100);
}

// ---- minimal CDP client ----
async function openCdp(debugPort) {
  const list = await until('CDP page target', async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const t = (await r.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    return t;
  }, 20_000, 200);
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg.method, msg.params);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id; pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    on: (l) => listeners.push(l),
    close: () => { try { ws.close(); } catch {} },
  };
}

// ---- network instrumentation (events from CDP Network domain) ----
const net_ = {
  sockets: new Map(), // requestId -> { created, closed, frames: n, tasksUpdatedFrames: n }
  searchFetches: [], // timestamps of GET /api/search
  otherApi: {},
};
function onCdpEvent(method, p) {
  if (method === 'Network.webSocketCreated') net_.sockets.set(p.requestId, { created: now(), closed: null, tasksUpdated: 0 });
  else if (method === 'Network.webSocketClosed') { const s = net_.sockets.get(p.requestId); if (s) s.closed = now(); }
  else if (method === 'Network.webSocketFrameReceived') {
    const s = net_.sockets.get(p.requestId);
    if (s && p.response?.payloadData === 'tasks-updated') s.tasksUpdated++;
  } else if (method === 'Network.requestWillBeSent') {
    const u = new URL(p.request.url);
    if (u.pathname === '/api/search') net_.searchFetches.push(now());
    else if (u.pathname.startsWith('/api/')) net_.otherApi[u.pathname] = (net_.otherApi[u.pathname] ?? 0) + 1;
  }
}
const snap = () => ({
  wsCreated: net_.sockets.size,
  wsOpen: [...net_.sockets.values()].filter((s) => s.closed === null).length,
  wsClosed: [...net_.sockets.values()].filter((s) => s.closed !== null).length,
  tasksUpdatedFrames: [...net_.sockets.values()].reduce((n, s) => n + s.tasksUpdated, 0),
  searchFetches: net_.searchFetches.length,
});

// ---- DOM probe: board columns/cards + connection banners, all via the real rendered page ----
const PROBE = `(() => {
  const cards = {};
  for (const el of document.querySelectorAll('[aria-label^="Open "]')) {
    const m = /^Open ([^:]+): (.*)$/.exec(el.getAttribute('aria-label') || '');
    if (!m) continue;
    let col = el, status = null;
    while ((col = col.parentElement)) { const h = col.querySelector('h3'); if (h) { status = h.textContent.trim(); break; } }
    cards[m[1].toLowerCase()] = { title: m[2].split('. Acceptance')[0], status };
  }
  const text = document.body ? document.body.innerText : '';
  return { href: location.pathname, cards, disconnected: /Server disconnected/.test(text), restored: /Connection restored/.test(text) };
})()`;
const dom = async () => (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
const statusOf = async (id) => (await dom()).cards[id.toLowerCase()]?.status ?? null;

async function cliUpdateAndWatch(label, id, status, extra = []) {
  const before = snap();
  const t0 = now();
  await cliOk('task', 'edit', id, '-s', status, '--append-notes', meta(label, 'next'), ...extra);
  const saved = now();
  const r = await tryUntil(async () => (await statusOf(id)) === status, LIMIT_MS, 100);
  const after = snap();
  const m = {
    cliMs: Math.round(saved - t0), domUpdatedMs: r.value ? r.ms : null,
    searchFetches: after.searchFetches - before.searchFetches, tasksUpdatedFrames: after.tasksUpdatedFrames - before.tasksUpdatedFrames,
    observedDomStatus: r.value ? status : await statusOf(id),
  };
  return { ok: !!r.value, m };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  if (!srcExe) throw new Error('backlog.exe not found (use --exe or scripts\\Install-Backlog.ps1)');
  if (typeof WebSocket === 'undefined') throw new Error('Node built-in WebSocket unavailable (need Node 22+)');
  const browserExe = browsers[browserName];
  if (!preflightOnly && (!browserExe || !fs.existsSync(browserExe))) throw new Error(`browser not found: ${browserName}`);

  // Isolated root + explicit separate binary copy (verified identical to the pinned one).
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ttd-fe-')); ownedDirs.push(root);
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ttd-febin-')); ownedDirs.push(binDir);
  exe = path.join(binDir, 'backlog.exe');
  fs.copyFileSync(srcExe, exe);
  // The official pinned digest must match BEFORE ANY subprocess can execute this copy.
  check('binary matches official pinned SHA-256 before execution', sha(exe) === PINNED_SHA256);
  check('separate binary copy is byte-identical to the pinned binary', sha(exe) === sha(srcExe));
  const ver = (await run(exe, ['--version'])).out.trim();
  check('binary reports v1.53.0', /1\.53\.0/.test(ver), { version: ver.slice(0, 40) });
  if (preflightOnly) return;
  let git = false;
  for (let d = root; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) git = true; if (path.dirname(d) === d) break; }
  check('temp data root is outside any git workspace', !git);
  const init = await run(PS[0], [...PS.slice(1), '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe]);
  check('Initialize-DataRoot.ps1 succeeds', init.code === 0, init.code === 0 ? undefined : init.out.slice(0, 400));

  const mk = async (title, status) => {
    const out = await cliOk('task', 'create', title, '-d', meta(title, 'none'), '-a', '@ai-1', '-s', status, '--plain');
    const id = out.match(/\b([A-Za-z]+-\d+)\b/)?.[1];
    if (!id) throw new Error('cannot parse task id');
    return id;
  };
  const seed = [await mk('Synthetic seed A', 'To Do'), await mk('Synthetic seed B', 'In Progress')];

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();

  // Headless browser, isolated profile, loopback-only debugging port.
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ttd-feprof-')); ownedDirs.push(profileDir);
  const debugPort = await freePort();
  metrics.childProcessStarts++;
  chrome = spawn(browserExe, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  children.add(chrome);
  chrome.on('close', () => children.delete(chrome));
  cdp = await openCdp(debugPort);
  cdp.on(onCdpEvent);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${base}/board` });

  const first = await tryUntil(async () => { const d = await dom(); return seed.every((id) => d.cards[id.toLowerCase()]) && d; }, 30_000, 200);
  check('real /board rendered seed cards in the DOM', !!first.value, { ms: first.ms });
  const d0 = first.value;
  check('seed cards are in their status columns', d0.cards[seed[0].toLowerCase()].status === 'To Do' && d0.cards[seed[1].toLowerCase()].status === 'In Progress');
  check('no disconnect banner while server is up', !d0.disconnected);
  await sleep(1500); // let the health-check socket (100 ms delayed) connect
  const s0 = snap();
  metrics.initialLoad = { ...s0, loadMs: first.ms, otherApiRequests: { ...net_.otherApi } };
  check('initial load fetched /api/search (what the UI really calls)', s0.searchFetches >= 1, { searchFetches: s0.searchFetches });
  check('UI opens two WebSockets (data + health check)', s0.wsOpen === 2, { wsCreated: s0.wsCreated, wsOpen: s0.wsOpen });
  check('the UI did not call /api/tasks to load the board', !net_.otherApi['/api/tasks'], { apiTasksCalls: net_.otherApi['/api/tasks'] ?? 0 });

  // Phase 1: lifecycle on the same page while the server stays up.
  const life = await mk('Synthetic lifecycle', 'To Do');
  const created = await tryUntil(async () => (await statusOf(life)) === 'To Do', LIMIT_MS, 100);
  metrics.lifecycle = { create: { domUpdatedMs: created.value ? created.ms : null } };
  check('live: created task appears in To Do <10s', !!created.value, metrics.lifecycle.create);
  for (const [label, status] of [['in-progress', 'In Progress'], ['blocked', 'Blocked'], ['done', 'Done']]) {
    const r = await cliUpdateAndWatch(label, life, status);
    metrics.lifecycle[label] = r.m;
    check(`live: ${label} reflected in DOM <10s`, r.ok, r.m);
  }
  check('live updates went through the data WebSocket', metrics.lifecycle['done'].tasksUpdatedFrames >= 1, snap());

  // Phase 2: server down -> update while down -> restart on SAME port -> health reconnect.
  const tDown0 = now();
  const beforeDown = snap();
  await stopServer();
  const banner = await tryUntil(async () => (await dom()).disconnected, 15_000, 100);
  metrics.serverDown = { bannerShownMs: banner.value ? Math.round(banner.ms) : null, closedSockets: snap().wsClosed - beforeDown.wsClosed };
  check('DOM shows "Server disconnected" after server stops', !!banner.value, metrics.serverDown);

  const downTarget = seed[0];
  await cliOk('task', 'edit', downTarget, '-s', 'Blocked', '--append-notes', meta('while-down', 'none'));
  const dStale = await dom();
  check('while down the stale board is still shown (no refresh possible)', dStale.cards[downTarget.toLowerCase()]?.status === 'To Do');

  const beforeRestart = snap();
  const tRestart = now();
  await startServer();
  const serverBackMs = Math.round(now() - tRestart);
  // Health-check WS retries every 5 s; wait for the banner to clear AND the DOM to show the down-time update.
  const recovered = await tryUntil(async () => { const d = await dom(); return !d.disconnected && d.cards[downTarget.toLowerCase()]?.status === 'Blocked'; }, 25_000, 100);
  const recoveryMs = recovered.value ? recovered.ms : null;
  await sleep(4000); // settle: count anything further the page does on its own
  const afterRecovery = snap();
  const recSearch = afterRecovery.searchFetches - beforeRestart.searchFetches;
  const newSockets = afterRecovery.wsCreated - beforeRestart.wsCreated;
  const openAfter = afterRecovery.wsOpen;
  // Attempts made while down are failed sockets; successful ones are those still open that were created after restart.
  const reopened = [...net_.sockets.values()].filter((s) => s.created >= tRestart && s.closed === null).length;
  metrics.recovery = { serverBackMs, recoveryMs, searchFetchesSinceRestart: recSearch, socketsCreatedSinceRestart: newSockets, openSocketsCreatedAfterRestart: reopened, openSocketsNow: openAfter,
    tasksUpdatedFramesSinceRestart: afterRecovery.tasksUpdatedFrames - beforeRestart.tasksUpdatedFrames };
  check('health-check reconnect cleared banner and DOM shows down-time update', !!recovered.value, metrics.recovery);
  check('exactly one recovery snapshot (/api/search) after restart', recSearch === 1, { searchFetches: recSearch });
  const sbd = await dom();
  check('"Connection restored" is not required; recorded only', true, { toastVisibleNow: sbd.restored });

  // Phase 3: two subsequent CLI updates; does the SAME page update automatically within 10 s?
  const cont = {};
  const c1 = await cliUpdateAndWatch('post-restart-1', life, 'In Progress');
  cont.update1 = c1.m; cont.update1Pass = c1.ok;
  const c2 = await cliUpdateAndWatch('post-restart-2', life, 'Blocked');
  cont.update2 = c2.m; cont.update2Pass = c2.ok;
  const sockets = [...net_.sockets.values()];
  cont.openSocketsReceivingTasksUpdatedAfterRestart = sockets.filter((s) => s.closed === null && s.created >= tRestart && s.tasksUpdated > 0).length;
  cont.pass = c1.ok && c2.ok;
  metrics.continuity = cont;
  checks.push({ name: 'standard UI continued updates after restart', ok: cont.pass });
  console.log(`${cont.pass ? 'PASS' : 'FAIL'} STANDARD UI CONTINUED UPDATES after server restart (2 updates, <10s each, same DOM): ${JSON.stringify(cont)}`);
  if (!cont.pass) {
    console.log('LIMITATION CONFIRMED: after a server restart the page re-opened only the health-check WebSocket (no reconnect code for the data socket in App.tsx);');
    console.log('  that socket receives tasks-updated frames but has no message handler, so only the one recovery snapshot happens and later changes are not shown.');
  }

  // Diagnostic only (NOT UI continuity): what a manual page reload would show.
  const tNav = now();
  await cdp.send('Page.navigate', { url: `${base}/board` });
  const reload = await tryUntil(async () => (await statusOf(life)) === 'Blocked', 20_000, 200);
  metrics.diagnosticManualReload = { note: 'manual reload, not automatic UI continuity', domCorrectMs: reload.value ? Math.round(now() - tNav) : null };
  console.log(`INFO manual reload (diagnostic only, not counted): ${JSON.stringify(metrics.diagnosticManualReload)}`);
  check('explicit page reload restores current DOM snapshot', !!reload.value);
  const afterReload = await cliUpdateAndWatch('after-explicit-page-reload', life, 'In Progress');
  metrics.afterExplicitPageReload = afterReload.m;
  check('explicit page reload restores subsequent live updates', afterReload.ok, afterReload.m);
}

let failure;
const watchdog = setTimeout(() => { console.error('FAIL global timeout'); for (const p of children) kill(p); process.exit(2); }, 240_000);
const started = new Date().toISOString();
try { await main(); } catch (e) { failure = e; console.error(`FAIL ${e.message}`); }
finally {
  clearTimeout(watchdog);
  cdp?.close();
  for (const p of children) kill(p);
  await sleep(1000);
  const removed = {};
  for (const d of ownedDirs) {
    // Only directories this run created (mkdtemp under the OS temp dir with our prefix) are ever removed.
    if (!path.basename(d).startsWith('ai-ttd-fe') || path.dirname(d) !== os.tmpdir()) { failure ??= new Error('Invalid cleanup target'); continue; }
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 }); } catch (e) { failure ??= new Error(`cleanup failed: ${e.code ?? 'error'}`); console.error(`FAIL ${failure.message}`); }
    removed[path.basename(d).replace(/-[A-Za-z0-9]{6}$/, '')] = !fs.existsSync(d);
    if (fs.existsSync(d)) failure ??= new Error('Temp directory still exists after cleanup');
  }
  const continuity = metrics.continuity?.pass;
  const result = {
    started, finished: new Date().toISOString(), node: process.version, browser: browserName, backlogVersion: '1.53.0',
    scope: preflightOnly ? 'binary-preflight-only' : 'full-frontend',
    executionCompleted: !failure, ok: !failure && (preflightOnly || continuity === true), error: failure?.message,
    standardUiContinuedUpdates: continuity === undefined ? 'NOT-RUN' : continuity ? 'PASS' : 'FAIL',
    checks, metrics, tempDirsRemoved: removed,
  };
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${preflightOnly ? 'binary-preflight' : 'frontend'}-${started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`${result.ok ? 'OK' : 'FAILED'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks; standardUiContinuedUpdates=${result.standardUiContinuedUpdates}; results: ${file}`);
  process.exit(failure ? 1 : preflightOnly ? 0 : continuity === false ? 3 : continuity === true ? 0 : 1);
}
