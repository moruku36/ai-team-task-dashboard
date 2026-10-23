import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { publicQuota } from '../quota.mjs';

// Synthetic data only; no server, no network. The fake fetch hands out responses the test resolves in a chosen order.
class Element { constructor() { this.children = []; this.textContent = ''; this.value = ''; } append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } showModal() {} addEventListener() {} }
const text = n => [n.textContent, ...(n.children ?? []).map(text)].join(' ');
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const record = (collectedMinutesAgo, used) => ({ provider: 'codex', source: 'native', state: 'ok', usedPercent: used, observedAt: ago(collectedMinutesAgo), collectedAt: ago(collectedMinutesAgo), lastSuccessAt: ago(collectedMinutesAgo),
  resetAt: new Date(Date.now() + 3600000).toISOString(), collector: { status: 'online', heartbeatAt: ago(0.1) } });
const payload = async (collectedMinutesAgo, used, servedAt = new Date()) => JSON.parse(JSON.stringify(await publicQuota({ read: async () => ({ records: [record(collectedMinutesAgo, used)] }) }, servedAt)));
async function boot() {
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, pending = [];
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {}, Intl,
    fetch: path => !String(path).includes('/api/quota') ? new Promise(() => {}) : new Promise((resolve, reject) => pending.push({ ok: body => resolve({ ok: true, json: async () => body }), fail: () => reject(new Error('synthetic offline')) })) });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const initial = pending.length; // app.js starts its own first quota read at load; it is left unresolved and is superseded by the first read below
  return { el, pending: new Proxy(pending, { get: (list, key) => /^\d+$/.test(key) ? list[initial + Number(key)] : list[key] }), context, shown: () => text(el('quota')), start: () => runInContext('refreshQuota()', context) };
}

test('a slow earlier response that finishes after a newer one never replaces it', async () => {
  const h = await boot();
  const first = h.start(), second = h.start();          // two overlapping reads (e.g. tab return + manual refresh)
  h.pending[1].ok(await payload(1, 30)); await second;   // newer read completes first
  assert.match(h.shown(), /30/); const afterNewer = h.shown();
  h.pending[0].ok(await payload(9, 70)); await first;    // the older read arrives late with older data
  assert.equal(h.shown(), afterNewer, 'the late response is ignored');
});

test('a response with an older collection time than what is shown is ignored, a newer one is accepted', async () => {
  const h = await boot();
  let p = h.start(); h.pending[0].ok(await payload(2, 40)); await p; const shown = h.shown();
  p = h.start(); h.pending[1].ok(await payload(8, 90)); await p;   // sequential, but collected earlier than the displayed one
  assert.equal(h.shown(), shown, 'older collected_at (a stale replica) does not roll the view back');
  p = h.start(); h.pending[2].ok(await payload(0.5, 20)); await p;
  assert.notEqual(h.shown(), shown, 'newer collection time replaces the view');
});

test('failure behaviour is unchanged (shown as unknown, never as current) and a late failure from a superseded read is ignored', async () => {
  const h = await boot();
  const first = h.start(), second = h.start();
  h.pending[1].ok(await payload(1, 30)); await second; const good = h.shown();
  h.pending[0].fail(); await first;
  assert.equal(h.shown(), good, 'a superseded read failing late does not wipe the newer good view');
  const third = h.start(); h.pending[2].fail(); await third;
  assert.match(h.shown(), /取得できません/); assert.doesNotMatch(h.shown(), /最新|Codex/);
  const fourth = h.start(); h.pending[3].ok(await payload(8, 90)); await fourth;
  assert.match(h.shown(), /Codex/, 'after a failure there is nothing to roll back to, so a valid older response is shown (not as a newer one)');
});
