import {lstatSync, readFileSync} from 'node:fs';

const providers = new Set(['codex', 'claude', 'antigravity', 'mimo']);
const states = new Set(['available', 'partial', 'fetch_failed', 'stale', 'missing', 'not_reported', 'unconfirmed']);
const ISO_CURRENCIES = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CNY', 'CHF', 'CAD', 'AUD', 'HKD', 'SGD', 'KRW', 'INR', 'BRL', 'TWD', 'SEK', 'NOK', 'NZD', 'MXN', 'ZAR', 'RUB']);
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
const argonLimitId = 'gemini_4_argon_weekly';
const argonMaxRelativeSeconds = 604800 + 300; // seconds: one week plus five minutes (605100)
const mappingUrl ='https://antigravity.google/docs/models/';

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
    if (provider === 'mimo') {
      const sanitizeMoney = (raw, historical) => {
        if (!raw || typeof raw !== 'object') return null;
        const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : null;
        if (amount === null) return null;
        const currencyRaw = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : null;
        const currencyVerified = Boolean(currencyRaw && ISO_CURRENCIES.has(currencyRaw));
        const currency = currencyVerified ? currencyRaw : null;
        const observed = date(raw.observed_at);
        const collection = historical ? lastSuccess : collected;
        const observedMs = observed ? Date.parse(observed) : NaN;
        const collectionMs = collection ? Date.parse(collection) : NaN;
        const freshnessMs = Number.isFinite(collectionMs) ? (Number.isFinite(observedMs) ? Math.min(collectionMs, observedMs) : collectionMs) : NaN;
        const ageSeconds = Number.isFinite(freshnessMs) ? Math.max(0, (now - freshnessMs) / 1000) : null;
        const isExpired = ageSeconds === null || ageSeconds > staleSeconds || observedMs > now || collectionMs > now;
        const isStale = isExpired || status === 'stale' || raw.status === 'stale' || raw.stale === true;
        const isMismatch = alignment === 'mismatch';
        return {
          metric_kind: 'money',
          amount: isMismatch ? null : amount,
          currency: isMismatch ? null : currency,
          currency_verified: isMismatch ? false : currencyVerified,
          observed_at: observed,
          collected_at: collection,
          age_seconds: ageSeconds,
          fresh_until: !isStale && Number.isFinite(freshnessMs) ? new Date(freshnessMs + staleSeconds * 1000).toISOString() : null,
          stale: isStale,
          status: historical ? 'last_known' : (isMismatch ? 'unavailable' : (status === 'available' ? (isStale ? 'stale' : 'available') : status))
        };
      };
      const curRowMoney = Array.isArray(card.current_rows) ? card.current_rows.find(r => r?.metric_kind === 'money') : null;
      const pastRowMoney = Array.isArray(card.last_known_rows) ? card.last_known_rows.find(r => r?.metric_kind === 'money') : null;
      const balance = sanitizeMoney(card.balance ?? curRowMoney, false);
      const lastKnownBalance = sanitizeMoney(card.last_known_balance ?? pastRowMoney, true);
      cards.push({
        provider: 'mimo',
        status,
        error_kind: card.error_kind === null ? null : errors.has(card.error_kind) ? card.error_kind : 'unknown',
        account_alignment: alignment,
        collected_at: collected,
        last_success_collected_at: lastSuccess,
        balance,
        last_known_balance: lastKnownBalance,
        current_rows: balance ? [balance] : [],
        last_known_rows: lastKnownBalance ? [lastKnownBalance] : [],
        reset_windows: [],
        model_references: []
      });
      continue;
    }
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
    // Gemini 4 Argon weekly limit: a separate window, never merged into gemini_shared and never derived from 5h values.
    // The input must name the limit, state whether `percent` is remaining or used, and carry its own observation time.
    // A relative reset ("Resets in 4d") has no confirmed rounding rule: it is kept as an approximate, precision-unconfirmed
    // hint only and is never converted to a reset time or used for expiry decisions.
    const argonWeekly = (raw, historical) => {
      if (provider !== 'antigravity' || !raw || typeof raw !== 'object' || raw.limit_id !== argonLimitId) return null;
      try {
        let relative = null;
        if (raw.reset_in_seconds !== undefined && raw.reset_in_seconds !== null) {
          // Validate before any use; a malformed item drops only this Argon entry, never the whole payload.
          if (typeof raw.reset_in_seconds !== 'number' || !Number.isFinite(raw.reset_in_seconds) || raw.reset_in_seconds <= 0 || raw.reset_in_seconds > argonMaxRelativeSeconds) return null;
          relative = raw.reset_in_seconds;
        }
        const basis = ['remaining', 'used'].includes(raw.percent_basis) ? raw.percent_basis : null;
        const given = percent(raw.percent);
        const remainingValue = basis && given !== null ? (basis === 'remaining' ? given : 100 - given) : null;
        const observed = date(raw.observed_at), collection = historical ? lastSuccess : collected;
        const observedMs = observed ? Date.parse(observed) : NaN, collectionMs = collection ? Date.parse(collection) : NaN;
        const reset = date(raw.reset_at);
        const hasRelative = !reset && relative !== null;
        // An approximate relative value only means something next to the time it was observed.
        const freshnessMs = Number.isFinite(collectionMs) ? Number.isFinite(observedMs) ? Math.min(collectionMs, observedMs) : hasRelative ? NaN : collectionMs : NaN;
        const ageSeconds = Number.isFinite(freshnessMs) ? Math.max(0, (now - freshnessMs) / 1000) : null;
        const stale = ageSeconds === null || ageSeconds > staleSeconds || observedMs > now || collectionMs > now;
        const resetPassed = !!reset && Date.parse(reset) <= now;
        const resetInvalid = !!reset && Date.parse(reset) - now > 604800 * 1000 + 300000;
        const current = !historical && ['available', 'partial'].includes(status) && alignment !== 'mismatch' && remainingValue !== null && !stale && !resetPassed && !resetInvalid;
        const keep = alignment !== 'mismatch' && remainingValue !== null && (current || historical);
        return {limit_id: argonLimitId, period: 'weekly', shared_pool: null, percent_basis: basis,
          observed_at: observed, reset_at: reset,
          reset_approximate: hasRelative, reset_precision: hasRelative ? 'unconfirmed' : reset ? 'absolute' : 'not_provided',
          reset_relative_seconds: hasRelative ? relative : null,
          age_seconds: ageSeconds, fresh_until: !stale ? new Date(freshnessMs + staleSeconds * 1000).toISOString() : null,
          reset_passed: resetPassed, reset_invalid: resetInvalid, stale,
          status: historical ? 'last_known' : current ? 'available' : basis === null ? 'basis_unconfirmed' : 'unavailable',
          used_percent: keep ? 100 - remainingValue : null, remaining_percent: keep ? remainingValue : null};
      } catch {
        return null;
      }
    };
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
      last_success_collected_at: lastSuccess, current_rows:currentRows, last_known_rows:pastRows, model_references:references,
      ...(provider === 'antigravity' ? {argon_weekly: argonWeekly(card.argon_weekly, false), last_known_argon_weekly: argonWeekly(card.last_known_argon_weekly, true)} : {})});
  }
  return {display_schema_version: 1, view_read_at: date(input.view_read_at), served_at: new Date(now).toISOString(), cards};
}

export function readUsageFile(filename, now = Date.now()) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Invalid usage source');
  return sanitizeUsage(JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')), now);
}
