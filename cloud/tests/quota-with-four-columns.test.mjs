// Production's quota observation-time display and the four-column board must coexist (synthetic data, same page context).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.value = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this[type] = listener; }
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function page() {
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const document = { hidden: true, activeElement: null, addEventListener() {}, createElement: tag => new Element(tag), getElementById: el };
  const context = createContext({ document, setInterval() {}, AbortSignal });
  runInContext(source, context);
  return { el, context };
}
const stamp = delta => new Date(Date.now() + delta).toISOString();
const task = (id, status, version) => ({ id, title: `Synthetic ${status}`, status, owner: 'synthetic-agent', group: '現行', detail: '合成', lastConfirmedAt: null, version, updatedAt: stamp(-5000), });
const row = (over = {}) => ({ status: 'available', model_family: 'codex', quota_scope: 'own_subscription', shared_pool: null, period: 'weekly', remaining_percent: 40, used_percent: 60, observed_at: stamp(-1000), reset_at: stamp(86400000), fresh_until: stamp(60000), ...over });
const card = (over = {}) => ({ provider: 'codex', status: 'available', collected_at: stamp(-1000), current_rows: [row()], last_known_rows: [], ...over });

test('quota summary (acquisition time, Codex weekly only, unknown stays unknown) renders on the same page as the four-column board with legacy badges', () => {
  const { el, context } = page();
  context.next = { revision: 4, observedAt: stamp(0), tasks: [
    { ...task('A-1', 'To Do', 1) },
    { ...task('A-2', 'In Progress', 2), legacyStatus: 'Verifying' },
    { ...task('A-3', 'Blocked', 3), legacyStatus: 'Awaiting Approval' },
    { ...task('A-4', 'Done', 4) }] };
  runInContext('snapshot = next; online = true; render()', context);
  const columns = el('board').children;
  assert.deepEqual(columns.map(c => c.children[0].textContent.split(' ·')[0]), ['To Do', 'In Progress', 'Blocked', 'Done']);
  assert.match(text(columns[1]), /旧「最終確認」から表示/);
  assert.match(text(columns[2]), /旧「承認待ち」から表示/);
  assert.doesNotMatch(text(columns[3]), /旧「/);

  context.input = { servedAt: stamp(0), entries: [], usage: { cards: [
    card(),
    card({ provider: 'claude', current_rows: [row({ model_family: 'claude', period: 'five_hour' })] }),
    card({ provider: 'antigravity', status: 'fetch_failed', collected_at: null, current_rows: [] })] } };
  runInContext('renderQuota(input)', context);
  const quota = text(el('quota'));
  assert.match(quota, /取得時刻: \d{4}\/\d{2}\/\d{2}/, 'card-level acquisition time is shown');
  assert.match(quota, /取得時刻: 未確認/, 'a failed collection does not invent an acquisition time');
  const codex = text(el('quota').children[0].children[0]);
  assert.match(codex, /Weekly 40%/); assert.doesNotMatch(codex, /5h/, 'Codex shows only its weekly window');
  // the board is still four columns after the quota render
  runInContext('render()', context);
  assert.equal(el('board').children.length, 4);
});

test('empty board with quota data shows four empty columns (0, not unfetched) and an unfetched board shows four dashes', () => {
  const { el, context } = page();
  context.next = { revision: 0, observedAt: stamp(0), tasks: [] };
  runInContext('snapshot = next; online = true; render()', context);
  assert.equal(el('board').children.length, 4);
  assert.equal((text(el('board')).match(/· 0/g) ?? []).length, 4);
  const fresh = page(); runInContext('render()', fresh.context);
  assert.equal(fresh.el('board').children.length, 4);
  assert.equal((text(fresh.el('board')).match(/· —/g) ?? []).length, 4);
});
