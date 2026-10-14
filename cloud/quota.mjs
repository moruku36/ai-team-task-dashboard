// Quota DTO adapter boundary. Pure: no I/O, no clock reads (`now` injected), no collector or network access.
// Raw records come from the owner-authorized store; only allowlisted fields leave this module.
// Never invents per-model quotas: one provider-level entry per provider/source.
import { evaluateQuotaFreshness, parseIsoTimestamp } from './quota-freshness.mjs';
import { sanitizeUsage } from './usage-metadata.mjs';
export const PROVIDERS = Object.freeze(['codex', 'claude', 'ag']);
// codex/claude: native observed_at is required. ag: statusline needs observed_at; the CLI source may fall back to collection time.
const SOURCES = Object.freeze({ codex: ['native'], claude: ['native'], ag: ['statusline', 'cli'] });
export const STATES = Object.freeze(['ok', 'failed', 'ambiguous', 'missing']);
// Existing local contract: positive stale_after_seconds is capped at 3600; missing/invalid means 3600.
export const TTL_CAP_SECONDS = 3600;
// Candidate only (no existing collector heartbeat contract): silence longer than this means the collector is offline.
export const OFFLINE_AFTER_MS = 5 * 60000;
const REASONS = new Set(['no-collection-recorded', 'collector-offline', 'heartbeat-in-future', 'incomplete-timestamps', 'timestamp-in-future', 'collection-newer-than-last-success',
  'collected-too-long-ago', 'last-success-too-long-ago', 'reset-passed-since-collection', 'invalid-reset', 'observed-at-required', 'observed-in-future', 'collection-time-missing',
  'source-unrecognized', 'state-failed', 'state-ambiguous', 'state-missing', 'reset-awaiting-refresh', 'duplicate-records', 'used-percent-invalid']);
const iso = ms => ms === null ? null : new Date(ms).toISOString();
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
export const effectiveTtlSeconds = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, TTL_CAP_SECONDS) : TTL_CAP_SECONDS;
export function publicQuotaEntry(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !PROVIDERS.includes(raw.provider)) return null;
  const nowMs = now.getTime();
  const source = SOURCES[raw.provider].includes(raw.source) ? raw.source : null;
  const reasons = [];
  const usedPercent = percent(raw.usedPercent);
  let state = STATES.includes(raw.state) ? raw.state : 'missing';
  // "ok" without a valid percentage cannot claim availability: sanitize as missing.
  if (state === 'ok' && usedPercent === null) { state = 'missing'; reasons.push('used-percent-invalid'); }
  const observed = parseIsoTimestamp(raw.observedAt), collected = parseIsoTimestamp(raw.collectedAt);
  const success = parseIsoTimestamp(raw.lastSuccessAt), reset = parseIsoTimestamp(raw.resetAt);
  const ttl = effectiveTtlSeconds(raw.staleAfterSeconds);
  let basis = 'none', basisMs = null;
  if (source === null) reasons.push('source-unrecognized');
  else if (collected === null) reasons.push('collection-time-missing');
  else if (observed !== null) { basis = 'observed'; basisMs = Math.min(observed, collected); } // older of observation and collection
  else if (raw.provider === 'ag' && source === 'cli') { basis = 'collected_fallback'; basisMs = collected; }
  else reasons.push('observed-at-required');
  let freshness = 'unknown', ageMs = null;
  if (basisMs !== null) {
    const collector = raw.collector && typeof raw.collector === 'object' ? raw.collector : {};
    const out = evaluateQuotaFreshness({ collectedAt: iso(basisMs), lastSuccessAt: raw.lastSuccessAt, resetAt: raw.resetAt, collector: { status: collector.status, heartbeatAt: collector.heartbeatAt } },
      { now, staleAfterMs: ttl * 1000, offlineAfterMs: OFFLINE_AFTER_MS, futureSkewMs: 0 });
    freshness = out.freshness; ageMs = out.ageMs; reasons.push(...out.reasons);
    // Existing local contract: future observed/collected values are stale (the pure module reports unknown). Never current either way.
    if (freshness === 'unknown' && out.reasons.includes('timestamp-in-future')) freshness = 'stale';
    // The basis is the OLDER of observation/collection, so a future value on either side must be checked explicitly.
    if ((observed !== null && observed > nowMs) || collected > nowMs) { reasons.push('timestamp-in-future'); if (freshness === 'current') freshness = 'stale'; }
  }
  const known = raw.lastKnown && typeof raw.lastKnown === 'object' ? raw.lastKnown : null;
  const knownPercent = known ? percent(known.usedPercent) : null, knownAt = known ? parseIsoTimestamp(known.observedAt) : null;
  // Last-known is a valid historical reference only: a future observation time is rejected (shown as unavailable).
  const lastKnown = knownPercent !== null && knownAt !== null && knownAt <= nowMs ?{ usedPercent: knownPercent, observedAt: iso(knownAt) } : null;
  // Failed/ambiguous/missing state is never current; a retained last-known value is shown only as a reference.
  if (state !== 'ok') { reasons.push('state-' + state); freshness = lastKnown ? 'reference' : 'unknown'; }
  // Reset reached is "awaiting_refresh", never a recovery success.
  const resetState = raw.resetAt == null ? 'none' : reset === null ? 'invalid' : reset <= nowMs ? 'awaiting_refresh' : 'pending';
  if (resetState === 'awaiting_refresh') reasons.push('reset-awaiting-refresh');
  return { provider: raw.provider, source, freshness, state, resetState, freshnessBasis: basis, freshnessAgeMs: ageMs, staleAfterSeconds: ttl,
    observedAt: iso(observed), collectedAt: iso(collected), lastSuccessAt: iso(success), resetAt: iso(reset),
    usedPercent: state === 'ok' && freshness !== 'unknown' ? usedPercent : null, lastKnown: state === 'ok' ? null : lastKnown,
    reasons: [...new Set(reasons)].filter(reason => REASONS.has(reason)) };
}
// Single ambiguous entry for conflicting/duplicate stored records: no value, no times, no last-known, never current.
const ambiguousEntry = (provider, source) => ({ provider, source, freshness: 'unknown', state: 'ambiguous', resetState: 'none', freshnessBasis: 'none', freshnessAgeMs: null,
  staleAfterSeconds: TTL_CAP_SECONDS, observedAt: null, collectedAt: null, lastSuccessAt: null, resetAt: null, usedPercent: null, lastKnown: null, reasons: ['duplicate-records', 'state-ambiguous'] });
// servedAt is the response time only; it is never written into any collection/observation/success/reset field.
export async function publicQuota(quotaStore, now = new Date()) {
  const servedAt = now.toISOString();
  if (!quotaStore) return { servedAt, entries: [] };
  const stored = await quotaStore.read();
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.records) || stored.records.length > 100) throw new Error('Invalid stored quota');
  // Group by provider/source. Duplicate or conflicting records for one key are ambiguous: never pick first/last.
  const groups = new Map();
  for (const raw of stored.records) {
    const entry = publicQuotaEntry(raw, now);
    if (!entry) continue;
    const key = `${entry.provider}/${entry.source}`, group = groups.get(key);
    if (group) group.count++; else groups.set(key, { entry, count: 1 });
  }
  const entries = [...groups.values()].slice(0, 6).map(({ entry, count }) => count === 1 ? entry : ambiguousEntry(entry.provider, entry.source));
  return { servedAt, entries, ...(stored.usageSnapshot ? { usage: sanitizeUsage(stored.usageSnapshot, now.getTime()) } : {}) };
}
