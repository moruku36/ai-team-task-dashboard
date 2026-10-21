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
  const { render } = harness(); const claude = () => quota([card({ provider: 'claude' })]); let panel = render(claude());
  assert.match(text(panel.children[0]), /5h 0%/);
  assert.match(text(panel.children[0]), /Weekly \?/);
  assert.equal(panel.children[1].open, false);
  panel.children[1].open = true; documentStub.activeElement = panel.children[1].children[0];
  panel = render(claude());
  assert.equal(panel.children[1].open, true);
  assert.equal(documentStub.activeElement, panel.children[1].children[0]);
  panel.children[1].open = false; panel = render(claude());
  assert.equal(panel.children[1].open, false);
  assert.match(text(render(quota([card({ current_rows: [row({ period: 'weekly', reset_at: stamp(86400000) })] })])).children[0]), /Weekly 0%/);
});
test('expired, future, failed, unbounded and ambiguous observations cannot display current quota', () => {
  const { render } = harness();
  const cases = [card({ status: 'fetch_failed' }), card({ collected_at: stamp(60000) }), card({ current_rows: [row({ observed_at: stamp(60000) })] }), card({ current_rows: [row({ fresh_until: stamp(-1000) })] }), card({ current_rows: [row({ reset_at: stamp(-1000) })] }), card({ current_rows: [row({ reset_at: stamp(19000000) })] }), card({ current_rows: [row(), row()] })];
  for (const entry of cases) assert.doesNotMatch(text(render(quota([{ ...entry, provider: 'claude' }])).children[0]), /5h 0%/);
  const historical = card({ provider: 'claude', current_rows: [], last_known_rows: [row({ remaining_percent: 23 })] });
  assert.match(text(render(quota([historical])).children[0]), /5h 23% reference/);
});
test('Antigravity renders shared pools independently and leaves model references in disclosure', () => {
  const { render } = harness();
  const panel = render(quota([card({ provider: 'antigravity', current_rows: [row({ shared_pool: 'gemini_shared', remaining_percent: 42 }), row({ shared_pool: 'claude_gpt_shared', remaining_percent: 18 })], model_references: [{ official_name: 'Synthetic model', shared_pool: 'claude_gpt_shared' }] })]));
  const compact = text(panel.children[0]);
  assert.match(compact, /Gemini shared.*5h 42%/); assert.match(compact, /Claude \/ GPT shared.*5h 18%/);
  assert.doesNotMatch(compact, /Synthetic model/); assert.match(text(panel.children[1]), /individual quota not reported/);
});

test('quota provenance distinguishes observation, historical collection and task polling', () => {
  const { context, render } = harness();
  context.c = { collected_at: '2030-01-02T00:00:00Z', last_success_collected_at: '2030-01-01T00:00:00Z' };
  context.r = { observed_at: '2029-12-31T23:00:00Z' };
  assert.match(runInContext('quotaObservedText(c,r,true,"codex")', context), /観測: 2030\/01\/01 08:00:00 JST・参考値/);
  context.r = { observed_at: null };
  assert.equal(runInContext('quotaObservedText(c,r,false,"codex")', context), '観測: 未確認');
  assert.match(runInContext('quotaObservedText(c,r,true,"antigravity")', context), /収集: 2030\/01\/01 09:00:00 JST・参考値/);
  const panel = render(quota([card({ provider: 'claude', current_rows: [], last_success_collected_at: stamp(-86400000), last_known_rows: [row({ period: 'weekly', remaining_percent: 49, observed_at: stamp(-86400000) })] })]));
  assert.match(text(panel.children[0]), /Weekly 49% reference/);
  assert.match(text(panel.children[0]), /観測:.*参考値/);
  assert.match(text(panel.children[0]), /表示の更新だけでは残量を再取得しません/);
  assert.match(text(panel.children[0]), /ChatGPTの単独利用枠は未取得/);
  assert.match(source, /タスク一覧の同期/);
  assert.doesNotMatch(source, /最終取得:/);
});

test('historical percentage and reset use the same reference row', () => {
  const { render } = harness();
  const oldReset = stamp(3600000), newReset = stamp(7200000);
  const panel = render(quota([card({ provider: 'claude', current_rows: [row({ fresh_until: stamp(-1000), remaining_percent: 11, reset_at: newReset })], last_known_rows: [row({ remaining_percent: 23, reset_at: oldReset })] })]));
  const stampJst = new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(Date.parse(oldReset));
  assert.match(text(panel.children[0]), /5h 23% reference/);
  assert.ok(text(panel.children[0]).includes(`参考 ${stampJst} JST`));
});

test('an unreported five-hour window stays unknown even when its age is unavailable', () => {
  const { render } = harness();
  const panel = render(quota([card({provider:'claude',status:'partial',current_rows:[row({status:'not_reported',stale:true,remaining_percent:null,observed_at:null,reset_at:null,fresh_until:null})]})]));
  const window = panel.children[0].children[1].children.find(c=>c.className==='quota-rates').children[0];
  assert.equal(window.className,'quota-window unknown');
  assert.match(text(window),/5h \?.*リセット: 未取得.*観測: 未確認/);
});

const wrow = (over = {}) => row({ period: 'weekly', remaining_percent: 64, reset_at: stamp(86400000), ...over });
const jst = ms => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms);
const compactOf = entry => text(harness().render(quota([entry])).children[0].children.find(c => c.className?.includes('provider-' + entry.provider)));
test('Codex compact card shows weekly only, with the fresh percentage and its original JST times', () => {
  const observed = Date.now() - 5000, collected = Date.now() - 4000;
  const compact = compactOf(card({ collected_at: new Date(collected).toISOString(), current_rows: [row({ remaining_percent: 77 }), wrow({ observed_at: new Date(observed).toISOString() })] }));
  assert.match(compact, /Weekly 64%/); assert.doesNotMatch(compact, /5h/); assert.doesNotMatch(compact, /77%/);
  assert.ok(compact.includes(`観測: ${jst(observed)} JST`)); assert.ok(compact.includes(`取得時刻: ${jst(collected)} JST`));
});
test('Codex card-level acquisition time survives an unavailable weekly value and never promotes last_success', () => {
  const collected = Date.now() - 3000, older = Date.now() - 86400000;
  const unavailable = compactOf(card({ status: 'partial', collected_at: new Date(collected).toISOString(), last_success_collected_at: new Date(older).toISOString(), current_rows: [wrow({ status: 'not_reported', stale: true, remaining_percent: null, observed_at: null, reset_at: null, fresh_until: null })] }));
  assert.ok(unavailable.includes(`取得時刻: ${jst(collected)} JST`)); assert.match(unavailable, /Weekly \? \(未更新\)/); assert.ok(!unavailable.includes(jst(older)));
  const failed = compactOf(card({ status: 'fetch_failed', last_success_collected_at: new Date(older).toISOString(), current_rows: [], last_known_rows: [wrow({ remaining_percent: 31 })] }));
  assert.match(failed, /取得時刻: 未確認/); assert.ok(!failed.includes(jst(older)));
});
test('Codex historical, stale, future, duplicate, failed and unobserved weekly values are never a current, zero or unlimited figure', () => {
  const cases = [card({ current_rows: [], last_known_rows: [wrow({ remaining_percent: 31, used_percent: 69 })] }), card({ current_rows: [wrow({ fresh_until: stamp(-1000) })] }), card({ current_rows: [wrow({ observed_at: stamp(60000) })] }),
    card({ collected_at: stamp(60000), current_rows: [wrow()] }), card({ current_rows: [wrow(), wrow()] }), card({ status: 'fetch_failed', current_rows: [wrow()] }),
    card({ current_rows: [wrow({ observed_at: null })] }), card({ current_rows: [wrow({ reset_at: stamp(-1000) })] }), card({ current_rows: [] })];
  for (const entry of cases) { const compact = compactOf(entry); assert.match(compact, /Weekly \? \(未更新\)/); assert.doesNotMatch(compact, /Weekly \d|31%|64%|unlimited|無制限/); }
  const detail = text(harness().render(quota([cases[0]])).children[1]);
  assert.match(detail, /前回値\(参考\): 69%.*観測: /);
});
test('Claude and Antigravity keep five-hour and weekly windows, shared pools and resets', () => {
  const pools = ['gemini_shared', 'claude_gpt_shared'].flatMap((pool, i) => [row({ shared_pool: pool, remaining_percent: 40 + i }), wrow({ shared_pool: pool, remaining_percent: 20 + i })]);
  const compact = text(harness().render(quota([card({ provider: 'claude', current_rows: [row({ remaining_percent: 12 }), wrow({ remaining_percent: 0 })] }), card({ provider: 'antigravity', current_rows: pools })])).children[0]);
  assert.match(compact, /5h 12%/); assert.match(compact, /Weekly 0%/);
  assert.match(compact, /Gemini shared.*5h 40%.*Weekly 20%/); assert.match(compact, /Claude \/ GPT shared.*5h 41%.*Weekly 21%/);
  assert.equal((compact.match(/あと/g) ?? []).length, 6); assert.match(compact, /JST/);
});
test('Antigravity keeps the observation-to-collection fallback', () => {
  const collected = Date.now() - 2000;
  const compact = compactOf(card({ provider: 'antigravity', collected_at: new Date(collected).toISOString(), current_rows: [row({ shared_pool: 'gemini_shared', observed_at: null, remaining_percent: 33 })] }));
  assert.ok(compact.includes(`収集: ${jst(collected)} JST`)); assert.match(compact, /5h 33%/);
});
