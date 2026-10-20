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

async function withBoard(run) {
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
    const init = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'Initialize-DataRoot.ps1'), '-DataRoot', root, '-ExePath', exe], {encoding: 'utf8', windowsHide: true});
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
      open: async () => {await send('Page.navigate', {url: `http://127.0.0.1:${port}/board`}); await until('board', async () => (await page.js('document.querySelector("[data-dashboard-fold-control]") !== null || document.querySelector("[aria-label^=\\"Open \\"]") !== null')) === true, 30000);},
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
    const col = h.closest('div.flex-1'), r = col.getBoundingClientRect(), control = col.querySelector(':scope>[data-dashboard-fold-control]');
    out[h.textContent.trim()] = {mode: col.dataset.dashboardFold || null, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), shown: getComputedStyle(col).display !== 'none' && r.width > 0,
      cards: col.querySelectorAll('[aria-label^="Open "]').length,
      visibleCards: [...col.querySelectorAll('[aria-label^="Open "]')].filter(c => c.getBoundingClientRect().width > 0).length,
      control: control && !control.hidden ? {text: control.textContent, expanded: control.getAttribute('aria-expanded'), width: Math.round(control.getBoundingClientRect().width)} : null};
  }
  return JSON.stringify(out);
})()`;
const columns = async page => JSON.parse(await page.js(columnInfo));

test('Awaiting Approval: empty column is hidden, non-empty folds with a count, expands and survives re-render; right columns stay reachable', async () => {
  await withBoard(async page => {
    page.create('Synthetic todo', 'To Do'); page.create('Synthetic verifying', 'Verifying'); page.create('Synthetic done', 'Done');
    await page.size(1800); await page.open();
    await page.settle(`JSON.parse(${columnInfo}).Done !== undefined`);
    // 0 tasks: column hidden by display only; every other status keeps its column.
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].mode === 'empty'`);
    let c = await columns(page);
    assert.equal(c['Awaiting Approval'].shown, false);
    for (const status of ['To Do', 'In Progress', 'Blocked', '最終確認', 'Done']) assert.equal(c[status]?.shown, true, `${status} in ${Object.keys(c)}`);
    assert.ok(c.Done.right <= 1800, `Done fits on a wide screen (right=${c.Done.right})`);
    // 2 tasks: folds into a slim rail with the count; cards stay in the DOM.
    page.create('Synthetic approval A', 'Awaiting Approval'); page.create('Synthetic approval B', 'Awaiting Approval');
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].mode === 'collapsed'`);
    c = await columns(page);
    assert.equal(c['Awaiting Approval'].cards, 2, 'tasks are kept, only hidden');
    assert.equal(c['Awaiting Approval'].visibleCards, 0);
    assert.equal(c['Awaiting Approval'].control.text, '承認待ち 2件');
    assert.equal(c['Awaiting Approval'].control.expanded, 'false');
    assert.ok(c['Awaiting Approval'].width <= 64, `rail is slim (${c['Awaiting Approval'].width}px)`);
    // Label and count must not overlap each other or spill out of the rail.
    const geometry = JSON.parse(await page.js(`(() => {
      const control = document.querySelector('[data-dashboard-fold-control]'), box = control.getBoundingClientRect();
      const label = control.querySelector('.dashboard-fold-label').getBoundingClientRect(), count = control.querySelector('.dashboard-fold-count').getBoundingClientRect();
      const overlap = !(label.bottom <= count.top || count.bottom <= label.top || label.right <= count.left || count.right <= label.left);
      const inside = r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      return JSON.stringify({overlap, labelInside: inside(label), countInside: inside(count), countAbove: count.bottom <= label.top + 0.5, labelText: control.querySelector('.dashboard-fold-label').textContent, countText: control.querySelector('.dashboard-fold-count').textContent, upright: getComputedStyle(control.querySelector('.dashboard-fold-label')).textOrientation});
    })()`));
    assert.equal(geometry.overlap, false, JSON.stringify(geometry));
    assert.ok(geometry.labelInside && geometry.countInside, JSON.stringify(geometry));
    assert.ok(geometry.countAbove, 'count is shown above the label');
    assert.equal(geometry.labelText, '承認待ち'); assert.equal(geometry.countText, '2件'); assert.equal(geometry.upright, 'upright');
    assert.ok(c.Done.right <= 1800 && c['最終確認'].right <= 1800, `right-hand columns visible: ${JSON.stringify(c)}`);
    // Extra width is used by the remaining columns (flex-1), not left empty on the right.
    await page.size(2300);
    await page.settle(`JSON.parse(${columnInfo}).Done.width > 300`);
    c = await columns(page);
    assert.ok(c.Done.right <= 2300 && c.Done.width > 300 && c['Awaiting Approval'].width <= 64, JSON.stringify(c));
    await page.size(1800);
    // Re-render: a new task changes the count while the fold stays in effect.
    page.create('Synthetic approval C', 'Awaiting Approval');
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].control?.text === '承認待ち 3件'`);
    assert.equal((await columns(page))['Awaiting Approval'].mode, 'collapsed');
    // Expand with the keyboard-accessible button; tasks become visible and the count matches.
    assert.equal(await page.js(`document.querySelector('[data-dashboard-fold-control]').tagName`), 'BUTTON');
    await page.js(`document.querySelector('[data-dashboard-fold-control]').click(), true`);
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].mode === 'open'`);
    c = await columns(page);
    assert.equal(c['Awaiting Approval'].visibleCards, 3);
    assert.equal(c['Awaiting Approval'].control.expanded, 'true');
    // Moving the last tasks away re-hides the column without losing the others.
    page.cli('task', 'edit', 'TASK-4', '-s', 'To Do'); page.cli('task', 'edit', 'TASK-5', '-s', 'To Do'); page.cli('task', 'edit', 'TASK-6', '-s', 'To Do');
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].mode === 'empty'`);
    assert.equal((await columns(page))['To Do'].cards, 4);
  });
}, {timeout: 240000});

test('Narrow window keeps every column reachable by horizontal scroll; light and dark keep the fold control legible', async () => {
  await withBoard(async page => {
    page.create('Synthetic approval A', 'Awaiting Approval'); page.create('Synthetic done', 'Done');
    await page.size(800); await page.open();
    await page.settle(`JSON.parse(${columnInfo})['Awaiting Approval'].mode === 'collapsed'`);
    const reach = await page.js(`(async () => {
      const done = [...document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3')].find(h => h.textContent.trim() === 'Done').closest('div.flex-1');
      let scroller = done.parentElement; while (scroller && scroller.scrollWidth <= scroller.clientWidth + 2) scroller = scroller.parentElement;
      done.scrollIntoView({inline: 'end', block: 'nearest'}); await new Promise(r => setTimeout(r, 300));
      const r = done.getBoundingClientRect();
      return JSON.stringify({scrollable: !!scroller, overflowX: scroller && getComputedStyle(scroller).overflowX, inView: r.left >= 0 && r.right <= innerWidth + 1, right: Math.round(r.right), innerWidth});
    })()`);
    const info = JSON.parse(reach);
    assert.ok(info.scrollable, 'a horizontal scroll container exists');
    assert.ok(info.inView, `Done is reachable by scrolling ${reach}`);
    for (const dark of [false, true]) {
      // The app themes through the `dark` class on <html>; measure WCAG contrast of the control against its real backdrop.
      const value = JSON.parse(await page.js(`(async () => {
        document.documentElement.classList.toggle('dark', ${dark}); await new Promise(r => setTimeout(r, 200));
        const b = document.querySelector('[data-dashboard-fold-control]'), s = getComputedStyle(b);
        const canvas = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
        const rgba = v => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = '#000'; canvas.fillStyle = v; canvas.fillRect(0, 0, 1, 1); const d = canvas.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        let bg = [0, 0, 0, 0];
        for (let el = b; el; el = el.parentElement) { bg = rgba(getComputedStyle(el).backgroundColor); if (bg[3] > 0.99) break; }
        const lum = c => { const [r, g, bl] = c.slice(0, 3).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        const fg = rgba(s.color), l1 = lum(fg), l2 = lum(bg), ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        return JSON.stringify({dark: ${dark}, color: s.color, backdrop: bg.join(','), ratio: Math.round(ratio * 100) / 100, display: s.display, textLen: b.textContent.length});
      })()`));
      assert.notEqual(value.display, 'none'); assert.ok(value.textLen > 0);
      assert.ok(value.ratio >= 4.5, `fold control contrast ${value.ratio} (${JSON.stringify(value)})`);
    }
  });
}, {timeout: 240000});

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
