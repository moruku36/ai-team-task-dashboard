const providers = new Set(['codex', 'claude', 'antigravity']);
const states = new Set(['available', 'partial', 'fetch_failed', 'stale', 'missing', 'not_reported']);
const errors = new Set(['rate_limited', 'executable_not_found', 'timeout', 'parse_error', 'version_mismatch', 'authentication_required', 'permission_denied']);
const date = value => {
  if (typeof value !== 'string') return null;
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!fields) return null;
  const [year, month, day, hour, minute, second] = fields.slice(1).map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const parsed = new Date(ms);
  return parsed.getUTCFullYear() >= 1 && parsed.getUTCFullYear() <= 9999 ? parsed.toISOString() : null;
};
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const modelNames = Object.freeze({gpt_oss_120b:'GPT-OSS-120b', claude_opus_5_5:'Claude Opus 5.5 (thinking)', claude_sonnet_5_5:'Claude Sonnet 5.5 (thinking)'});
const pools = {gemini:'gemini_shared', claude:'claude_gpt_shared', gpt_oss:'claude_gpt_shared'};
const mappingUrl = 'https://antigravity.google/docs/models/';

export function sanitizeUsage(input, now = Date.now()) {
  if (input?.display_schema_version !== 1 || !Array.isArray(input.cards)) throw new Error('Unsupported usage schema');
  const cards = [];
  for (const card of input.cards) {
    if (!providers.has(card?.provider) || cards.some(item => item.provider === card.provider)) continue;
    const provider = card.provider;
    const status = states.has(card.status) ? card.status : 'missing';
    const alignment = ['verified', 'not_verified', 'mismatch'].includes(card.account_alignment) ? card.account_alignment : 'not_verified';
    const collected = date(card.collected_at), lastSuccess = date(card.last_success_collected_at);
    const staleSeconds = typeof card.stale_after_seconds === 'number' && card.stale_after_seconds > 0 ? Math.min(card.stale_after_seconds, 3600) : 3600;
    const rows = (values, historical) => (Array.isArray(values) ? values.slice(0, 20) : []).flatMap(row => {
      const scope = provider === 'antigravity' ? 'antigravity_shared' : 'own_subscription';
      if (row?.quota_scope !== scope) return [];
      const family = ['codex', 'claude', 'gemini', 'gpt_oss'].includes(row.model_family) ? row.model_family : null;
      const period = ['weekly', 'five_hour'].includes(row.period) ? row.period : null;
      if (!family || !period) return [];
      if ((provider === 'codex' && family !== 'codex') || (provider === 'claude' && family !== 'claude') || (provider === 'antigravity' && family === 'codex')) return [];
      const observed = date(row.observed_at);
      const collection = historical ? lastSuccess : collected;
      const reset = date(row.reset_at);
      const observedMs = observed ? Date.parse(observed) : NaN;
      const collectionMs = collection ? Date.parse(collection) : NaN;
      const requiresObserved = provider !== 'antigravity' || card.acquisition_source === 'statusline';
      const freshnessMs = Number.isFinite(collectionMs) ? Number.isFinite(observedMs) ? Math.min(collectionMs, observedMs) : requiresObserved ? NaN : collectionMs : NaN;
      const ageSeconds = Number.isFinite(freshnessMs) ? Math.max(0, (now - freshnessMs) / 1000) : null;
      const stale = ageSeconds === null || ageSeconds > staleSeconds || observedMs > now || collectionMs > now;
      const resetPassed = !!reset && Date.parse(reset) <= now;
      const resetInvalid = !reset || Date.parse(reset) - now > (period === 'five_hour' ? 18000 : 604800) * 1000 + 300000;
      const used = percent(row.used_percent), remaining = percent(row.remaining_percent);
      const valuesValid = used !== null && remaining !== null && Math.abs(used + remaining - 100) < 0.01;
      const current = !historical && ['available', 'partial'].includes(status) && row.status === 'available' && alignment !== 'mismatch' && !stale && !resetPassed && !resetInvalid && valuesValid;
      return [{quota_scope: scope, model_family: family, period,
        shared_pool: provider === 'antigravity' && pools[family] === row.shared_pool ? row.shared_pool : null,
        window_id: typeof row.window_id === 'string' && /^(?:primary|secondary|five_hour|g\d+_b\d+)$/.test(row.window_id) ? row.window_id : null,
        observed_at: observed, reset_at: reset, age_seconds: ageSeconds,
        fresh_until: !stale ? new Date(freshnessMs + staleSeconds * 1000).toISOString() : null,
        reset_passed: resetPassed, reset_invalid: resetInvalid, stale,
        status: historical ? 'last_known' : current ? 'available' : row.status === 'not_reported' ? 'not_reported' : 'unavailable',
        // Historical numbers remain explicitly historical; never promote them after a reset.
        used_percent: alignment === 'mismatch' ? null : historical && valuesValid ? used : current ? used : null,
        remaining_percent: alignment === 'mismatch' ? null : historical && valuesValid ? remaining : current ? remaining : null}];
    });
    const distinctPools = (values, historical) => {
      const output = [], seen = new Map();
      for (const row of values) {
        if (!row.shared_pool) {output.push(row); continue;}
        const key = `${row.shared_pool}:${row.period}`, prior = seen.get(key);
        if (!prior) {seen.set(key,row); output.push(row); continue;}
        if (['used_percent','remaining_percent','reset_at','observed_at'].some(field => prior[field] !== row[field])) {
          prior.status = historical ? 'last_known' : 'unavailable'; prior.used_percent = null; prior.remaining_percent = null;
          prior.fresh_until = null; prior.stale = true;
        }
      }
      return output;
    };
    const currentRows = distinctPools(rows(card.current_rows,false),false);
    const pastRows = distinctPools(rows(card.last_known_rows,true),true);
    const references = [];
    if (provider === 'antigravity') for (const reference of (Array.isArray(card.model_references) ? card.model_references.slice(0,20) : [])) {
      if (!reference || typeof reference.model_id !== 'string' || !Object.hasOwn(modelNames,reference.model_id) || references.some(row=>row.model_id===reference.model_id) || reference.quota_scope !== 'antigravity_shared_reference') continue;
      const mapped = reference.shared_pool === 'claude_gpt_shared' && reference.pool_mapping_source === 'official_models_documentation' && reference.pool_mapping_url === mappingUrl;
      const requestedIds = Array.isArray(reference.shared_window_ids) ? reference.shared_window_ids : [];
      const ids = mapped ? currentRows.filter(row=>row.shared_pool==='claude_gpt_shared' && row.status==='available' && row.window_id && requestedIds.includes(row.window_id)).map(row=>row.window_id) : [];
      const catalogTime = date(reference.catalog_observed_at);
      const catalogObserved = reference.catalog_confirmation === 'observed_in_cli_catalog' && catalogTime && Date.parse(catalogTime)<=now;
      references.push({model_id:reference.model_id, official_name:modelNames[reference.model_id], quota_scope:'antigravity_shared_reference',
        independent_quota_status:'not_provided', quota_status:ids.length ? 'shared_pool_only' : 'not_provided',
        used_percent:null, remaining_percent:null, reset_at:null, shared_pool:mapped?'claude_gpt_shared':null,
        shared_window_ids:[...new Set(ids)], pool_mapping_source:mapped?'official_models_documentation':null, pool_mapping_url:mapped?mappingUrl:null,
        catalog_confirmation:catalogObserved?'observed_in_cli_catalog':'not_provided', catalog_observed_at:catalogObserved?catalogTime:null});
    }
    // Fixed window inventory; derive validity from sanitized rows, never trust raw state/percent fields.
    const resetWindows = (provider === 'antigravity' ? ['gemini_shared','claude_gpt_shared'] : [null]).flatMap(pool => ['five_hour','weekly'].map(period => {
      const matches = currentRows.filter(row=>row.period===period && row.shared_pool===pool);
      const row = matches.length===1 ? matches[0] : null;
      const state = status==='fetch_failed' ? 'fetch_failed' : alignment==='mismatch' ? 'missing' : matches.length>1 ? 'ambiguous' : row?.status==='not_reported' ? 'not_reported' : row?.stale ? 'stale' : row?.reset_passed ? 'awaiting_refresh' : row?.status==='available' ? 'available' : 'missing';
      const reset = row?.status==='not_reported' || row?.reset_invalid ? null : row?.reset_at ?? null;
      return {period,shared_pool:pool,resetAt:reset,collectedAt:collected,state,resetState:state==='awaiting_refresh'?'awaiting_refresh':reset?'scheduled':'not_provided',recoveryConfirmed:false};
    }));
    cards.push({provider, status, error_kind: card.error_kind === null ? null : errors.has(card.error_kind) ? card.error_kind : 'unknown', reset_windows:resetWindows,
      account_alignment: alignment, collected_at: collected,
      provider_updated_at: date(card.provider_updated_at), snapshot_updated_at: date(card.snapshot_updated_at),
      attempted_at: date(card.attempted_at), attempt_started_at: date(card.attempt_started_at),
      attempt_finished_at: date(card.attempt_finished_at), retry_not_before: date(card.retry_not_before),
      last_success_collected_at: lastSuccess, current_rows:currentRows, last_known_rows:pastRows, model_references:references});
  }
  return {display_schema_version: 1, view_read_at: date(input.view_read_at), served_at: new Date(now).toISOString(), cards};
}

