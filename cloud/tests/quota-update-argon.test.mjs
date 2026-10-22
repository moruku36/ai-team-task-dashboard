import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { app, FixtureStore, env } from './fixtures.mjs';
import { sanitizeUsage } from '../usage-metadata.mjs';
import { projectUsage } from '../usage-project.mjs';

// Synthetic data only. NOW is fixed so freshness is deterministic.
const NOW = new Date('2030-01-01T12:00:00.000Z'), T = ms => new Date(NOW.getTime() - ms).toISOString(), AFTER = ms => new Date(NOW.getTime() + ms).toISOString();
const row = (over = {}) => ({ quota_scope: 'antigravity_shared', model_family: 'gemini', period: 'weekly', shared_pool: 'gemini_shared', window_id: 'g0_b0', observed_at: null, reset_at: AFTER(3 * 86400000),
  status: 'available', used_percent: 25, remaining_percent: 75, ...over });
const argon = (over = {}) => ({ limit_id: 'gemini_4_argon_weekly', percent: 61.5, percent_basis: 'remaining', observed_at: null, reset_at: AFTER(4 * 86400000), ...over });
const agCard = (over = {}) => ({ provider: 'antigravity', title: 'SECRET_TITLE', status: 'partial', acquisition_source: 'official_cli', error_kind: null, http_status: 200, collected_at: T(120000),
  last_success_collected_at: T(120000), stale_after_seconds: 3600, account_alignment: 'not_verified', current_rows: [row(), row({ period: 'five_hour', window_id: 'g0_b1', reset_at: AFTER(3600000) })],
  last_known_rows: [], argon_weekly: argon(), last_known_argon_weekly: null, token: 'SECRET_TOKEN_SENTINEL', model_references: [], ...over });
const codexCard = (over = {}) => ({ provider: 'codex', status: 'partial', acquisition_source: 'official_cli', error_kind: null, collected_at: T(120000), last_success_collected_at: T(120000), stale_after_seconds: 3600,
  account_alignment: 'not_verified', current_rows: [{ quota_scope: 'own_subscription', model_family: 'codex', period: 'weekly', shared_pool: null, window_id: 'secondary', observed_at: T(130000), reset_at: AFTER(5 * 86400000), status: 'available', used_percent: 10, remaining_percent: 90 }], last_known_rows: [], ...over });
const usage = (...cards) => ({ display_schema_version: 1, view_read_at: T(100000), cards });
const ag = (input, now = NOW.getTime()) => sanitizeUsage(input, now).cards.find(c => c.provider === 'antigravity');

test('sanitizer: Argon is its own weekly window (normal, 0%, used basis, missing, stale, invalid) and never leaks into Gemini shared', () => {
  const normal = ag(usage(agCard()));
  assert.equal(normal.argon_weekly.status, 'available'); assert.equal(normal.argon_weekly.remaining_percent, 61.5); assert.equal(normal.argon_weekly.used_percent, 38.5);
  assert.ok(normal.current_rows.every(r => r.remaining_percent !== 61.5), 'shared rows untouched');
  assert.equal(ag(usage(agCard({ argon_weekly: argon({ percent: 0 }) }))).argon_weekly.remaining_percent, 0, '0% is a value, not missing');
  assert.equal(ag(usage(agCard({ argon_weekly: argon({ percent: 30, percent_basis: 'used' }) }))).argon_weekly.remaining_percent, 70);
  assert.equal(ag(usage(agCard({ argon_weekly: undefined }))).argon_weekly, null, 'missing stays missing');
  for (const bad of [{ percent: 101 }, { percent: -1 }, { percent: '44' }, { percent: Number.NaN }, { percent_basis: 'bogus' }, { percent_basis: undefined }]) {
    const out = ag(usage(agCard({ argon_weekly: argon(bad) }))).argon_weekly;
    assert.equal(out.remaining_percent, null, JSON.stringify(bad)); assert.notEqual(out.status, 'available');
  }
  for (const bad of [{ reset_in_seconds: -5, reset_at: undefined }, { reset_in_seconds: 9e9, reset_at: undefined }, { reset_in_seconds: 'x', reset_at: undefined }, { limit_id: 'gemini_shared' }])
    assert.equal(ag(usage(agCard({ argon_weekly: argon(bad) }))).argon_weekly, null, JSON.stringify(bad));
  const stale = ag(usage(agCard({ collected_at: T(2 * 3600000), last_success_collected_at: T(2 * 3600000), last_known_argon_weekly: argon({ percent: 50 }) }))).argon_weekly;
  assert.equal(stale.status, 'unavailable'); assert.equal(stale.remaining_percent, null);
  assert.equal(ag(usage(agCard({ account_alignment: 'mismatch' }))).argon_weekly.remaining_percent, null);
  assert.equal(ag(usage(agCard({ collected_at: AFTER(60000) }))).argon_weekly.remaining_percent, null, 'future collection time is never current');
});

test('sanitizer: disabled rows are distinct from failed, missing and 0%; failure is never current', () => {
  const card = ag(usage(agCard({ current_rows: [row({ model_family: 'claude', shared_pool: 'claude_gpt_shared', window_id: 'g1_b1', period: 'five_hour', status: 'disabled', used_percent: null, remaining_percent: null, reset_at: null }),
    row({ remaining_percent: 0, used_percent: 100 })] })));
  assert.equal(card.current_rows.find(r => r.period === 'five_hour').status, 'disabled');
  assert.equal(card.reset_windows.find(w => w.shared_pool === 'claude_gpt_shared' && w.period === 'five_hour').state, 'disabled');
  assert.equal(card.current_rows.find(r => r.period === 'weekly').remaining_percent, 0);
  const failed = ag(usage(agCard({ status: 'fetch_failed', error_kind: 'timeout' })));
  assert.ok(failed.current_rows.every(r => r.status !== 'available') && failed.argon_weekly.remaining_percent === null);
});

test('projection keeps only allowlisted fields (no titles, tokens, nested objects, paths)', () => {
  const projected = projectUsage(usage(agCard({ debug: { path: 'C:/Users/x/secret.json' }, raw_log: 'SECRET_LOG_SENTINEL' }), codexCard()));
  const text = JSON.stringify(projected);
  for (const sentinel of ['SECRET_TITLE', 'SECRET_TOKEN_SENTINEL', 'SECRET_LOG_SENTINEL', 'secret.json', 'http_status']) assert.equal(text.includes(sentinel), false, sentinel);
  assert.equal(projected.cards.length, 2); assert.equal(projected.cards[0].argon_weekly.percent, 61.5);
  assert.throws(() => projectUsage({ display_schema_version: 2, cards: [] })); assert.throws(() => projectUsage(null));
});

const quotaApp = async () => {
  const store = new FixtureStore();
  const a = await app(store, { quotaStore: { read: async () => (await store.read()).quota ?? { records: [] } }, now: () => NOW });
  const send = (payload, headers = {}) => fetch(a.url + '/api/quota', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1', Origin: env.DASHBOARD_ORIGIN, ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { ...a, store, send };
};
const body = (requestId, u) => ({ requestId, usage: u });

test('POST /api/quota: owner-only validated replace; duplicate-safe; never rolls back; receipt time kept apart from collection time', async t => {
  const a = await quotaApp(); t.after(() => a.close());
  const first = usage(agCard(), codexCard());
  assert.equal((await a.send(body('upd-request-1', first))).status, 200);
  const read = await (await a.get('/api/quota')).json();
  const card = read.usage.cards.find(c => c.provider === 'antigravity');
  assert.equal(card.argon_weekly.remaining_percent, 61.5); assert.equal(card.collected_at, T(120000));
  assert.equal(JSON.stringify(read).includes('SECRET_TOKEN_SENTINEL'), false);
  const stored = (await a.store.read()).quota; assert.equal(stored.usageUpdate.receivedAt, NOW.toISOString()); assert.notEqual(stored.usageUpdate.receivedAt, card.collected_at);
  const again = await a.send(body('upd-request-1', first)); assert.equal(again.status, 200); assert.equal((await again.json()).duplicate, true);
  assert.equal((await a.send(body('upd-request-1', usage(agCard({ collected_at: T(60000) }))))).status, 409);
  assert.equal((await a.send(body('upd-request-2', usage(agCard({ collected_at: T(900000), last_success_collected_at: T(900000) }))))).status, 409);
  assert.equal((await a.send(body('upd-request-3', usage(agCard({ collected_at: null }))))).status, 409);
  const newer = agCard({ collected_at: T(30000), last_success_collected_at: T(30000), argon_weekly: argon({ percent: 0 }) });
  assert.equal((await a.send(body('upd-request-4', usage(newer)))).status, 200);
  const after = (await (await a.get('/api/quota')).json()).usage.cards;
  assert.equal(after.find(c => c.provider === 'antigravity').argon_weekly.remaining_percent, 0); assert.ok(after.find(c => c.provider === 'codex'), 'providers not in the upload are kept');
  assert.equal((await a.send(body('upd-request-5', usage(agCard({ status: 'fetch_failed', error_kind: 'timeout', collected_at: T(10000), last_success_collected_at: T(30000), current_rows: [], argon_weekly: null }))))).status, 200);
  const failed = (await (await a.get('/api/quota')).json()).usage.cards.find(c => c.provider === 'antigravity');
  assert.equal(failed.status, 'fetch_failed'); assert.equal(failed.last_success_collected_at, T(30000)); assert.equal(failed.argon_weekly, null);
  assert.equal((await (await a.get('/api/tasks')).json()).revision, 0, 'tasks untouched');
});

test('POST /api/quota: bad input is rejected without storing anything', async t => {
  const a = await quotaApp(); t.after(() => a.close());
  const cases = [[body('short', usage(agCard())), 400], [{ requestId: 'valid-request-id', usage: { display_schema_version: 9, cards: [] } }, 400], [{ requestId: 'valid-request-id', usage: usage() }, 400],
    [{ requestId: 'valid-request-id', usage: usage(agCard()), extra: 1 }, 400], ['not json', 400], [{ requestId: '__proto__', usage: usage(agCard()) }, 400]];
  for (const [payload, status] of cases) assert.equal((await a.send(payload)).status, status, JSON.stringify(payload).slice(0, 60));
  assert.equal((await a.send(body('valid-request-id', usage(agCard())), { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await fetch(a.url + '/api/quota', { method: 'POST', headers: { Origin: env.DASHBOARD_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body('valid-request-id', usage(agCard()))) })).status, 403, 'write header required');
  assert.equal((await a.send('x'.repeat(100001))).status, 413);
  assert.equal((await a.store.read()).quota, undefined, 'nothing was stored');
});

class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; this.attributes = {}; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } setAttribute(k, v) { this.attributes[k] = v; } showModal() {} addEventListener() {}
}
const text = e => [e.textContent, ...e.children.map(text)].join(' ');
const find = (e, pred) => (pred(e) ? [e] : []).concat(...e.children.map(c => find(c, pred)));

test('UI: Argon box is separate from Gemini shared; shows %, 0%, unknown, reference, disabled and acquisition time', async t => {
  const a = await quotaApp(); t.after(() => a.close());
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const RealDate = Date, FixedDate = class extends RealDate { constructor(...x) { super(...(x.length ? x : [NOW.getTime()])); } static now() { return NOW.getTime(); } };
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {}, Intl, Date: FixedDate,
    fetch: (path, options) => fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: env.DASHBOARD_ORIGIN } }) });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const show = async u => { assert.equal((await a.send(body(randomUUID(), u))).status, 200); await runInContext('refreshQuota()', context); return text(el('quota')); };
  let page = await show(usage(agCard({ collected_at: T(60000), last_success_collected_at: T(60000), argon_weekly: argon({ percent: 61.5 }) })));
  const box = find(el('quota'), n => n.attributes?.['data-limit'] === 'gemini_4_argon_weekly'); assert.equal(box.length, 1);
  assert.match(text(box[0]), /Argon Weekly 61\.5%/); assert.match(text(box[0]), /取得: .*JST/); assert.match(page, /Gemini 4 Argon（共有枠とは別）/);
  assert.match(page, /Weekly 75%/, 'Gemini shared value is shown separately');
  page = await show(usage(agCard({ collected_at: T(50000), last_success_collected_at: T(50000), argon_weekly: argon({ percent: 0 }) }))); assert.match(page, /Argon Weekly 0%/);
  page = await show(usage(agCard({ collected_at: T(40000), last_success_collected_at: T(40000), argon_weekly: undefined }))); assert.match(page, /Argon Weekly 不明/);
  page = await show(usage(agCard({ collected_at: T(30000), last_success_collected_at: T(30000), argon_weekly: argon({ percent: 'abc' }) }))); assert.match(page, /Argon Weekly 不明/);
  page = await show(usage(agCard({ collected_at: T(25000), last_success_collected_at: T(25000), argon_weekly: argon({ percent: 120 }) }))); assert.match(page, /Argon Weekly 不明/);
  page = await show(usage(agCard({ collected_at: T(20000), last_success_collected_at: T(20000), argon_weekly: null, last_known_argon_weekly: argon({ percent: 44.79 }), status: 'fetch_failed', error_kind: 'timeout' })));
  assert.match(page, /Argon Weekly 44\.8% 参考/); assert.match(page, /参考\(前回成功\)/);
  page = await show(usage(agCard({ collected_at: T(10000), last_success_collected_at: T(10000), current_rows: [row({ model_family: 'claude', shared_pool: 'claude_gpt_shared', window_id: 'g1_b1', period: 'five_hour', status: 'disabled', used_percent: null, remaining_percent: null, reset_at: null })] })));
  assert.match(page, /5h 無効/); assert.match(page, /アカウント照合: 未確認/);
  // owner upload control: sends one validated request; an older file is refused and the saved value stays
  const file = u => ({ size: 5000, text: async () => JSON.stringify(u) });
  el('quotaFile').files = [file(usage(agCard({ collected_at: T(5000), last_success_collected_at: T(5000), argon_weekly: argon({ percent: 12.5 }) })))];
  await el('quotaSend').onclick();
  assert.match(el('quotaImportNotice').textContent, /取り込みました/); assert.match(text(el('quota')), /Argon Weekly 12\.5%/);
  el('quotaFile').files = [file(usage(agCard({ collected_at: T(500000), last_success_collected_at: T(500000), argon_weekly: argon({ percent: 99 }) })))];
  await el('quotaSend').onclick();
  assert.match(el('quotaImportNotice').textContent, /中止/); assert.match(text(el('quota')), /Argon Weekly 12\.5%/);
  el('quotaFile').files = [{ size: 200000, text: async () => '{}' }]; await el('quotaSend').onclick(); assert.match(el('quotaImportNotice').textContent, /大きすぎ/);
});
