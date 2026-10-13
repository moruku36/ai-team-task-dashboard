// Pure quota-freshness classification. No I/O, no clock reads: `now` is always injected.
// collectedAt / lastSuccessAt / resetAt are collector-side facts and are echoed back unchanged;
// servedAt is the time this evaluation was served and is never written into any of them.
export const FRESHNESS = Object.freeze({ current: 'current', stale: 'stale', reference: 'reference', unknown: 'unknown' });
export const defaults = Object.freeze({ staleAfterMs: 15 * 60000, offlineAfterMs: 5 * 60000, futureSkewMs: 60000 });
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Strict calendar-valid ISO-8601 with explicit offset; anything else (e.g. 2030-02-31, hour 24) is null.
const ms = value => {
  const m = typeof value === 'string' ? ISO.exec(value) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};
export const parseIsoTimestamp = ms;
const iso = value => value === null ? null : new Date(value).toISOString();
// Fail closed: a bad limit throws instead of silently making everything "current".
const limit = (name, value, min) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (min === 0 ? false : value === 0)) throw new TypeError(`${name} must be a finite number ${min === 0 ? '>= 0' : '> 0'}`);
  return value;
};
// record: { collectedAt, lastSuccessAt, resetAt, collector: { status: 'online'|'offline', heartbeatAt } }
export function evaluateQuotaFreshness(record, { now, ...options } = {}) {
  // Boundaries: age === staleAfterMs is still current (stale only when strictly older); heartbeat silence
  // === offlineAfterMs is still online; a timestamp ahead of now by exactly futureSkewMs is tolerated.
  // staleAfterMs/offlineAfterMs must be finite and > 0; futureSkewMs finite and >= 0. `undefined` = default.
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const limits = { ...defaults, ...given };
  limit('staleAfterMs', limits.staleAfterMs, Number.MIN_VALUE); limit('offlineAfterMs', limits.offlineAfterMs, Number.MIN_VALUE); limit('futureSkewMs', limits.futureSkewMs, 0);
  const nowMs = now instanceof Date ? now.getTime() : ms(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be injected as a Date or ISO timestamp');
  const input = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const collected = ms(input.collectedAt), success = ms(input.lastSuccessAt), reset = ms(input.resetAt);
  const collector = input.collector && typeof input.collector === 'object' ? input.collector : {};
  const heartbeat = ms(collector.heartbeatAt);
  const reasons = [];
  const out = kind => ({ freshness: kind, servedAt: new Date(nowMs).toISOString(), collectedAt: iso(collected), lastSuccessAt: iso(success), resetAt: iso(reset),
    ageMs: collected === null ? null : Math.max(0, nowMs - collected), reasons });
  if (collected === null && success === null) { reasons.push('no-collection-recorded'); return out(FRESHNESS.unknown); }
  // Offline collector (explicit status, missing or silent heartbeat) can only ever yield reference data.
  // A heartbeat from the future (beyond skew) is untrustworthy and treated as offline, never current.
  if (heartbeat !== null && heartbeat - nowMs > limits.futureSkewMs) reasons.push('heartbeat-in-future');
  const offline = reasons.length > 0 || collector.status !== 'online' || heartbeat === null || nowMs - heartbeat > limits.offlineAfterMs;
  if (offline) { reasons.push('collector-offline'); return out(FRESHNESS.reference); }
  if (collected === null || success === null) { reasons.push('incomplete-timestamps'); return out(FRESHNESS.stale); }
  if (collected - nowMs > limits.futureSkewMs || success - nowMs > limits.futureSkewMs) { reasons.push('timestamp-in-future'); return out(FRESHNESS.unknown); }
  if (success < collected - limits.futureSkewMs) reasons.push('collection-newer-than-last-success');
  if (nowMs - collected > limits.staleAfterMs) reasons.push('collected-too-long-ago');
  if (nowMs - success > limits.staleAfterMs) reasons.push('last-success-too-long-ago');
  if (input.resetAt != null && reset === null) reasons.push('invalid-reset');
  if (reset !== null && reset <= nowMs) reasons.push('reset-passed-since-collection');
  return out(reasons.length ? FRESHNESS.stale : FRESHNESS.current);
}
