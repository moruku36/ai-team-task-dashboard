// Real-browser check of the display adapter on the OFFICIAL Backlog.md web UI (pinned binary copy).
// Isolated temp data root, synthetic tasks, loopback ports only, throw-away Chrome profile; nothing live is touched.
// Needs: .runtime\backlog.exe (scripts\Install-Backlog.ps1) and Chrome (CHROME_PATH or the default install path).
// A missing prerequisite FAILS the test; it is never skipped silently.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDisplayProxy} from '../scripts/status-display-proxy.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {const s = net.createServer(); s.listen(0, '127.0.0.1', () => {const {port} = s.address(); s.close(() => resolve(port));}); s.on('error', reject);});
const until = async (what, fn, timeout = 20000) => {const end = Date.now() + timeout; for (;;) {const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(100);}};
const iso = ms => new Date(ms).toISOString();

const usageInput = now => {
  const row = (family, scope, period, remaining, pool) => ({model_family: family, quota_scope: scope, period, window_id: 'secondary', status: 'available', remaining_percent: remaining, used_percent: 100 - remaining, reset_at: iso(now + (period === 'five_hour' ? 14400000 : 400000000)), observed_at: iso(now), ...(pool ? {shared_pool: pool} : {})});
  const base = {account_alignment: 'verified', collected_at: iso(now), last_success_collected_at: iso(now), stale_after_seconds: 3600};
  return {display_schema_version: 1, view_read_at: iso(now), cards: [
    {provider: 'codex', status: 'available', ...base, current_rows: [row('codex', 'own_subscription', 'five_hour', 61.1), row('codex', 'own_subscription', 'weekly', 88)], last_known_rows: []},
    {provider: 'claude', status: 'available', ...base, current_rows: [row('claude', 'own_subscription', 'five_hour', 80), row('claude', 'own_subscription', 'weekly', 90)], last_known_rows: []},
    {provider: 'antigravity', status: 'available', ...base, current_rows: [row('gemini', 'antigravity_shared', 'five_hour', 70, 'gemini_shared'), row('claude', 'antigravity_shared', 'five_hour', 60, 'claude_gpt_shared')], last_known_rows: [],
      argon_weekly: {limit_id: 'gemini_4_argon_weekly', percent: 95, percent_basis: 'remaining', observed_at: iso(now), reset_in_seconds: 4 * 86400}},
    {provider: 'mimo', status: 'available', ...base, balance: {amount: 12.34, currency: 'USD', observed_at: iso(now)}, last_known_balance: null}
  ]};
};

async function withBoard(run, {legacy = false} = {}) {
  const exe0 = [path.join(repo, '.runtime', 'backlog.exe'), path.join(repo, '..', '.runtime', 'backlog.exe')].find(existsSync);
  assert.ok(exe0, 'backlog.exe not found: run scripts\\Install-Backlog.ps1 (this test never skips silently)');
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.ok(existsSync(chrome), 'Set CHROME_PATH to a Chrome executable');
  const root = mkdtempSync(path.join(tmpdir(), 'board-root-')), bin = mkdtempSync(path.join(tmpdir(), 'board-bin-')), profile = mkdtempSync(path.join(tmpdir(), 'board-prof-'));
  const exe = path.join(bin, 'backlog.exe'); copyFileSync(exe0, exe);
  const usageFile = path.join(root, '..', `usage-${path.basename(root)}.json`); writeFileSync(usageFile, JSON.stringify(usageInput(Date.now())));
  const env = {...process.env, BACKLOG_CWD: root};
  const cli = (...args) => {const r = spawnSync(exe, args, {env, encoding: 'utf8', windowsHide: true}); if (r.status) throw new Error(`backlog ${args.slice(0, 2)} failed: ${r.stdout}${r.stderr}`.slice(0, 400)); return r.stdout;};
  const children = [];
  let proxy, ws;
  try {
    const init = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe, ...(legacy ? ['-LegacySixStatuses'] : [])], {encoding: 'utf8', windowsHide: true});
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const create = (title, status) => cli('task', 'create', title, '-s', status, '--plain');
    const officialPort = await freePort();
    const server = spawn(exe, ['browser', '--no-open', '--non-interactive', '--port', String(officialPort)], {env, windowsHide: true, stdio: 'ignore'}); children.push(server);
    proxy = createDisplayProxy(officialPort, {usageFile});
    const port = await freePort(); await new Promise(resolve => proxy.listen(port, '127.0.0.1', resolve));
    await until('official server', async () => (await fetch(`http://127.0.0.1:${officialPort}/api/tasks`)).ok, 30000);
    const debugPort = await freePort();
    children.push(spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], {windowsHide: true, stdio: 'ignore'}));
    const target = await until('CDP target', async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'));
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
    let id = 0; const pending = new Map();
    ws.onmessage = event => {const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) {pending.get(m.id)(m); pending.delete(m.id);}};
    const send = (method, params = {}) => new Promise(resolve => {const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({id: i, method, params}));});
    const page = {
      port, create, cli,
      size: (width, height = 900) => send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false}),
      scheme: scheme => send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: scheme}]}),
      open: async () => {await send('Page.navigate', {url: `http://127.0.0.1:${port}/board`}); await until('board', async () => (await page.js('document.querySelector("[aria-label^=\\"Open \\"]") !== null || document.querySelectorAll(".flex.items-center.justify-between.mb-4 h3").length >= 4')) === true, 30000);},
      js: async expression => {const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value;},
      settle: async (expression, timeout = 15000) => until(expression, async () => (await page.js(expression)) === true, timeout)
    };
    await run(page);
  } finally {
    try {ws?.close();} catch {}
    for (const child of children) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
    if (proxy) await new Promise(resolve => {proxy.close(resolve); proxy.closeAllConnections?.();});
    await sleep(500);
    for (const dir of [root, bin, profile]) {assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});}
    rmSync(usageFile, {force: true});
  }
}

const columnInfo = `(() => {
  const out = {};
  for (const h of document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3')) {
    const col = h.closest('div.flex-1'), r = col.getBoundingClientRect();
    const proxies = [...col.querySelectorAll(':scope>[data-dashboard-legacy-proxies] .dashboard-legacy-proxy')];
    out[h.textContent.trim()] = {hiddenLegacy: col.hasAttribute('data-dashboard-legacy-column'), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), shown: getComputedStyle(col).display !== 'none' && r.width > 0,
      cards: col.querySelectorAll('[aria-label^="Open "]').length,
      proxies: proxies.map(p => ({badge: p.querySelector('.dashboard-legacy-badge').textContent, text: p.querySelector('.dashboard-legacy-text').textContent, visible: p.getBoundingClientRect().width > 0}))};
  }
  return JSON.stringify(out);
})()`;
const columns = async page => JSON.parse(await page.js(columnInfo));

test('Usage cards hug their content: no stretched right-hand gap, no clipping, MiMo and Argon visible at wide and narrow widths', async () => {
  await withBoard(async page => {
    page.create('Synthetic todo', 'To Do');
    for (const width of [1700, 700]) {
      await page.size(width); await page.open();
      await page.settle(`document.querySelectorAll('#dashboard-usage section[style*="border-left"]').length >= 4`);
      const m = JSON.parse(await page.js(`(() => {
        const panel = document.getElementById('dashboard-usage'), grid = panel.firstElementChild;
        const cards = [...grid.children].map(s => { const r = s.getBoundingClientRect(); return {text: s.innerText.replace(/\\s+/g, ' ').trim(), width: Math.round(r.width), clipped: s.scrollWidth > s.clientWidth + 1, right: Math.round(r.right)}; });
        return JSON.stringify({cards, panelOverflow: panel.scrollWidth > panel.clientWidth + 1, gridWidth: Math.round(grid.getBoundingClientRect().width)});
      })()`));
      assert.equal(m.cards.length, 5);
      assert.ok(m.cards.every(card => !card.clipped), `no card is clipped at ${width}: ${JSON.stringify(m.cards)}`);
      assert.ok(m.cards.every(card => card.width < 330), `cards are not stretched at ${width}: ${m.cards.map(c => c.width)}`);
      assert.equal(m.panelOverflow, false);
      const joined = m.cards.map(card => card.text).join(' | ');
      assert.match(joined, /USD 12\.34/);
      assert.match(joined, /Argon週 95%/);
      assert.match(joined, /AG Gemini[^|]*5h 70%/);
    }
  });
}, {timeout: 240000});

const shownColumns = c => Object.keys(c).filter(k => c[k].shown).sort();
const savedStatus = (page, id) => page.cli('task', 'view', id, '--plain').match(/^\s*Status:\s*(?:[^A-Za-z]*)(.+?)\s*$/m)?.[1];

test('Four-column board: a fresh root shows exactly To Do / In Progress / Blocked / Done', async () => {
  await withBoard(async page => {
    page.create('Synthetic todo', 'To Do'); page.create('Synthetic done', 'Done');
    await page.size(1800); await page.open();
    await page.settle(`JSON.parse(${columnInfo}).Done !== undefined`);
    const c = await columns(page);
    assert.deepEqual(shownColumns(c), ['Blocked', 'Done', 'In Progress', 'To Do']);
  });
}, {timeout: 240000});

test('Legacy root: old-status cards appear inside the four columns with a badge, no fifth column, saved statuses untouched', async () => {
  await withBoard(async page => {
    page.create('Synthetic todo', 'To Do'); page.create('Synthetic done', 'Done');
    page.create('Synthetic legacy final check', 'Verifying'); page.create('Synthetic legacy approval', 'Awaiting Approval');
    await page.size(1800); await page.open();
    await page.settle(`(() => { const c = JSON.parse(${columnInfo}); return c['In Progress']?.proxies.length === 1 && c.Blocked?.proxies.length === 1; })()`);
    let c = await columns(page);
    assert.deepEqual(shownColumns(c), ['Blocked', 'Done', 'In Progress', 'To Do'], `no 5th/6th column: ${JSON.stringify(shownColumns(c))}`);
    assert.equal(c['In Progress'].proxies[0].badge, '旧「最終確認」から表示（要確認）');
    assert.match(c['In Progress'].proxies[0].text, /Synthetic legacy final check/);
    assert.equal(c.Blocked.proxies[0].badge, '旧「承認待ち」から表示（要確認）');
    assert.match(c.Blocked.proxies[0].text, /Synthetic legacy approval/);
    assert.ok(c['In Progress'].proxies[0].visible && c.Blocked.proxies[0].visible);
    assert.equal(c.Done.proxies.length, 0, 'legacy cards are never shown as Done');
    assert.equal(c.Done.cards, 1);
    // Display only: the saved statuses are unchanged and nothing was bulk-migrated.
    assert.equal(savedStatus(page, 'TASK-3'), 'Verifying');
    assert.equal(savedStatus(page, 'TASK-4'), 'Awaiting Approval');
    // Clicking the mirrored card reaches the real card (detail opens).
    await page.js(`document.querySelector('.dashboard-legacy-proxy').click(), true`);
    await page.settle(`location.pathname === '/board/TASK-3/synthetic-legacy-final-check' && document.querySelectorAll('[role=dialog]').length === 1`);
    await page.js(`history.back(), true`);
    // Re-render when the legacy card is later moved by the owner: the mirror disappears and the card shows natively.
    page.cli('task', 'edit', 'TASK-3', '-s', 'In Progress');
    await page.open();
    await page.settle(`(() => { const c = JSON.parse(${columnInfo}); return c['In Progress']?.proxies.length === 0 && c['In Progress'].cards === 1; })()`);
    c = await columns(page);
    assert.equal(c.Blocked.proxies.length, 1);
    assert.deepEqual(shownColumns(c), ['Blocked', 'Done', 'In Progress', 'To Do']);
  }, {legacy: true});
}, {timeout: 240000});

test('Legacy root, narrow window: still four columns and Done stays reachable by horizontal scroll', async () => {
  await withBoard(async page => {
    page.create('Synthetic legacy approval', 'Awaiting Approval'); page.create('Synthetic done', 'Done');
    await page.size(800); await page.open();
    await page.settle(`JSON.parse(${columnInfo}).Blocked?.proxies.length === 1`);
    assert.deepEqual(shownColumns(await columns(page)), ['Blocked', 'Done', 'In Progress', 'To Do']);
    const reach = JSON.parse(await page.js(`(async () => {
      const done = [...document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3')].find(h => h.textContent.trim() === 'Done').closest('div.flex-1');
      done.scrollIntoView({inline: 'end', block: 'nearest'}); await new Promise(r => setTimeout(r, 300));
      const r = done.getBoundingClientRect();
      return JSON.stringify({inView: r.left >= 0 && r.right <= innerWidth + 1});
    })()`));
    assert.ok(reach.inView, 'Done is reachable by scrolling');
  }, {legacy: true});
}, {timeout: 240000});


test('Legacy root with no cards still shows exactly four columns', async () => {
  await withBoard(async page => {
    await page.size(1800); await page.open();
    await page.settle(`document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3').length >= 4`);
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval']?.hiddenLegacy === true && JSON.parse(${columnInfo})['旧「最終確認」（要確認）']?.hiddenLegacy === true`);
    const c = await columns(page);
    assert.deepEqual(shownColumns(c), ['Blocked', 'Done', 'In Progress', 'To Do'], JSON.stringify(shownColumns(c)));
  }, {legacy: true});
}, {timeout: 240000});
