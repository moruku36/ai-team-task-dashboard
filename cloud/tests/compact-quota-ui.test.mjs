import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.value = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this[type] = listener; }
  focus() { documentStub.activeElement = this; }
}
let documentStub;
const text = element => [element.textContent, ...element.children.map(text)].join(' ');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function harness() {
  const elements = new Map();
  documentStub = { hidden: true, activeElement: null, addEventListener() {}, createElement: tag => new Element(tag), getElementById(id) { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); } };
  const context = createContext({ document: documentStub, setInterval() {}, AbortSignal });
  runInContext(source, context);
  const render = quota => { context.input = quota; runInContext('renderQuota(input)', context); return elements.get('quota'); };
  return { render, context };
}
const stamp = delta => new Date(Date.now() + delta).toISOString();
const row = (over = {}) => ({ status: 'available', model_family: 'synthetic', shared_pool: null, period: 'five_hour', remaining_percent: 0, used_percent: 100, observed_at: stamp(-1000), reset_at: stamp(3600000), fresh_until: stamp(60000), ...over });
const card = (over = {}) => ({ provider: 'codex', status: 'available', collected_at: stamp(-1000), current_rows: [row()], last_known_rows: [], ...over });
const quota = cards => ({ servedAt: stamp(0), entries: [], usage: { cards } });
test('reset windows use explicit JST and distinguish fresh countdown, stale references, passed and unknown', () => {
  const { context } = harness(); const now = Date.parse('2030-01-01T00:00:00Z');
  const c = card({ collected_at: '2029-12-31T23:59:00Z' }), r = row({ observed_at: '2029-12-31T23:59:00Z', fresh_until: '2030-01-01T00:05:00Z', reset_at: '2030-01-01T01:00:00Z' });
  context.c = c; context.r = r; context.now = now;
  const render = historical => runInContext(`quotaResetText(c,r,${historical},now)`, context);
  assert.match(render(false), /10:00 JST.*あと1時間0分/);
  assert.match(render(true), /参考.*古い値/); assert.doesNotMatch(render(true), /あと/);
  context.r = { ...r, reset_at: '2029-12-31T23:00:00Z' }; assert.match(render(false), /更新待ち/);
  context.r = { ...r, reset_at: null }; assert.match(render(false), /未取得/);
  context.r = { ...r, reset_at: '2030-01-04T00:00:00Z' }; assert.match(render(false), /未確認/);
  context.r = { ...r, period: 'weekly', reset_at: '2030-01-04T00:00:00Z' }; assert.match(render(false), /あと3日0分/);
});
test('compact remaining percentages preserve zero, closed disclosure and focus across refresh', () => {
  const { render } = harness(); let panel = render(quota([card()]));
  assert.match(text(panel.children[0]), /5h 0%/);
  assert.match(text(panel.children[0]), /Weekly \?/);
  assert.equal(panel.children[1].open, false);
  panel.children[1].open = true; documentStub.activeElement = panel.children[1].children[0];
  panel = render(quota([card()]));
  assert.equal(panel.children[1].open, true);
  assert.equal(documentStub.activeElement, panel.children[1].children[0]);
  panel.children[1].open = false; panel = render(quota([card()]));
  assert.equal(panel.children[1].open, false);
});
test('expired, future, failed, unbounded and ambiguous observations cannot display current quota', () => {
  const { render } = harness();
  const cases = [card({ status: 'fetch_failed' }), card({ collected_at: stamp(60000) }), card({ current_rows: [row({ observed_at: stamp(60000) })] }), card({ current_rows: [row({ fresh_until: stamp(-1000) })] }), card({ current_rows: [row({ reset_at: stamp(-1000) })] }), card({ current_rows: [row({ reset_at: stamp(19000000) })] }), card({ current_rows: [row(), row()] })];
  for (const entry of cases) assert.doesNotMatch(text(render(quota([entry])).children[0]), /5h 0%/);
  const historical = card({ current_rows: [], last_known_rows: [row({ remaining_percent: 23 })] });
  assert.match(text(render(quota([historical])).children[0]), /5h 23% reference/);
});
test('Antigravity renders shared pools independently and leaves model references in disclosure', () => {
  const { render } = harness();
  const panel = render(quota([card({ provider: 'antigravity', current_rows: [row({ shared_pool: 'gemini_shared', remaining_percent: 42 }), row({ shared_pool: 'claude_gpt_shared', remaining_percent: 18 })], model_references: [{ official_name: 'Synthetic model', shared_pool: 'claude_gpt_shared' }] })]));
  const compact = text(panel.children[0]);
  assert.match(compact, /Gemini shared.*5h 42%/); assert.match(compact, /Claude \/ GPT shared.*5h 18%/);
  assert.doesNotMatch(compact, /Synthetic model/); assert.match(text(panel.children[1]), /individual quota not reported/);
});
