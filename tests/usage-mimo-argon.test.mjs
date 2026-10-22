// Synthetic values only. Covers the TASK-17 next stage: MiMo reference retention, Argon weekly window, currency handling.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {sanitizeUsage} from '../scripts/usage-metadata.mjs';

const iso = ms => new Date(ms).toISOString();
const T0 = Date.parse('2025-01-01T12:00:00Z');
const code = readFileSync(new URL('../scripts/usage-display.js', import.meta.url), 'utf8');

const argon = (over = {}) => ({limit_id: 'gemini_4_argon_weekly', percent: 95, percent_basis: 'remaining', observed_at: iso(T0), reset_in_seconds: 4 * 86400, ...over});
const row = (family, period, remaining, pool, now = T0) => ({model_family: family, quota_scope: 'antigravity_shared', period, window_id: 'secondary', status: 'available', remaining_percent: remaining, used_percent: 100 - remaining, reset_at: iso(now + (period === 'five_hour' ? 14400000 : 400000000)), observed_at: iso(now), shared_pool: pool});
const ag = (over = {}, now = T0) => ({provider: 'antigravity', status: 'available', account_alignment: 'verified', collected_at: iso(now), last_success_collected_at: iso(now), stale_after_seconds: 3600,
  current_rows: [row('gemini', 'five_hour', 61.1, 'gemini_shared', now), row('claude', 'five_hour', 60, 'claude_gpt_shared', now)], last_known_rows: [], ...over});
const mimo = (over = {}, now = T0) => ({provider: 'mimo', status: 'available', account_alignment: 'verified', collected_at: iso(now), last_success_collected_at: iso(now), stale_after_seconds: 3600,
  balance: {amount: 12.34, currency: 'USD', observed_at: iso(now)}, last_known_balance: null, ...over});
const input = (cards, now = T0) => ({display_schema_version: 1, view_read_at: iso(now), cards});
const agCard = (dto) => dto.cards.find(card => card.provider === 'antigravity');

test('Argon weekly: percent basis is explicit, kept apart from Gemini shared rows, never derived from 5h', () => {
  const remaining = agCard(sanitizeUsage(input([ag({argon_weekly: argon()})]), T0));
  assert.equal(remaining.argon_weekly.remaining_percent, 95);
  assert.equal(remaining.argon_weekly.used_percent, 5);
  assert.equal(remaining.argon_weekly.status, 'available');
  // The Gemini shared weekly window and its 5h value are untouched by the Argon number.
  assert.equal(remaining.current_rows.some(item => item.period === 'weekly'), false);
  assert.equal(remaining.reset_windows.find(item => item.shared_pool === 'gemini_shared' && item.period === 'weekly').state, 'missing');
  assert.equal(remaining.current_rows.find(item => item.shared_pool === 'gemini_shared').remaining_percent, 61.1);
  // A used-percent basis is converted, not mistaken for remaining.
  const used = agCard(sanitizeUsage(input([ag({argon_weekly: argon({percent_basis: 'used'})})]), T0));
  assert.equal(used.argon_weekly.remaining_percent, 5);
  assert.equal(used.argon_weekly.used_percent, 95);
  // Unknown basis, wrong limit id, out-of-range or non-numeric values yield no number at all.
  assert.equal(agCard(sanitizeUsage(input([ag({argon_weekly: argon({percent_basis: undefined})})]), T0)).argon_weekly.status, 'basis_unconfirmed');
  assert.equal(agCard(sanitizeUsage(input([ag({argon_weekly: argon({percent_basis: undefined})})]), T0)).argon_weekly.remaining_percent, null);
  assert.equal(agCard(sanitizeUsage(input([ag({argon_weekly: argon({limit_id: 'gemini_shared_weekly'})})]), T0)).argon_weekly, null);
  for (const bad of [101, -1, '95', NaN]) assert.equal(agCard(sanitizeUsage(input([ag({argon_weekly: argon({percent: bad})})]), T0)).argon_weekly.remaining_percent, null);
  // No input: explicitly absent (unconfirmed), not zero.
  assert.equal(agCard(sanitizeUsage(input([ag()]), T0)).argon_weekly, null);
  // Only the antigravity card can carry it.
  const other = sanitizeUsage(input([{provider: 'codex', status: 'available', account_alignment: 'verified', collected_at: iso(T0), argon_weekly: argon(), current_rows: [], last_known_rows: []}]), T0);
  assert.equal('argon_weekly' in other.cards[0], false);
});

test('Argon weekly: relative reset is an approximate, precision-unconfirmed hint (no reset time, no deadline); stale, reset-passed and mismatch are never current', () => {
  const dto = agCard(sanitizeUsage(input([ag({argon_weekly: argon()})]), T0)).argon_weekly;
  assert.equal(dto.reset_approximate, true);
  assert.equal(dto.reset_precision, 'unconfirmed');
  assert.equal(dto.reset_relative_seconds, 4 * 86400);
  assert.equal(dto.reset_at, null, 'no confirmed reset time is derived from a relative value');
  assert.equal(dto.reset_passed, false);
  assert.equal(dto.reset_invalid, false);
  assert.equal('reset_uncertainty_seconds' in dto, false, 'no unfounded error bound');
  assert.equal(dto.status, 'available');
  // The relative value never decides expiry: it is stale by TTL only, not by a computed deadline.
  assert.equal(agCard(sanitizeUsage(input([ag({argon_weekly: argon({reset_in_seconds: 60})})]), T0 + 3000000)).argon_weekly.status, 'available');
  assert.equal(dto.observed_at, iso(T0));
  // A relative reset without an observation time cannot be anchored to anything: not current.
  const unanchored = agCard(sanitizeUsage(input([ag({argon_weekly: argon({observed_at: null})})]), T0)).argon_weekly;
  assert.equal(unanchored.remaining_percent, null);
  // Absolute reset wins and is not marked estimated.
  const absolute = agCard(sanitizeUsage(input([ag({argon_weekly: argon({reset_in_seconds: undefined, reset_at: iso(T0 + 3 * 86400000)})})]), T0)).argon_weekly;
  assert.equal(absolute.reset_approximate, false);
  assert.equal(absolute.reset_precision, 'absolute');
  assert.equal(absolute.reset_at, iso(T0 + 3 * 86400000));
  // TTL and reset pass: the stored number is not promoted to current; history is kept only in last_known.
  const later = agCard(sanitizeUsage(input([ag({argon_weekly: argon(), last_known_argon_weekly: argon({observed_at: iso(T0 - 7200000), reset_in_seconds: 5 * 86400}), last_success_collected_at: iso(T0 - 7200000)})]), T0 + 3601000));
  assert.equal(later.argon_weekly.remaining_percent, null);
  assert.equal(later.last_known_argon_weekly.remaining_percent, 95);
  assert.equal(later.last_known_argon_weekly.status, 'last_known');
  const passed = agCard(sanitizeUsage(input([ag({argon_weekly: argon({reset_in_seconds: undefined, reset_at: iso(T0 - 1)})})]), T0)).argon_weekly;
  assert.equal(passed.remaining_percent, null);
  assert.equal(passed.reset_passed, true);
  const mismatch = agCard(sanitizeUsage(input([ag({account_alignment: 'mismatch', argon_weekly: argon(), last_known_argon_weekly: argon()})]), T0));
  assert.equal(mismatch.argon_weekly.remaining_percent, null);
  assert.equal(mismatch.last_known_argon_weekly.remaining_percent, null);
  const failed = agCard(sanitizeUsage(input([ag({status: 'fetch_failed', argon_weekly: argon()})]), T0));
  assert.equal(failed.argon_weekly.remaining_percent, null);
});

// ---- fake-DOM display harness with a controllable clock and fetch ----
class Element {
  constructor(tag) {this.tag = tag; this.children = []; this.textContent = ''; this.style = {};}
  setAttribute(key, value) {this[key] = value;}
  append(...items) {this.children.push(...items);}
  prepend(item) {this.children.unshift(item);}
  replaceChildren(...items) {this.children = items;}
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');
async function display(initialDto, startNow = T0) {
  let now = startNow, dto = initialDto, offline = false;
  class Clock extends Date {static now() {return now;}}
  const body = new Element('body'), intervals = new Map();
  const context = {Date: Clock, document: {readyState: 'complete', body, createElement: tag => new Element(tag)},
    fetch: async () => {if (offline) throw new Error('offline'); return {ok: true, json: async () => dto};}, setInterval: (fn, delay) => intervals.set(delay, fn)};
  runInNewContext(code, context);
  await new Promise(setImmediate);
  const view = {
    summary: () => body.children[0].children.find(item => item.tag === 'div'),
    card: index => text(view.summary().children[index]),
    all: () => text(body),
    tick: ms => {now += ms; intervals.get(1000)();},
    refresh: async () => {await intervals.get(30000)(); await new Promise(setImmediate);},
    set: value => {dto = value;},
    offline: value => {offline = value;},
    setNow: value => {now = value;}
  };
  return view;
}
const MIMO = 2; // AG Gemini, AG Claude/GPT, MiMo (fixtures have no Codex/Claude card)
const fixture = (cards, now = T0) => sanitizeUsage(input(cards, now), now);

test('Display: Argon weekly is its own entry next to the 5h value; absent input stays unconfirmed; clock advance demotes it to reference', async () => {
  const view = await display(fixture([ag({argon_weekly: argon()}), mimo()]));
  const gemini = view.card(0);
  assert.match(gemini, /5h 61\.1%/);
  assert.match(gemini, /Argon週 95%/);
  assert.doesNotMatch(gemini, /週 95%[^A]*参考/);
  assert.match(view.all(), /Gemini 4 Argon 週間（共有枠とは別）：残り95%（使用5%）/);
  assert.match(view.all(), /概算・精度未確認/);
  assert.match(view.all(), /確定時刻なし/);
  assert.match(view.all(), /Argon reset：約4日後と表示（概算・精度未確認）\s*／ 観測 [^／]*／ 確定時刻なし/, 'approximate hint only: no countdown, no deadline');
  // Static DTO, advancing clock past the TTL: still shown, but only as a reference.
  view.tick(3601000);
  assert.match(view.card(0), /Argon週 95% 参考/);
  assert.doesNotMatch(view.all(), /残り95%（使用5%）/);
  // Past the (earliest) reset: remains a reference and says re-fetch pending.
  view.tick(5 * 86400000);
  assert.match(view.all(), /再取得確認待ち|古い取得値/);
  const none = await display(fixture([ag(), mimo()]));
  assert.match(none.card(0), /Argon週 —（未確認）/);
  assert.match(none.all(), /入力なし（未確認）/);
  assert.doesNotMatch(none.card(0), /Argon週 \d/);
  const unknownBasis = await display(fixture([ag({argon_weekly: argon({percent_basis: undefined})}), mimo()]));
  assert.match(unknownBasis.card(0), /Argon週 —/);
  assert.match(unknownBasis.all(), /残率\/使用率の別が未確認/);
});

test('Display: MiMo keeps the last shown balance as a reference on communication failure, with the original time, and recovers', async () => {
  const view = await display(fixture([ag(), mimo()]));
  assert.match(view.card(MIMO), /USD 12\.34/);
  assert.doesNotMatch(view.card(MIMO), /前回参考/);
  const originalTime = /取得 (\d{2}:\d{2})/.exec(view.card(MIMO))?.[1];
  assert.ok(originalTime);
  // The card alone shows it is no longer current (not only the panel-wide banner), and the time does not move.
  view.offline(true); await view.refresh();
  assert.match(view.card(MIMO), /USD 12\.34 前回参考/);
  assert.match(view.card(MIMO), /更新失敗/);
  assert.ok(view.card(MIMO).includes(originalTime), 'reference keeps the real acquisition time');
  const before = view.card(MIMO);
  view.tick(600000); view.tick(600000);
  assert.match(view.card(MIMO), /USD 12\.34 前回参考/);
  assert.ok(view.card(MIMO).includes(originalTime), 'rendering later does not become the acquisition time');
  assert.match(view.all(), /更新失敗・前回値を表示中/);
  assert.equal(before.includes('取得 '), false, 'a reference is not labelled as a current acquisition');
  // Recovery with a newer collection returns to a current display with the new time.
  const later = T0 + 1200000;
  view.offline(false); view.set(fixture([ag({}, later), mimo({}, later)], later)); view.setNow(later); await view.refresh();
  assert.match(view.card(MIMO), /USD 12\.34/);
  assert.doesNotMatch(view.card(MIMO), /前回参考/);
  assert.doesNotMatch(view.all(), /更新失敗・前回値を表示中/);
});

test('Display: MiMo failure without server history, unknown currency, debt, micro amounts and account mismatch', async () => {
  // Server reports the fetch failed and has no last_known_balance: the previously shown amount must survive.
  const view = await display(fixture([ag(), mimo()]));
  view.set(fixture([ag(), mimo({status: 'fetch_failed', error_kind: 'timeout', balance: null, last_known_balance: null, collected_at: null})]));
  await view.refresh();
  assert.match(view.card(2), /USD 12\.34 前回参考/);
  // No prior value at all: failure, never zero.
  const cold = await display(fixture([ag(), mimo({status: 'fetch_failed', balance: null, collected_at: null})]));
  assert.match(cold.card(2), /取得失敗/);
  assert.doesNotMatch(cold.card(2), /0\.00/);
  // Unrecognised currency: amount kept as a reference, labelled, string never echoed.
  const unknown = await display(fixture([ag(), mimo({balance: {amount: 12.34, currency: 'ZZZ', observed_at: iso(T0)}})]));
  assert.match(unknown.card(2), /12\.34 通貨未確認/);
  assert.doesNotMatch(unknown.all(), /ZZZ/);
  assert.doesNotMatch(unknown.card(2), /USD/);
  // Debt and sub-cent amounts; zero is a real balance.
  assert.match((await display(fixture([ag(), mimo({balance: {amount: -3.5, currency: 'USD', observed_at: iso(T0)}})]))).card(2), /USD -3\.50（残高不足）/);
  assert.match((await display(fixture([ag(), mimo({balance: {amount: -0.004, currency: 'USD', observed_at: iso(T0)}})]))).card(2), /USD > -0\.01（残高不足）/);
  assert.match((await display(fixture([ag(), mimo({balance: {amount: 0.004, currency: 'USD', observed_at: iso(T0)}})]))).card(2), /USD < 0\.01/);
  assert.match((await display(fixture([ag(), mimo({balance: {amount: 0, currency: 'USD', observed_at: iso(T0)}})]))).card(2), /USD 0\.00/);
  // A different account: the earlier balance is dropped and is not resurrected by a later failure.
  const mismatch = await display(fixture([ag(), mimo()]));
  mismatch.set(fixture([ag(), mimo({account_alignment: 'mismatch'})])); await mismatch.refresh();
  assert.match(mismatch.card(2), /アカウント不一致/);
  assert.doesNotMatch(mismatch.card(2), /12\.34/);
  mismatch.offline(true); await mismatch.refresh();
  assert.doesNotMatch(mismatch.card(2), /12\.34/);
  assert.match(mismatch.card(2), /アカウント不一致/);
});

test('Sanitizer: MiMo money never mixes with percent windows, and an unrecognised currency is nulled but the amount is retained', () => {
  const card = sanitizeUsage(input([mimo({balance: {amount: 7.5, currency: 'usd ', observed_at: iso(T0)}}), mimo({balance: {amount: 1, currency: 'USD', observed_at: iso(T0)}})]), T0).cards;
  assert.equal(card.length, 1);
  assert.equal(card[0].balance.currency, null, 'non-canonical currency strings are not guessed');
  assert.equal(card[0].balance.amount, 7.5);
  assert.equal(card[0].balance.currency_verified, false);
  assert.equal(card[0].current_rows[0].metric_kind, 'money');
  assert.equal('remaining_percent' in card[0].current_rows[0], false);
});

test('Regression: huge or malformed reset_in_seconds drops only the Argon entry; the payload and other cards survive', async () => {
  const cards = extra => [{provider: 'codex', status: 'available', account_alignment: 'verified', collected_at: iso(T0), last_success_collected_at: iso(T0), stale_after_seconds: 3600,
    current_rows: [{model_family: 'codex', quota_scope: 'own_subscription', period: 'five_hour', window_id: 'five_hour', status: 'available', remaining_percent: 61, used_percent: 39, reset_at: iso(T0 + 14400000), observed_at: iso(T0)}], last_known_rows: []},
    ag(extra), mimo()];
  for (const bad of [1e308, Number.MAX_VALUE, 1e20, 1e12, 904800, 904801, 8.64e15, -5, 0, '345600', NaN, true, {}, []]) {
    for (const key of ['argon_weekly', 'last_known_argon_weekly']) {
      let dto;
      assert.doesNotThrow(() => {dto = sanitizeUsage(input(cards({[key]: argon({reset_in_seconds: bad})})), T0);}, `reset_in_seconds=${String(bad)} in ${key}`);
      assert.equal(dto.cards.length, 3, 'all cards remain');
      assert.equal(dto.cards.find(card => card.provider === 'codex').current_rows[0].remaining_percent, 61);
      assert.equal(dto.cards.find(card => card.provider === 'mimo').balance.amount, 12.34);
      const gemini = agCard(dto);
      assert.equal(gemini[key], null, `Argon entry is missing (not guessed) for ${String(bad)}`);
      assert.equal(gemini.current_rows.find(row => row.shared_pool === 'gemini_shared').remaining_percent, 61.1, 'Gemini shared value is untouched');
    }
  }
  // The largest accepted relative value still works; anything above it is rejected.
  assert.equal(agCard(sanitizeUsage(input(cards({argon_weekly: argon({reset_in_seconds: 605100})})), T0)).argon_weekly.status, 'available');
  assert.equal(agCard(sanitizeUsage(input(cards({argon_weekly: argon({reset_in_seconds: 605100.5})})), T0)).argon_weekly, null);
  // Through the display: a malformed Argon item shows as unconfirmed while every other card still renders.
  const view = await display(sanitizeUsage(input(cards({argon_weekly: argon({reset_in_seconds: 1e308})})), T0));
  assert.match(view.all(), /Argon週 —（未確認）/);
  assert.match(view.all(), /5h 61%/);
  assert.match(view.all(), /USD 12\.34/);
});

test('Regression: the loopback usage API stays 200 with a huge reset_in_seconds in the private file', async () => {
  const {createServer} = await import('node:http');
  const {mkdtempSync, writeFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {createDisplayProxy} = await import('../scripts/status-display-proxy.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'argon-huge-')), file = path.join(dir, 'usage.json');
  const now = Date.now();
  writeFileSync(file, JSON.stringify(input([ag({argon_weekly: argon({observed_at: iso(now), reset_in_seconds: 1e308})}, now), mimo({}, now)], now)));
  assert.match(readFileSync(file, 'utf8'), /"reset_in_seconds":1e\+?308/, 'the private file really holds the huge finite value');
  const upstream = createServer((req, res) => res.end('x'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createDisplayProxy(upstream.address().port, {usageFile: file});
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/__dashboard/usage`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.cards.map(card => card.provider), ['antigravity', 'mimo']);
    assert.equal(body.cards[0].argon_weekly, null);
    assert.equal(body.cards[1].balance.amount, 12.34);
  } finally {
    await new Promise(resolve => {proxy.close(resolve); proxy.closeAllConnections?.();});
    await new Promise(resolve => {upstream.close(resolve); upstream.closeAllConnections?.();});
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(dir, {recursive: true, force: true});
  }
});
