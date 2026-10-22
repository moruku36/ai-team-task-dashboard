// Allowlist projection of the local display file (dashboard-usage.json) for upload.
// Only fields the dashboard reads are copied; titles, HTTP details, derived windows, raw logs, paths and anything unknown are dropped.
// The result is still the RAW display schema, so freshness is evaluated at read time by sanitizeUsage with the real clock.
import { sanitizeUsage } from './usage-metadata.mjs';
const providers = ['codex', 'claude', 'antigravity'];
const pick = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined && (typeof source[key] !== 'object' || source[key] === null)).map(key => [key, source[key]]));
const rowKeys = ['quota_scope', 'model_family', 'period', 'shared_pool', 'window_id', 'observed_at', 'reset_at', 'status', 'used_percent', 'remaining_percent'];
const argonKeys = ['limit_id', 'percent', 'percent_basis', 'observed_at', 'reset_at', 'reset_in_seconds'];
const referenceKeys = ['model_id', 'quota_scope', 'shared_pool', 'pool_mapping_source', 'pool_mapping_url', 'catalog_confirmation', 'catalog_observed_at'];
const cardKeys = ['provider', 'status', 'acquisition_source', 'error_kind', 'collected_at', 'provider_updated_at', 'attempted_at', 'attempt_started_at', 'attempt_finished_at',
  'retry_not_before', 'snapshot_updated_at', 'stale_after_seconds', 'account_alignment', 'last_success_collected_at'];
const list = (values, keys, max) => (Array.isArray(values) ? values.slice(0, max) : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => pick(row, keys));
export function projectUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.display_schema_version !== 1 || !Array.isArray(input.cards)) throw new Error('Unsupported usage schema');
  const cards = [];
  for (const card of input.cards) {
    if (!card || typeof card !== 'object' || !providers.includes(card.provider) || cards.some(item => item.provider === card.provider)) continue;
    const out = { ...pick(card, cardKeys), current_rows: list(card.current_rows, rowKeys, 20), last_known_rows: list(card.last_known_rows, rowKeys, 20) };
    if (card.provider === 'antigravity') {
      out.model_references = list(card.model_references, [...referenceKeys], 20).map((reference, i) => ({ ...reference,
        ...(Array.isArray(card.model_references[i]?.shared_window_ids) ? { shared_window_ids: card.model_references[i].shared_window_ids.filter(id => typeof id === 'string').slice(0, 8) } : {}) }));
      for (const key of ['argon_weekly', 'last_known_argon_weekly']) if (card[key] && typeof card[key] === 'object' && !Array.isArray(card[key])) out[key] = pick(card[key], argonKeys);
    }
    cards.push(out);
  }
  const projected = { display_schema_version: 1, view_read_at: typeof input.view_read_at === 'string' ? input.view_read_at : null, cards };
  sanitizeUsage(projected); // must be readable by the dashboard's own validator
  return projected;
}
// Per-provider collection time used for the "never roll back" rule.
export const collectionTimes = usage => Object.fromEntries((usage?.cards ?? []).map(card => [card.provider, Date.parse(card.collected_at)]));
