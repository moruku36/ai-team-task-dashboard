// Pure, read-only verification of dot-inbox handoff packets against receipts and the task card.
// "Saved to the inbox", "received by the updater", "applied to the task" and "shown on the screen" are four different facts.
// A receipt saying `applied`, a matching packet hash or a successful read-back never proves that the card content changed.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase();
const has = (text, needle) => norm(text).includes(norm(needle));
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

// Strict ISO-8601 instant with an explicit zone and a real calendar date; anything else is "not a time".
export const validInstant = value => {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, sec = 0] = m.slice(1).map(Number);
  return realDate(y, mo, d) && h <= 23 && mi <= 59 && sec <= 59 && Number.isFinite(Date.parse(value));
};
const realDate = (y, mo, d) => {
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number.isInteger(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
};

// ---- Card-content checks --------------------------------------------------------------------------------------------
// Opt-in structured expectations carried by a delta: what the card must say once the delta is really applied.
//   card_assertions: {status?, due_at?, blocked?: boolean, blocker_summary?, must_include?: string[], expects_no_card_change?}
// They are only expectations: they count for nothing until compared with the real card read back from the official source.
// Packets without assertions can only ever be "received" or "unverified", never "applied_verified".
export const meaningfulAssertions = a => Boolean(a && typeof a === 'object' && (a.status !== undefined || a.due_at || typeof a.blocked === 'boolean' || a.blocker_summary || (Array.isArray(a.must_include) && a.must_include.length)));

// Dates on a card are compared as whole dates, never as substrings (10/2 is not 10/22, 1/5 is not 11/5, 2026 is not 2027).
// A date written without a year (10/22, 10月22日) cannot be tied to one year: it is "indeterminate" (=> unverified), not a match.
function dateMentions(text) {
  const full = [], yearless = [];
  const rest = String(text).normalize('NFKC').replace(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, (_, a, b, c, d, e, f) => {
    const [y, m, day] = [a ?? d, b ?? e, c ?? f].map(Number); if (realDate(y, m, day)) full.push({y, m, d: day}); return ' ';
  });
  rest.replace(/(?<![\d/.\-])(\d{1,2})\/(\d{1,2})(?![\d/])|(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g, (_, a, b, c, d) => {
    const [m, day] = [a ?? c, b ?? d].map(Number); if (realDate(2000, m, day)) yearless.push({m, d: day}); return ' ';
  });
  return {full, yearless};
}
function dueCheck(dueAt, body) {
  const [y, m, d] = String(dueAt).slice(0, 10).split('-').map(Number);   // the calendar date as written (in the stated offset)
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(dueAt)) || !realDate(y, m, d)) return 'invalid_assertion';
  const {full, yearless} = dateMentions(body);
  if (full.some(x => x.y === y && x.m === m && x.d === d)) return 'match';
  if (yearless.some(x => x.m === m && x.d === d)) return 'year_unconfirmed';
  return 'absent';
}

// An explicit blocker item on the card: a labelled line with a real value. Prose such as "not blocked" is not one.
const NEGATIVE = /^(none|n\/a|no|nil|-|—|なし|無し|ありません|ない)$/i;
function explicitBlocker(card) {
  if (typeof card.blocker === 'string' && card.blocker.trim() && !NEGATIVE.test(card.blocker.trim())) return true;
  for (const line of String(card.body ?? '').normalize('NFKC').split(/\r?\n/)) {
    const m = /^\s*(?:[-*・]\s*)?(?:blocker|blocked[ _-]?by|阻害(?:状況|要因)?|ブロック(?:要因)?|待ち理由)\s*[:：]\s*(\S.*?)\s*$/i.exec(line);
    if (m && !NEGATIVE.test(m[1])) return true;
  }
  return false;
}

// -> {failures: facts of the real card that CONTRADICT the assertions, indeterminate: assertions the card text cannot settle}
export function assertionCheck(assertions, card) {
  const failures = [], indeterminate = [];
  if (!card) return {failures: ['card_missing'], indeterminate};
  const body = `${card.title ?? ''}\n${card.body ?? ''}`;
  if (assertions.status !== undefined && card.status !== assertions.status) failures.push('status_mismatch');
  if (assertions.due_at) {
    const due = dueCheck(assertions.due_at, body);
    if (due === 'absent') failures.push('due_at_not_on_card');
    else if (due === 'year_unconfirmed') indeterminate.push('due_at_year_unconfirmed');
    else if (due === 'invalid_assertion') indeterminate.push('due_at_assertion_invalid');
  }
  if (assertions.blocked === true && card.status !== 'Blocked' && !explicitBlocker(card)) failures.push('blocked_not_on_card');
  if (assertions.blocked === false && (card.status === 'Blocked' || explicitBlocker(card))) failures.push('blocked_but_not_expected');
  if (assertions.blocker_summary && !has(body, assertions.blocker_summary)) failures.push('blocker_summary_not_on_card');
  for (const text of assertions.must_include ?? []) if (!text || !has(body, text)) failures.push('required_text_missing');
  return {failures, indeterminate};
}
export const assertionFailures = (assertions, card) => assertionCheck(assertions, card).failures;

// ---- Owner confirmation ---------------------------------------------------------------------------------------------
// A packet's own `owner_confirmed_target_task_id` is a self-declaration and never counts. Confirmation must be found in an existing
// confirmation record supplied by the caller (`ownerConfirmations`: [{event_id, task_id, confirmed_at, basis_id}]) that names this
// event and the task the receipt targets, has a valid confirmation time and, when the delta lists its source message ids,
// a basis_id that is one of them. No record => the case stays undecided (needs_owner_decision). Nothing is created here.
export function findOwnerConfirmation(confirmations, delta, target) {
  return (Array.isArray(confirmations) ? confirmations : []).find(r => r && typeof r === 'object' && r.event_id === delta.event_id && r.task_id === target &&
    validInstant(r.confirmed_at) && (!delta.owner_confirmed_target_task_id || r.task_id === delta.owner_confirmed_target_task_id) &&
    (!Array.isArray(delta.source_message_ids) || delta.source_message_ids.length === 0 || delta.source_message_ids.includes(r.basis_id))) ?? null;
}

// ---- Verdict --------------------------------------------------------------------------------------------------------
// `card` MUST be read back from the official source (CLI/API) by the caller, never taken from the packet or the receipt.
// `displayed` is the card as the dashboard shows it (optional: without it the screen stage stays "unknown").
//
// Findings are kept separately and never merged away:
//   findings.receipt       the receipt itself is not trustworthy (identity, times, target, read-back)
//   findings.content       the real card CONTRADICTS the packet's assertions
//   findings.declaration   the packet's own declaration contradicts the receipt (expects_no_card_change but the hashes changed)
//   findings.insufficient  nothing (or not enough) to compare: no assertions, card not read back, hash evidence missing, year-less date, ...
//   findings.owner         owner confirmation missing / self-declared only
//
// Overall verdict, highest priority first (the first rule that applies wins; all findings stay listed):
//   1 inbox_integrity_error  packet hash / batch id does not match the inbox record
//   2 needs_owner_decision   a closed (Done) card would be reopened/extended without a verified owner confirmation record
//   3 saved_not_received     no receipt         4 received_not_applied  receipt exists but is not "applied"
//   5 receipt_inconsistent   findings.receipt non-empty
//   6 mismatch_content_not_reflected   findings.content non-empty      (a contradiction is never hidden behind "unverified")
//   7 declaration_inconsistent         findings.declaration non-empty
//   8 unverified             findings.insufficient non-empty
//   9 content_present_no_recorded_change  content matches but before/after hashes are equal (and no change was declared expected)
//  10 applied_not_displayed / applied_verified
//
// expects_no_card_change: true changes only what the hashes must show: BOTH hashes are required and they must be EQUAL.
// Missing => unverified; different => declaration_inconsistent. It never relaxes the receipt, time or card-content checks.
export function verifyDelta({batch, packetBytes, packet, delta, receipt, card, displayed, ownerConfirmations}) {
  const findings = {receipt: [], content: [], declaration: [], insufficient: [], owner: []};
  const stages = {saved_to_inbox: false, received: false, applied_to_task: false, displayed: 'unknown'};
  stages.saved_to_inbox = Boolean(batch && packetBytes && sha256(packetBytes) === batch.packet_sha256 && packet?.batch_id === batch.batch_id);
  const integrityProblem = !stages.saved_to_inbox;
  if (receipt) {
    stages.received = receipt.event_id === delta.event_id && receipt.batch_id === packet?.batch_id;
    if (!stages.received) findings.receipt.push('receipt_identity_mismatch');
    if (!validInstant(receipt.received_at)) { findings.receipt.push('received_at_invalid'); stages.received = false; }
    if (!packet?.source_instruction_at || !validInstant(packet.source_instruction_at)) findings.insufficient.push('source_instruction_at_missing_in_packet');
    else if (!validInstant(receipt.source_instruction_at)) findings.receipt.push('source_instruction_at_missing_in_receipt');
    else if (Date.parse(receipt.source_instruction_at) !== Date.parse(packet.source_instruction_at)) findings.receipt.push('source_instruction_at_changed');
  }
  const assertions = delta.card_assertions, checkable = meaningfulAssertions(assertions);
  const claimedApplied = receipt?.application_state === 'applied';
  const target = receipt?.target_task_id ?? receipt?.task_id;
  const confirmation = findOwnerConfirmation(ownerConfirmations, delta, target);
  const expectedTarget = confirmation ? confirmation.task_id : delta.target_id_hint;   // a self-declared owner_confirmed_target_task_id never redirects the target
  if (delta.owner_confirmed_target_task_id && !confirmation) findings.owner.push('owner_confirmation_self_declared_only');
  const noChange = checkable && assertions.expects_no_card_change === true;
  const hashesPresent = Boolean(receipt?.before_hash && receipt?.after_hash);
  const hashesEqual = hashesPresent && receipt.before_hash === receipt.after_hash;
  if (claimedApplied) {
    if (!receipt.applied_at) findings.receipt.push('applied_without_applied_at');
    else if (!validInstant(receipt.applied_at)) findings.receipt.push('applied_at_invalid');
    else if (validInstant(receipt.received_at) && Date.parse(receipt.applied_at) < Date.parse(receipt.received_at)) findings.receipt.push('applied_before_received');
    if (!receipt.readback_verified) findings.receipt.push('applied_without_readback');
    if (expectedTarget && target !== expectedTarget) findings.receipt.push('target_task_mismatch');
    if (!hashesPresent) findings.insufficient.push('card_hash_missing');
    else if (noChange && !hashesEqual) findings.declaration.push('hash_changed_but_no_change_expected');
  }
  // A name-only match to an already-closed card is not an instruction to reopen or extend it.
  const reopenWithoutOwner = Boolean(card?.status === 'Done' && checkable && assertions.status !== 'Done' && !confirmation);
  if (reopenWithoutOwner) findings.owner.push('owner_target_confirmation_required');
  if (!checkable) findings.insufficient.push('no_card_assertions_content_unverifiable');
  else if (!card) findings.insufficient.push('card_not_read_back');
  else { const check = assertionCheck(assertions, card); findings.content.push(...check.failures); findings.insufficient.push(...check.indeterminate); }
  if (displayed !== undefined && checkable) stages.displayed = assertionCheck(assertions, displayed).failures.length === 0;

  let verdict;
  if (integrityProblem) verdict = 'inbox_integrity_error';
  else if (reopenWithoutOwner) verdict = 'needs_owner_decision';
  else if (!receipt) verdict = 'saved_not_received';
  else if (!claimedApplied) verdict = 'received_not_applied';
  else if (findings.receipt.length) verdict = 'receipt_inconsistent';
  else if (findings.content.length) verdict = 'mismatch_content_not_reflected';
  else if (findings.declaration.length) verdict = 'declaration_inconsistent';
  else if (findings.insufficient.length) verdict = 'unverified';
  else if (!noChange && hashesEqual) verdict = 'content_present_no_recorded_change';
  else { stages.applied_to_task = true; verdict = stages.displayed === false ? 'applied_not_displayed' : 'applied_verified'; }
  const problems = [...new Set([...(integrityProblem ? ['packet_hash_or_batch_id_mismatch'] : []), ...Object.values(findings).flat(), ...(!noChange && hashesEqual ? ['card_hash_unchanged'] : [])])];
  return {event_id: delta.event_id, verdict, stages, findings, problems};
}

// Batch state is derived from its deltas; the inbox's own `application_state` is never trusted on its own.
export const batchVerdict = results => !results.length ? 'unverified'
  : results.every(r => r.verdict === 'applied_verified') ? 'applied_verified'
  : results.some(r => ['mismatch_content_not_reflected', 'receipt_inconsistent', 'declaration_inconsistent', 'inbox_integrity_error'].includes(r.verdict)) ? 'mismatch'
  : results.some(r => r.verdict === 'needs_owner_decision') ? 'needs_owner_decision'
  : results.every(r => ['unverified', 'content_present_no_recorded_change', 'applied_verified'].includes(r.verdict)) ? 'unverified'
  : 'not_fully_applied';

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
// --confirmations <file> supplies existing owner-confirmation records (see findOwnerConfirmation); without it none are assumed.
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
      console.log(JSON.stringify({batch_id: batch.batch_id, inbox_state: batch.application_state, verified: batchVerdict(results), deltas: results.map(r => ({event_id: r.event_id, verdict: r.verdict, problems: r.problems}))}));
    } catch { console.log(JSON.stringify({batch_id: batch.batch_id, verified: 'packet_unparseable'})); }
  }
}
