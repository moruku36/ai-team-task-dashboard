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

// Opt-in structured expectations carried by a delta: what the card must say once the delta is really applied.
//   card_assertions: {status?, due_at?, blocked?: boolean, blocker_summary?, must_include?: string[], expects_no_card_change?}
//   expects_no_card_change: true is the ONLY exception to the hash rule (before/after hashes may then be equal or absent);
//   the real card must still satisfy every other assertion. Without it, missing hashes => unverified, equal hashes => no recorded change.
// Packets without assertions can only ever be "received", never "applied_verified".
export function assertionFailures(assertions, card) {
  const failures = [];
  if (!card) return ['card_missing'];
  const body = `${card.title ?? ''}\n${card.body ?? ''}`;
  if (assertions.status !== undefined && card.status !== assertions.status) failures.push('status_mismatch');
  if (assertions.due_at) {
    const day = String(assertions.due_at).slice(0, 10), [, m, d] = day.split('-');
    if (!(has(body, day) || has(body, `${m}/${d}`) || has(body, `${Number(m)}/${Number(d)}`) || has(body, `${Number(m)}月${Number(d)}日`))) failures.push('due_at_not_on_card');
  }
  if (assertions.blocked === true && card.status !== 'Blocked' && !has(body, 'blocked') && !has(body, '阻害')) failures.push('blocked_not_on_card');
  if (assertions.blocker_summary && !has(body, assertions.blocker_summary)) failures.push('blocker_summary_not_on_card');
  for (const text of assertions.must_include ?? []) if (!text || !has(body, text)) failures.push('required_text_missing');
  return failures;
}

// An assertion object that checks nothing (`{}`, empty strings) must not count as a verification.
export const meaningfulAssertions = a => Boolean(a && typeof a === 'object' && (a.status !== undefined || a.due_at || a.blocked === true || a.blocker_summary || (Array.isArray(a.must_include) && a.must_include.length)));
// Problems with the receipt itself: it may not be the receipt for this event/batch, so nothing it says can be trusted.
// Strict ISO-8601 instant with an explicit zone and a real calendar date; anything else is "not a time".
export const validInstant = value => {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, sec = 0] = m.slice(1).map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && h <= 23 && mi <= 59 && sec <= 59 && Number.isFinite(Date.parse(value));
};
const receiptProblems = ['receipt_identity_mismatch', 'received_at_invalid', 'source_instruction_at_changed', 'source_instruction_at_missing_in_receipt', 'applied_at_invalid', 'applied_before_received', 'applied_without_applied_at', 'applied_without_readback', 'target_task_mismatch'];

// `card` MUST be read back from the official source (CLI/API) by the caller, never taken from the packet or the receipt:
// `card_assertions` are only the packet's *expectations*; they count for nothing until compared with the real card text.
// `displayed` is the card as the dashboard shows it (optional: without it the screen stage stays "unknown").
//
// Verdicts keep "not verified" apart from "contradicted":
//   unverified                       - claimed applied, but there is nothing to compare with (no assertions / card not read back).
//                                      Typical for packets written before card_assertions existed; NOT treated as broken.
//   mismatch_content_not_reflected   - claimed applied and the real card contradicts the packet's assertions.
//   receipt_inconsistent             - the receipt itself is malformed (no applied_at/readback, wrong target).
export function verifyDelta({batch, packetBytes, packet, delta, receipt, card, displayed}) {
  const problems = [];
  const stages = {saved_to_inbox: false, received: false, applied_to_task: false, displayed: 'unknown'};
  stages.saved_to_inbox = Boolean(batch && packetBytes && sha256(packetBytes) === batch.packet_sha256 && packet?.batch_id === batch.batch_id);
  if (!stages.saved_to_inbox) problems.push('packet_hash_or_batch_id_mismatch');
  if (receipt) {
    stages.received = receipt.event_id === delta.event_id && receipt.batch_id === packet?.batch_id;
    if (!stages.received) problems.push('receipt_identity_mismatch');
    if (!validInstant(receipt.received_at)) problems.push('received_at_invalid');
    if (!validInstant(receipt.received_at)) stages.received = false;
    if (!packet?.source_instruction_at || !validInstant(packet.source_instruction_at)) problems.push('source_instruction_at_missing_in_packet');
    else if (!validInstant(receipt.source_instruction_at)) problems.push('source_instruction_at_missing_in_receipt');
    else if (Date.parse(receipt.source_instruction_at) !== Date.parse(packet.source_instruction_at)) problems.push('source_instruction_at_changed');
  }
  const assertions = delta.card_assertions, checkable = meaningfulAssertions(assertions);
  const claimedApplied = receipt?.application_state === 'applied';
  const target = receipt?.target_task_id ?? receipt?.task_id;
  const expectedTarget = delta.owner_confirmed_target_task_id ?? delta.target_id_hint;
  const hashesPresent = Boolean(receipt?.before_hash && receipt?.after_hash);
  const hashUnchanged = Boolean(claimedApplied && hashesPresent && receipt.before_hash === receipt.after_hash);
  if (claimedApplied) {
    if (!receipt.applied_at) problems.push('applied_without_applied_at');
    else if (!validInstant(receipt.applied_at)) problems.push('applied_at_invalid');
    else if (validInstant(receipt.received_at) && Date.parse(receipt.applied_at) < Date.parse(receipt.received_at)) problems.push('applied_before_received');
    if (!receipt.readback_verified) problems.push('applied_without_readback');
    if (expectedTarget && target !== expectedTarget) problems.push('target_task_mismatch');
    if (!hashesPresent) problems.push('card_hash_missing');
    else if (hashUnchanged) problems.push('card_hash_unchanged');
  }
  // A name-only match to an already-closed card is not an instruction to reopen or extend it.
  const reopenWithoutOwner = Boolean(card?.status === 'Done' && checkable && assertions.status !== 'Done' && !delta.owner_confirmed_target_task_id);
  if (reopenWithoutOwner) problems.push('owner_target_confirmation_required');
  let failures = [];
  if (!checkable) problems.push('no_card_assertions_content_unverifiable');
  else if (!card) problems.push('card_not_read_back');
  else { failures = assertionFailures(assertions, card); problems.push(...failures); }
  const contentMatches = checkable && Boolean(card) && failures.length === 0;
  if (displayed !== undefined && checkable) stages.displayed = assertionFailures(assertions, displayed).length === 0;
  let verdict;
  if (!stages.saved_to_inbox) verdict = 'inbox_integrity_error';
  else if (reopenWithoutOwner) verdict = 'needs_owner_decision';
  else if (!receipt) verdict = 'saved_not_received';
  else if (!claimedApplied) verdict = 'received_not_applied';
  else if (problems.some(p => receiptProblems.includes(p))) verdict = 'receipt_inconsistent';
  else if (!checkable || !card || problems.includes('source_instruction_at_missing_in_packet')) verdict = 'unverified';
  else if (!contentMatches) verdict = 'mismatch_content_not_reflected';
  else if (assertions.expects_no_card_change !== true && !hashesPresent) verdict = 'unverified'; // content matches, but there is no change evidence to credit this event
  else if (assertions.expects_no_card_change !== true && hashUnchanged) verdict = 'content_present_no_recorded_change';
  else { stages.applied_to_task = true; verdict = stages.displayed === false ? 'applied_not_displayed' : 'applied_verified'; }
  return {event_id: delta.event_id, verdict, stages, problems: [...new Set(problems)]};
}

// Batch state is derived from its deltas; the inbox's own `application_state` is never trusted on its own.
export const batchVerdict = results => !results.length ? 'unverified'
  : results.every(r => r.verdict === 'applied_verified') ? 'applied_verified'
  : results.some(r => ['mismatch_content_not_reflected', 'receipt_inconsistent', 'inbox_integrity_error'].includes(r.verdict)) ? 'mismatch'
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const take = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const map = take('--map'), cardsPath = take('--cards'), [inboxPath] = args;
  if (!inboxPath) throw new Error('Usage: node scripts/inbox-receipt-verify.mjs <dot-inbox.json> [--cards <cards.json>] [--map <recorded-prefix>=<actual-prefix>]');
  const [from, to] = map ? map.split('=') : [];
  const remap = p => from && p.toLowerCase().startsWith(from.toLowerCase()) ? to + p.slice(from.length) : p;
  const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const cards = cardsPath ? read(cardsPath) : {};
  for (const batch of read(inboxPath).batches) {
    let bytes;
    try { bytes = readFileSync(remap(batch.packet_path)); } catch { console.log(JSON.stringify({batch_id: batch.batch_id, verified: 'packet_path_unreachable'})); continue; }
    try {
      const packet = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      const results = (packet.deltas ?? []).map(delta => {
        let receipt; try { receipt = read(join(remap(batch.receipt_directory), `${delta.event_id}.json`)); } catch { /* no receipt yet */ }
        return verifyDelta({batch, packetBytes: bytes, packet, delta, receipt, card: cards[receipt?.target_task_id ?? delta.target_id_hint]});
      });
      console.log(JSON.stringify({batch_id: batch.batch_id, inbox_state: batch.application_state, verified: batchVerdict(results), deltas: results.map(r => ({event_id: r.event_id, verdict: r.verdict, problems: r.problems}))}));
    } catch { console.log(JSON.stringify({batch_id: batch.batch_id, verified: 'packet_unparseable'})); }
  }
}
