import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuotaFreshness as evaluate, FRESHNESS } from '../quota-freshness.mjs';
// Synthetic fixtures only.
const NOW = '2030-01-01T12:00:00.000Z';
const online = { status: 'online', heartbeatAt: '2030-01-01T11:59:30.000Z' };
const base = { collectedAt: '2030-01-01T11:55:00.000Z', lastSuccessAt: '2030-01-01T11:55:00.000Z', resetAt: '2030-01-01T18:00:00.000Z', collector: online };
test('recent collection with online collector is current', () => {
  const r = evaluate(base, { now: NOW });
  assert.equal(r.freshness, FRESHNESS.current); assert.deepEqual(r.reasons, []);
});
test('served time never overwrites collection, last-success or reset', () => {
  const r = evaluate(base, { now: NOW });
  assert.equal(r.servedAt, NOW);
  assert.equal(r.collectedAt, base.collectedAt); assert.equal(r.lastSuccessAt, base.lastSuccessAt); assert.equal(r.resetAt, base.resetAt);
  assert.equal(r.ageMs, 5 * 60000);
  const later = evaluate(base, { now: '2030-01-01T12:05:00.000Z' });
  assert.equal(later.collectedAt, base.collectedAt); assert.notEqual(later.servedAt, r.servedAt);
});
test('collectedAt and lastSuccessAt stay separate', () => {
  const r = evaluate({ ...base, collectedAt: '2030-01-01T11:58:00.000Z', lastSuccessAt: '2030-01-01T11:50:00.000Z' }, { now: NOW });
  assert.equal(r.collectedAt, '2030-01-01T11:58:00.000Z'); assert.equal(r.lastSuccessAt, '2030-01-01T11:50:00.000Z');
});
test('offline collector is reference, never current, even with fresh timestamps', () => {
  for (const collector of [{ status: 'offline', heartbeatAt: '2030-01-01T11:59:59.000Z' }, { status: 'online', heartbeatAt: '2030-01-01T11:00:00.000Z' }, { status: 'online' }, undefined]) {
    const r = evaluate({ ...base, collector }, { now: NOW });
    assert.equal(r.freshness, FRESHNESS.reference); assert.ok(r.reasons.includes('collector-offline'));
    assert.equal(r.collectedAt, base.collectedAt);
  }
});
test('old collection with online collector is stale', () => {
  const r = evaluate({ ...base, collectedAt: '2030-01-01T10:00:00.000Z', lastSuccessAt: '2030-01-01T10:00:00.000Z' }, { now: NOW });
  assert.equal(r.freshness, FRESHNESS.stale); assert.ok(r.reasons.includes('collected-too-long-ago'));
});
test('recent collection but old last success is stale', () => {
  const r = evaluate({ ...base, lastSuccessAt: '2030-01-01T09:00:00.000Z' }, { now: NOW });
  assert.equal(r.freshness, FRESHNESS.stale); assert.ok(r.reasons.includes('last-success-too-long-ago'));
});
test('reset passed after collection is stale and reset is preserved', () => {
  const r = evaluate({ ...base, resetAt: '2030-01-01T11:58:00.000Z' }, { now: NOW });
  assert.equal(r.freshness, FRESHNESS.stale); assert.ok(r.reasons.includes('reset-passed-since-collection'));
  assert.equal(r.resetAt, '2030-01-01T11:58:00.000Z');
});
test('missing, invalid or future data is unknown/stale, never current', () => {
  assert.equal(evaluate(undefined, { now: NOW }).freshness, FRESHNESS.unknown);
  assert.equal(evaluate({ collector: online, collectedAt: 'yesterday' }, { now: NOW }).freshness, FRESHNESS.unknown);
  assert.equal(evaluate({ ...base, collectedAt: '2030-01-01T13:00:00.000Z' }, { now: NOW }).freshness, FRESHNESS.unknown);
  assert.equal(evaluate({ ...base, lastSuccessAt: null }, { now: NOW }).freshness, FRESHNESS.stale);
  // Impossible calendar dates / hours never become current.
  for (const bad of ['2030-02-31T11:55:00Z', '2030-13-01T11:55:00Z', '2030-01-01T24:00:00Z', '2030-01-01T11:55:60Z']) {
    assert.notEqual(evaluate({ ...base, collectedAt: bad }, { now: NOW }).freshness, FRESHNESS.current, bad);
    assert.notEqual(evaluate({ ...base, lastSuccessAt: bad }, { now: NOW }).freshness, FRESHNESS.current, bad);
    assert.notEqual(evaluate({ ...base, resetAt: bad }, { now: NOW }).freshness, FRESHNESS.current, bad);
  }
  assert.equal(evaluate({ ...base, collector: { status: 'online', heartbeatAt: '2030-02-30T11:59:00Z' } }, { now: NOW }).freshness, FRESHNESS.reference);
  // Future heartbeat beyond skew is reference (reviewer repro); within skew is tolerated.
  const future = evaluate({ ...base, collector: { status: 'online', heartbeatAt: '2030-01-01T13:00:00Z' } }, { now: NOW });
  assert.equal(future.freshness, FRESHNESS.reference); assert.ok(future.reasons.includes('heartbeat-in-future'));
  assert.equal(evaluate({ ...base, collector: { status: 'online', heartbeatAt: '2030-01-01T12:00:30Z' } }, { now: NOW }).freshness, FRESHNESS.current);
});
test('now and limits fail closed; results are deterministic', () => {
  assert.throws(() => evaluate(base), TypeError);
  assert.throws(() => evaluate(base, { now: 'not-a-time' }), TypeError);
  const old = { ...base, collectedAt: '2030-01-01T09:00:00.000Z', lastSuccessAt: '2030-01-01T09:00:00.000Z' };
  for (const bad of [NaN, Infinity, -Infinity, '900000', 0, -1, null]) {
    assert.throws(() => evaluate(old, { now: NOW, staleAfterMs: bad }), TypeError, `staleAfterMs ${String(bad)}`);
    assert.throws(() => evaluate(base, { now: NOW, offlineAfterMs: bad }), TypeError, `offlineAfterMs ${String(bad)}`);
  }
  for (const bad of [NaN, Infinity, -1, '60000', null]) assert.throws(() => evaluate(base, { now: NOW, futureSkewMs: bad }), TypeError);
  assert.equal(evaluate(base, { now: NOW, futureSkewMs: 0 }).freshness, FRESHNESS.current);
  // Boundaries: exactly staleAfterMs old is current; one ms older is stale.
  assert.equal(evaluate(base, { now: NOW, staleAfterMs: 5 * 60000 }).freshness, FRESHNESS.current);
  assert.equal(evaluate(base, { now: NOW, staleAfterMs: 5 * 60000 - 1 }).freshness, FRESHNESS.stale);
  assert.deepEqual(evaluate(base, { now: new Date(NOW) }), evaluate(base, { now: NOW }));
});
test('input record is not mutated', () => {
  const copy = structuredClone(base); evaluate(base, { now: NOW }); assert.deepEqual(base, copy);
});
