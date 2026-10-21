// Pure, read-only verification of dot-inbox handoff packets against receipts and the task card.
// "Saved to the inbox", "received by the updater", "applied to the task" and "shown on the screen" are four different facts.
// A receipt saying `applied`, a matching packet hash or a successful read-back never proves that the card content changed.
//
// Design rule: success needs positive evidence. Missing, malformed, unrecomputed or ambiguous evidence is never success and is never
// reported as a content contradiction either: it is "unverified" (or "needs_owner_decision" when a person has to decide).
// This module reads nothing from any ledger, inbox or card store; every input is passed in by the caller.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase();
const has = (text, needle) => norm(text).includes(norm(needle));
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

const realDate = (y, mo, d) => {
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number.isInteger(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
};
// Strict ISO-8601 instant with an explicit zone and a real calendar date; anything else is "not a time".
export const validInstant = value => {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, sec = 0] = m.slice(1).map(Number);
  return realDate(y, mo, d) && h <= 23 && mi <= 59 && sec <= 59 && Number.isFinite(Date.parse(value));
};
// The receipt contract stores card hashes as SHA-256 hex (64 hex digits). Anything else ("zzz", short, non-hex) is not a hash.
export const validHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

// ---- Deadlines ------------------------------------------------------------------------------------------------------
// A deadline on the card counts only where the card states one: a structured field (`due_at` / `due` / `deadline`) or a line that begins
// with a deadline label (Due: / Deadline: / 期限: / 締切: / 期日:). A date that merely appears somewhere in the text never counts as the deadline.
// Dates are compared as whole dates (10/2 is not 10/22; 1/5 is not 11/5; 2027 is not 2026). A date without a year cannot be tied to one year.
const FULL_DATE = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g;
const YEARLESS_DATE = /(?<![\d/.\-])(\d{1,2})\/(\d{1,2})(?![\d/])|(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g;
const DATE_LIKE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}|\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{1,2}月|\d{1,2}日|\d{4}年|令和|平成|(?<!\d)\d{1,4}[-/.]\d{1,2}(?!\d)|\b(?:today|tomorrow|tonight|next week)\b|来週|明日|今日|今週/i;
function parseDates(text) {
  const full = [], yearless = [];
  const afterFull = String(text).normalize('NFKC').replace(FULL_DATE, (_, a, b, c, d, e, f) => { const [y, m, day] = [a ?? d, b ?? e, c ?? f].map(Number); if (realDate(y, m, day)) full.push({y, m, d: day}); return ' '; });
  const leftover = afterFull.replace(YEARLESS_DATE, (_, a, b, c, d) => { const [m, day] = [a ?? c, b ?? d].map(Number); if (realDate(2000, m, day)) yearless.push({m, d: day}); return ' '; });
  return {full, yearless, unsupported: DATE_LIKE.test(leftover)};
}
const DEADLINE_LABEL = /^\s*(?:[-*・]\s*)?(?:due(?:[ _-]?date|[ _-]?at)?|deadline|期限|期日|締切|締め切り)\s*[:：]\s*(.+?)\s*$/gim;
function deadlineSources(card) {
  const structured = ['due_at', 'due', 'deadline'].map(k => card[k]).filter(v => typeof v === 'string' && v.trim());
  if (structured.length) return structured;
  return [...String(card.body ?? '').matchAll(DEADLINE_LABEL)].map(m => m[1]);
}
// -> 'match' | 'contradiction' | 'year_unconfirmed' | 'multiple_candidates' | 'unsupported_format' | 'not_in_deadline_field' | 'invalid_assertion'
function dueCheck(dueAt, card) {
  const text = String(dueAt);
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || validInstant(text)) [y, m, d] = text.slice(0, 10).split('-').map(Number);   // the calendar date as written
  if (!realDate(y, m, d)) return 'invalid_assertion';
  const sources = deadlineSources(card);
  if (sources.length === 0) {
    const everything = `${card.title ?? ''}\n${card.body ?? ''}`, p = parseDates(everything);
    return p.full.length || p.yearless.length || p.unsupported ? 'not_in_deadline_field' : 'contradiction';   // no date at all = the card does not show the deadline
  }
  const candidates = new Set(); let unsupported = false;
  for (const source of sources) {
    const p = parseDates(source);
    if (p.unsupported || (!p.full.length && !p.yearless.length)) unsupported = true;
    for (const x of p.full) candidates.add(`F${x.y}-${x.m}-${x.d}`);
    for (const x of p.yearless) candidates.add(`Y${x.m}-${x.d}`);
  }
  if (unsupported) return 'unsupported_format';
  if (candidates.size > 1) return 'multiple_candidates';
  const [only] = [...candidates];
  if (only === `F${y}-${m}-${d}`) return 'match';
  if (only === `Y${m}-${d}`) return 'year_unconfirmed';
  return 'contradiction';
}

// ---- Blockers -------------------------------------------------------------------------------------------------------
// Structured values first (`blocked` boolean, `blocker` string), then labelled lines (Blocker: / Blocked by: / 阻害: / 待ち理由:), never the bare word.
// "none." / "No blockers." / "not blocked" / "なし。" / "特になし" (with or without punctuation) mean NOT blocked; a real description means blocked;
// anything that mixes in negation or resolution words ("not resolving", "解消済み") or is empty/TBD cannot be interpreted and stays unverified.
const BLOCKER_LABEL = /^\s*(?:[-*・]\s*)?(?:blockers?|blocked[ _-]?by|阻害(?:状況|要因)?|ブロック(?:要因)?|待ち理由)\s*[:：]\s*(.*?)\s*$/gim;
const NOT_BLOCKED = new Set(['none', 'n/a', 'na', 'no', 'nil', 'nothing', 'no blocker', 'no blockers', 'not blocked', 'not blocking', 'なし', '無し', '特になし', '特に無し', 'ありません', 'ない', 'ブロックなし', '阻害なし', '問題なし']);
function interpretBlocker(value) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  if (!raw || /^[?？]+$/.test(raw) || /^(tbd|unknown|不明|未定)\W*$/i.test(raw)) return 'unknown';
  const text = raw.toLowerCase().replace(/[。.．、,，;；:：!！"'`「」『』()（）]/g, ' ').replace(/\s+/g, ' ').trim();
  if (NOT_BLOCKED.has(text) || /^[-—ー−]+$/.test(text)) return 'not_blocked';
  if (/(^|\s)(no|not|none|nothing|without|resolved|unblocked|cleared|fixed)(\s|$)|なし|無し|ない|ません|解消|解決/.test(text)) return 'unknown';
  return text ? 'blocked' : 'unknown';
}
function blockerState(card) {
  const states = [];
  if (typeof card.blocked === 'boolean') states.push(card.blocked ? 'blocked' : 'not_blocked');
  if (typeof card.blocker === 'string') states.push(interpretBlocker(card.blocker));
  if (!states.length) for (const m of String(card.body ?? '').matchAll(BLOCKER_LABEL)) states.push(interpretBlocker(m[1]));
  if (!states.length) return 'none';
  if (states.includes('unknown')) return 'unknown';
  return new Set(states).size > 1 ? 'unknown' : states[0];
}

// ---- Card-content checks --------------------------------------------------------------------------------------------
// Opt-in structured expectations carried by a delta: what the card must say once the delta is really applied.
//   card_assertions: {status?, due_at?, blocked?: boolean, blocker_summary?, must_include?: string[], expects_no_card_change?}
// They are only expectations: they count for nothing until compared with the real card read back from the official source.
export const meaningfulAssertions = a => Boolean(a && typeof a === 'object' && (a.status !== undefined || a.due_at || typeof a.blocked === 'boolean' || a.blocker_summary || (Array.isArray(a.must_include) && a.must_include.length)));

// -> {failures: facts of the real card that CONTRADICT the assertions, indeterminate: assertions the card cannot settle (never success, never contradiction)}
export function assertionCheck(assertions, card) {
  const failures = [], indeterminate = [];
  if (!card) return {failures: ['card_missing'], indeterminate};
  const body = `${card.title ?? ''}\n${card.body ?? ''}`;
  if (assertions.status !== undefined && card.status !== assertions.status) failures.push('status_mismatch');
  if (assertions.due_at) {
    const due = dueCheck(assertions.due_at, card);
    if (due === 'contradiction') failures.push('due_at_not_on_card');
    else if (due !== 'match') indeterminate.push(`due_at_${due}`);
  }
  if (typeof assertions.blocked === 'boolean') {
    const explicit = blockerState(card), statusBlocked = card.status === 'Blocked';
    if (assertions.blocked) {
      if (explicit === 'blocked') { /* an explicit blocker item */ }
      else if (explicit === 'unknown') indeterminate.push('blocker_uninterpretable');
      else if (explicit === 'not_blocked') { if (statusBlocked) indeterminate.push('blocker_conflicts_with_status'); else failures.push('blocked_not_on_card'); }
      else if (!statusBlocked) failures.push('blocked_not_on_card');
    } else if (explicit === 'blocked') failures.push('blocked_but_not_expected');
    else if (explicit === 'unknown') indeterminate.push('blocker_uninterpretable');
    else if (explicit === 'not_blocked') { if (statusBlocked) indeterminate.push('blocker_conflicts_with_status'); }
    else if (statusBlocked) failures.push('blocked_but_not_expected');
  }
  if (assertions.blocker_summary && !has(body, assertions.blocker_summary)) failures.push('blocker_summary_not_on_card');
  for (const text of assertions.must_include ?? []) if (!text || !has(body, text)) failures.push('required_text_missing');
  return {failures, indeterminate};
}
export const assertionFailures = (assertions, card) => assertionCheck(assertions, card).failures;

// ---- Owner confirmation ---------------------------------------------------------------------------------------------
// A packet's own `owner_confirmed_target_task_id` is a self-declaration and never counts. A confirmation counts only if an existing record
// supplied by the caller (`ownerConfirmations`: [{event_id, task_id, confirmed_at, basis_id}]) satisfies ALL of:
//   - names this event (event_id) and the task the receipt targets (task_id), which must also be the packet's own target_id_hint
//     (a record never exempts a target mismatch) and, if the packet declares one, its owner_confirmed_target_task_id;
//   - corresponds to the owner's instruction: basis_id is one of the delta's source_message_ids (a delta without any cannot be confirmed);
//   - is not older than the instruction (confirmed_at >= packet source_instruction_at), not in the future (<= now), and not after the
//     change it is meant to authorize (confirmed_at <= receipt applied_at). An unparseable time on either side cannot be ordered => rejected.
// LIMIT: this component cannot tell whether a record is genuine. A record that passes these checks is reported as
// `matched_unauthenticated_input`, never as "authenticated"; whoever supplies the records is responsible for their provenance.
export function matchOwnerConfirmation(confirmations, delta, {target, packet, receipt, now = Date.now()}) {
  const rejected = new Set(); let matched = null;
  for (const r of Array.isArray(confirmations) ? confirmations : []) {
    if (!r || typeof r !== 'object' || r.event_id !== delta.event_id) continue;
    const why = [];
    if (r.task_id !== target || !delta.target_id_hint || r.task_id !== delta.target_id_hint || (delta.owner_confirmed_target_task_id && r.task_id !== delta.owner_confirmed_target_task_id)) why.push('owner_confirmation_target_mismatch');
    if (!Array.isArray(delta.source_message_ids) || !delta.source_message_ids.length || !delta.source_message_ids.includes(r.basis_id)) why.push('owner_confirmation_instruction_not_linked');
    if (!validInstant(r.confirmed_at) || !validInstant(packet?.source_instruction_at) || !validInstant(receipt?.applied_at)) why.push('owner_confirmation_time_not_orderable');
    else {
      const at = Date.parse(r.confirmed_at);
      if (at < Date.parse(packet.source_instruction_at)) why.push('owner_confirmation_predates_instruction');
      if (at > now) why.push('owner_confirmation_in_future');
      if (at > Date.parse(receipt.applied_at)) why.push('owner_confirmation_after_apply');
    }
    if (why.length) why.forEach(w => rejected.add(w)); else matched ??= r;
  }
  return {record: matched, rejected: [...rejected]};
}
export const findOwnerConfirmation = (confirmations, delta, context) => matchOwnerConfirmation(confirmations, delta, context).record;

// ---- Verdict --------------------------------------------------------------------------------------------------------
// Inputs the CALLER provides (this component reads no store):
//   card               the card read back from the official source after the change
//   priorCard          the card as it was BEFORE the change, from a trusted source. Never inferred from `card`: without it a reopening of a
//                      closed card cannot be excluded, so the delta stays unverified.
//   recomputedHashes   {before, after}: hashes the caller recomputed from priorCard and card with the receipt contract's own algorithm
//                      (unknown to this component). Without them hashes are only format-checked and the delta stays unverified.
//   ownerConfirmations existing owner-confirmation records (see matchOwnerConfirmation);   now: ms epoch (default: current time)
//   displayed          the card as the dashboard shows it (optional: without it the screen stage stays "unknown")
//
// Findings are kept separately and never merged away:
//   receipt       the receipt itself is not trustworthy (identity, times, target, read-back, malformed or recompute-mismatching hashes)
//   content       the real card CONTRADICTS the packet's assertions
//   declaration   the packet's own declaration contradicts the receipt (expects_no_card_change but the hashes differ)
//   insufficient  nothing (or not enough) to compare: no assertions, card / prior state not provided, hashes absent or not recomputed, ambiguous dates/blockers, ...
//   owner         an owner-confirmation question is unresolved (never success, for any card state)
//
// Overall verdict, highest priority first (the first rule that applies wins; all findings stay listed):
//    1 inbox_integrity_error      packet hash / batch id does not match the inbox record
//    2 needs_owner_decision       any owner finding (reopening a closed card, or a self-declared / rejected confirmation, without a matching record)
//    3 saved_not_received         no receipt
//    4 receipt_inconsistent       the receipt is not this event's valid receipt (other event/batch, bad times, changed instruction time) - whatever its state
//    5 received_not_applied       a valid receipt that does not say "applied"
//    6 receipt_inconsistent       an "applied" receipt with applied-time / read-back / target / hash problems
//    7 mismatch_content_not_reflected  content findings (a contradiction is never hidden behind "unverified")
//    8 declaration_inconsistent
//    9 unverified                 insufficient findings (includes: prior state not provided, hashes not recomputed)
//   10 content_present_no_recorded_change   content matches, recomputed hashes equal (no change was declared expected)
//   11 applied_not_displayed / applied_verified
// applied_verified therefore needs: a valid receipt, a trusted prior state, recomputed-and-matching hashes, a card that satisfies every
// assertion unambiguously, and no open owner question. An owner-confirmation record that was used is listed in `caveats` as unauthenticated input.
//
// expects_no_card_change: true changes only what the hashes must show: BOTH recomputed hashes present and EQUAL (missing => unverified,
// different => declaration_inconsistent). It never relaxes the receipt, time or card-content checks.
export function verifyDelta({batch, packetBytes, packet, delta, receipt, card, priorCard, recomputedHashes, displayed, ownerConfirmations, now = Date.now()}) {
  const findings = {receipt: [], content: [], declaration: [], insufficient: [], owner: []};
  const stages = {saved_to_inbox: false, received: false, applied_to_task: false, displayed: 'unknown'};
  const evidence = {hash: 'absent', prior_state: priorCard && typeof priorCard === 'object' ? 'provided' : 'absent', owner_confirmation: 'none'};
  const caveats = [];
  stages.saved_to_inbox = Boolean(batch && packetBytes && sha256(packetBytes) === batch.packet_sha256 && packet?.batch_id === batch.batch_id);
  const integrityProblem = !stages.saved_to_inbox;
  if (receipt) {
    // "Received" means: this event's receipt, for this batch, with a valid receipt time and an unchanged instruction time. Nothing weaker.
    if (receipt.event_id !== delta.event_id || receipt.batch_id !== packet?.batch_id) findings.receipt.push('receipt_identity_mismatch');
    if (!validInstant(receipt.received_at)) findings.receipt.push('received_at_invalid');
    if (!packet?.source_instruction_at || !validInstant(packet.source_instruction_at)) findings.insufficient.push('source_instruction_at_missing_in_packet');
    else if (!validInstant(receipt.source_instruction_at)) findings.receipt.push('source_instruction_at_missing_in_receipt');
    else if (Date.parse(receipt.source_instruction_at) !== Date.parse(packet.source_instruction_at)) findings.receipt.push('source_instruction_at_changed');
    stages.received = findings.receipt.length === 0;
  }
  const receiptUntrusted = findings.receipt.length > 0;
  const assertions = delta.card_assertions, checkable = meaningfulAssertions(assertions);
  const claimedApplied = receipt?.application_state === 'applied';
  const target = receipt?.target_task_id ?? receipt?.task_id;
  if (!delta.target_id_hint) findings.insufficient.push('target_id_hint_missing');

  // owner confirmation
  const {record: confirmation, rejected} = matchOwnerConfirmation(ownerConfirmations, delta, {target, packet, receipt, now});
  const priorDone = evidence.prior_state === 'provided' && priorCard.status === 'Done';
  const needsOwner = priorDone && !(checkable && assertions.status === 'Done');
  if (confirmation) { evidence.owner_confirmation = 'matched_unauthenticated_input'; caveats.push('owner_confirmation_record_authenticity_not_verified'); }
  else if (rejected.length) { evidence.owner_confirmation = 'rejected'; findings.owner.push(...rejected); }
  if (!confirmation && delta.owner_confirmed_target_task_id) { if (evidence.owner_confirmation === 'none') evidence.owner_confirmation = 'self_declared_only'; findings.owner.push('owner_confirmation_self_declared_only'); }
  if (!confirmation && needsOwner) findings.owner.push('owner_target_confirmation_required');
  if (evidence.prior_state !== 'provided') findings.insufficient.push('prior_state_unavailable');

  // hash evidence
  const noChange = checkable && assertions.expects_no_card_change === true;
  const hasBefore = receipt?.before_hash !== undefined && receipt?.before_hash !== null && receipt?.before_hash !== '';
  const hasAfter = receipt?.after_hash !== undefined && receipt?.after_hash !== null && receipt?.after_hash !== '';
  let hashesEqual = false;
  if (claimedApplied) {
    if (!receipt.applied_at) findings.receipt.push('applied_without_applied_at');
    else if (!validInstant(receipt.applied_at)) findings.receipt.push('applied_at_invalid');
    else if (validInstant(receipt.received_at) && Date.parse(receipt.applied_at) < Date.parse(receipt.received_at)) findings.receipt.push('applied_before_received');
    if (!receipt.readback_verified) findings.receipt.push('applied_without_readback');
    if (delta.target_id_hint && target !== delta.target_id_hint) findings.receipt.push('target_task_mismatch');
    if (!hasBefore || !hasAfter) findings.insufficient.push('card_hash_missing');
    else if (!validHash(receipt.before_hash) || !validHash(receipt.after_hash)) { evidence.hash = 'malformed'; findings.receipt.push('card_hash_malformed'); }
    else {
      hashesEqual = receipt.before_hash.toLowerCase() === receipt.after_hash.toLowerCase();
      const r = recomputedHashes;
      if (!r || !validHash(r.before) || !validHash(r.after)) { evidence.hash = 'format_only'; findings.insufficient.push('card_hash_not_recomputed'); }
      else if (r.before.toLowerCase() !== receipt.before_hash.toLowerCase() || r.after.toLowerCase() !== receipt.after_hash.toLowerCase()) { evidence.hash = 'recomputed_mismatch'; findings.receipt.push('card_hash_recompute_mismatch'); }
      else {
        evidence.hash = 'recomputed_match';
        if (noChange && !hashesEqual) findings.declaration.push('hash_changed_but_no_change_expected');
      }
    }
  }
  if (!checkable) findings.insufficient.push('no_card_assertions_content_unverifiable');
  else if (!card) findings.insufficient.push('card_not_read_back');
  else { const check = assertionCheck(assertions, card); findings.content.push(...check.failures); findings.insufficient.push(...check.indeterminate); }
  if (displayed !== undefined && checkable) stages.displayed = assertionCheck(assertions, displayed).failures.length === 0;
  if (noChange && claimedApplied && evidence.hash === 'recomputed_match' && !hashesEqual) { /* already a declaration finding */ }

  let verdict;
  if (integrityProblem) verdict = 'inbox_integrity_error';
  else if (findings.owner.length) verdict = 'needs_owner_decision';
  else if (!receipt) verdict = 'saved_not_received';
  else if (receiptUntrusted && (!claimedApplied || ['receipt_identity_mismatch', 'received_at_invalid', 'source_instruction_at_missing_in_receipt', 'source_instruction_at_changed'].some(c => findings.receipt.includes(c)))) verdict = 'receipt_inconsistent';
  else if (!claimedApplied) verdict = 'received_not_applied';
  else if (findings.receipt.length) verdict = 'receipt_inconsistent';
  else if (findings.content.length) verdict = 'mismatch_content_not_reflected';
  else if (findings.declaration.length) verdict = 'declaration_inconsistent';
  else if (findings.insufficient.length) verdict = 'unverified';
  else if (!noChange && hashesEqual) verdict = 'content_present_no_recorded_change';
  else { stages.applied_to_task = true; verdict = stages.displayed === false ? 'applied_not_displayed' : 'applied_verified'; }
  stages.received = Boolean(receipt) && !findings.receipt.some(c => ['receipt_identity_mismatch', 'received_at_invalid', 'source_instruction_at_missing_in_receipt', 'source_instruction_at_changed'].includes(c));
  const problems = [...new Set([...(integrityProblem ? ['packet_hash_or_batch_id_mismatch'] : []), ...Object.values(findings).flat(), ...(claimedApplied && !noChange && hashesEqual && evidence.hash === 'recomputed_match' ? ['card_hash_unchanged'] : [])])];
  return {event_id: delta.event_id, verdict, stages, evidence, caveats, findings, problems};
}

// Batch state is derived from its deltas; the inbox's own `application_state` is never trusted on its own.
// Consistent with the per-delta verdicts: only an all-applied_verified batch is applied; any owner question, mismatch or
// inconsistency is visible at batch level; "unverified" (insufficient evidence) is never promoted.
export const batchVerdict = results => !results.length ? 'unverified'
  : results.every(r => r.verdict === 'applied_verified') ? 'applied_verified'
  : results.some(r => ['mismatch_content_not_reflected', 'receipt_inconsistent', 'declaration_inconsistent', 'inbox_integrity_error'].includes(r.verdict)) ? 'mismatch'
  : results.some(r => r.verdict === 'needs_owner_decision') ? 'needs_owner_decision'
  : results.every(r => ['unverified', 'content_present_no_recorded_change', 'applied_verified'].includes(r.verdict)) ? 'unverified'
  : 'not_fully_applied';

// Batch result with the cautions of its deltas carried along (de-duplicated, never dropped): e.g. a used owner-confirmation record whose
// authenticity was not verified. The verdict is exactly batchVerdict(results); caveats never turn a verdict into a more successful one.
export const batchSummary = results => ({verdict: batchVerdict(results), caveats: [...new Set(results.flatMap(r => r.caveats ?? []))]});

// Duplicate prevention. `ledger` maps event_id -> fingerprint of the delta already applied (append-only record kept by
// the updater). The same packet can be re-sent safely; the same event_id with different content is a conflict.
export const deltaFingerprint = delta => sha256(JSON.stringify(canonical(delta)));
export function planApply(ledger, packet, inboxBatches = []) {
  if (inboxBatches.filter(b => b.batch_id === packet.batch_id).length > 1) return [{event_id: null, action: 'conflict', reason: 'duplicate_batch_id_in_inbox'}];
  const plan = [], seen = new Set();
  for (const delta of packet.deltas ?? []) {
    if (!delta.event_id || seen.has(delta.event_id)) { plan.push({event_id: delta.event_id ?? null, action: 'conflict', reason: 'missing_or_duplicate_event_id'}); continue; }
    seen.add(delta.event_id);
    const known = ledger[delta.event_id], fingerprint = deltaFingerprint(delta);
    plan.push(!known ? {event_id: delta.event_id, action: 'apply'} : known === fingerprint ? {event_id: delta.event_id, action: 'skip_duplicate'} : {event_id: delta.event_id, action: 'conflict', reason: 'same_event_id_different_content'});
  }
  return plan;
}

// Read-only CLI: prints ids, verdicts and problem codes only (never packet or card text).
// --map <recorded-prefix>=<actual-prefix> lets the owner declare that a recorded path prefix is the same storage as another
// prefix (e.g. a packaged-app redirect). Nothing is guessed, moved or copied; without it an unreachable path is reported as such.
// --confirmations <file> supplies existing owner-confirmation records (see matchOwnerConfirmation); without it none are assumed.
// The CLI passes no prior cards and no recomputed hashes, so it can never print applied_verified: its output is reference information only
// (`reference_only: true`, with the missing inputs listed in `limits`). Per-delta and batch `caveats` are always printed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const take = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const map = take('--map'), cardsPath = take('--cards'), confirmationsPath = take('--confirmations'), [inboxPath] = args;
  if (!inboxPath) throw new Error('Usage: node scripts/inbox-receipt-verify.mjs <dot-inbox.json> [--cards <cards.json>] [--confirmations <records.json>] [--map <recorded-prefix>=<actual-prefix>]');
  const [from, to] = map ? map.split('=') : [];
  const remap = p => from && p.toLowerCase().startsWith(from.toLowerCase()) ? to + p.slice(from.length) : p;
  const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  const cards = cardsPath ? read(cardsPath) : {};
  const ownerConfirmations = confirmationsPath ? read(confirmationsPath) : [];
  for (const batch of read(inboxPath).batches) {
    let bytes;
    try { bytes = readFileSync(remap(batch.packet_path)); } catch { console.log(JSON.stringify({batch_id: batch.batch_id, verified: 'packet_path_unreachable'})); continue; }
    try {
      const packet = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
      const results = (packet.deltas ?? []).map(delta => {
        let receipt; try { receipt = read(join(remap(batch.receipt_directory), `${delta.event_id}.json`)); } catch { /* no receipt yet */ }
        return verifyDelta({batch, packetBytes: bytes, packet, delta, receipt, card: cards[receipt?.target_task_id ?? delta.target_id_hint], ownerConfirmations});
      });
      const summary = batchSummary(results);
      console.log(JSON.stringify({batch_id: batch.batch_id, inbox_state: batch.application_state, verified: summary.verdict, caveats: summary.caveats, reference_only: true,
        limits: ['no_prior_card_supplied', 'no_recomputed_hashes_supplied'],
        deltas: results.map(r => ({event_id: r.event_id, verdict: r.verdict, problems: r.problems, caveats: r.caveats}))}));
    } catch { console.log(JSON.stringify({batch_id: batch.batch_id, verified: 'packet_unparseable'})); }
  }
}
