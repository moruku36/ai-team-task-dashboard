// Pure decision layer between the inbox, the card, the receipt and the public read-back. It reads no file, store, ledger or network and writes nothing:
// every input is passed in and every result is a DECISION the existing updater may act on. It adds no job, schedule, permission or setting.
//
// Contract (inbox schema_version 1): packets are immutable; batch_id and every delta.event_id are unique; the packet's SHA-256 and duplicates are checked on reception;
// conflicts and uncertainty are rejected or kept `pending`; receipt states are received_unapplied / pending / conflict / applied; `applied` needs the target task id, before/after hashes,
// a formal card read-back, a real applied_at and the owner's basis; a re-run is idempotent against the existing receipt; saving to the inbox or the packet's existence is never evidence
// that the card changed. The four facts stay separate: saved to the inbox -> received -> applied to the task -> shown on the public board.
import {sha256, verifyDelta, planApply, validInstant, matchOwnerConfirmation} from './inbox-receipt-verify.mjs';
import {TextDecoder, isDeepStrictEqual} from 'node:util';

export const RECEIPT_STATES = Object.freeze(['received_unapplied', 'pending', 'conflict', 'applied']);
const BATCH_STATES = new Set(['unapplied', ...RECEIPT_STATES]);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : null;   // only identifier-shaped text is ever echoed back
const HEX64 = /^[0-9a-f]{64}$/i;

// ---- 1. The inbox file --------------------------------------------------------------------------------------------------
// Validates the shape only; paths are never opened or echoed. A duplicate batch_id removes every copy (which one is real cannot be known).
export function parseInbox(inbox) {
  if (!isObject(inbox) || inbox.schema_version !== 1 || !Array.isArray(inbox.batches)) return {ok: false, batches: [], problems: [{index: null, batch_id: null, reasons: ['inbox_schema_unsupported']}]};
  const counts = new Map();
  for (const batch of inbox.batches) if (isObject(batch) && typeof batch.batch_id === 'string') counts.set(batch.batch_id, (counts.get(batch.batch_id) ?? 0) + 1);
  const batches = [], problems = [];
  inbox.batches.forEach((batch, index) => {
    const reasons = [];
    if (!isObject(batch)) reasons.push('batch_not_object');
    else {
      if (!safeId(batch.batch_id)) reasons.push('batch_id_invalid'); else if (counts.get(batch.batch_id) > 1) reasons.push('duplicate_batch_id');
      for (const key of ['packet_path', 'receipt_directory']) if (typeof batch[key] !== 'string' || !batch[key].trim()) reasons.push(`${key}_invalid`);
      if (typeof batch.packet_sha256 !== 'string' || !HEX64.test(batch.packet_sha256)) reasons.push('packet_sha256_invalid');
      if (!validInstant(batch.source_instruction_at)) reasons.push('source_instruction_at_invalid');
      // Historical aggregates are not proof of application, but they are valid inbox records.
      // Keep them available for per-event receipt/card re-verification instead of rejecting the whole inbox.
      if (!BATCH_STATES.has(batch.application_state)) reasons.push('application_state_invalid');
    }
    if (reasons.length) problems.push({index, batch_id: safeId(batch?.batch_id), reasons}); else batches.push(batch);
  });
  return {ok: problems.length === 0, batches, problems};
}

// ---- 2. Reception ---------------------------------------------------------------------------------------------------------
// -> {accepted, reasons, events: [{event_id, action, reason?}]}. Actions: record_received | continue | skip_duplicate | pending | conflict.
// No action here is `applied`: reception never proves a card change. A rejected batch has no events at all.
export function planReception({batch, packetBytes, packet, inboxBatches = [], ledger = {}, receipts = {}}) {
  const reject = reason => ({accepted: false, reasons: [reason], events: []});
  if (!isObject(batch) || !packetBytes) return reject('packet_unreadable');
  if (typeof batch.packet_sha256 !== 'string' || sha256(packetBytes) !== batch.packet_sha256.toLowerCase()) return reject('packet_hash_mismatch');
  if (!isObject(packet) || packet.schema_version !== 1) return reject('packet_schema_unsupported');
  if (!safeId(batch.batch_id) || packet.batch_id !== batch.batch_id) return reject('batch_id_mismatch');
  if (!BATCH_STATES.has(batch.application_state)) return reject('application_state_invalid');
  if (!Array.isArray(packet.deltas) || !packet.deltas.length) return reject('no_deltas');
  if (!validInstant(batch.source_instruction_at) || !validInstant(packet.source_instruction_at)) return reject('source_instruction_at_invalid');
  if (Date.parse(batch.source_instruction_at) !== Date.parse(packet.source_instruction_at)) return reject('source_instruction_at_mismatch');
  // planReception is independently callable; do not rely on parseInbox or planApply to validate its deltas.
  if (packet.deltas.some(delta => !isObject(delta) || !safeId(delta.event_id))) return reject('event_id_invalid');
  // The verified bytes and the separately supplied parsed argument must describe the same packet.
  // Strict UTF-8 prevents replacement decoding from making corrupt bytes appear like valid JSON.
  let decodedPacket;
  try { decodedPacket = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(packetBytes)); }
  catch { return reject('packet_json_invalid'); }
  if (!isDeepStrictEqual(decodedPacket, packet)) return reject('packet_content_mismatch');
  const plan = planApply(ledger, packet, inboxBatches);
  if (plan.length === 1 && plan[0].event_id === null && plan[0].reason === 'duplicate_batch_id_in_inbox') return reject('duplicate_batch_id_in_inbox');
  const events = plan.map(step => {
    const id = safeId(step.event_id), receipt = id && Object.hasOwn(receipts, step.event_id) ? receipts[step.event_id] : undefined;
    if (step.action === 'conflict') return {event_id: id, action: 'conflict', reason: step.reason};
    if (receipt && (!isObject(receipt) || receipt.event_id !== step.event_id || receipt.batch_id !== packet.batch_id)) return {event_id: id, action: 'conflict', reason: 'receipt_identity_mismatch'};
    if (receipt && !RECEIPT_STATES.includes(receipt.application_state)) return {event_id: id, action: 'conflict', reason: 'receipt_state_invalid'};
    if (step.action === 'skip_duplicate') return {event_id: id, action: 'skip_duplicate', reverify: true};   // idempotent re-run: skipped, but the card is still re-checked
    if (!receipt) return {event_id: id, action: 'record_received'};
    if (receipt.application_state === 'applied') return {event_id: id, action: 'pending', reason: 'applied_receipt_without_ledger_entry'};
    return {event_id: id, action: 'continue'};
  });
  return {accepted: true, reasons: [], events};
}

// ---- 3. The public read-back ----------------------------------------------------------------------------------------------
// A card from the public /api/tasks snapshot (`detail`) in the verifier's card shape (`body`). Absent, duplicated or malformed -> undefined (never success).
// `legacyStatus` is carried along: the snapshot shows a legacy card under its mapped column, which is not a persisted status.
export function snapshotCard(snapshot, id) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.tasks) || typeof id !== 'string') return undefined;
  const matches = snapshot.tasks.filter(task => isObject(task) && task.id === id);
  if (matches.length !== 1 || typeof matches[0].detail !== 'string' || typeof matches[0].status !== 'string') return undefined;
  const {title, status, detail, version, legacyStatus} = matches[0];
  return {id, title, status, body: detail, version, ...(legacyStatus ? {legacyStatus} : {})};
}

// ---- 4. Receipt decision --------------------------------------------------------------------------------------------------
// Inputs: everything verifyDelta takes (batch, packetBytes, packet, delta, receipt = the EXISTING receipt, card = the formal read-back, priorCard, displayed, ownerConfirmations, now)
// plus `hashCard` (card -> SHA-256 hex, the receipt contract's own algorithm, supplied by an independent caller; this module does not know it) or ready `recomputedHashes`.
// -> {verdict, recordState, action, receipt, problems}. recordState is null when nothing may be recorded.
//   action: write | keep (already what the existing receipt says: idempotent, nothing rewritten) | flag_downgrade (an `applied` receipt that the evidence no longer supports; never kept silently)
//           | none | reject.
// `applied` is only ever proposed when verifyDelta reaches applied_verified / applied_not_displayed AND the owner's basis (delta.source_message_ids) is present AND the card
// is the target task's, read back as a persisted (non-legacy-mapped) status. A missing algorithm, hash, read-back, time or basis can only leave the receipt pending.
const STATE_OF_VERDICT = {applied_verified: 'applied', applied_not_displayed: 'applied', received_not_applied: 'received_unapplied', needs_owner_decision: 'pending', unverified: 'pending',
  content_present_no_recorded_change: 'pending', mismatch_content_not_reflected: 'conflict', receipt_inconsistent: 'conflict', declaration_inconsistent: 'conflict'};
const hasBasis = delta => Array.isArray(delta?.source_message_ids) && delta.source_message_ids.length > 0 && delta.source_message_ids.every(id => typeof id === 'string' && id.trim());
// `receipt` is the receipt being judged: one already on disk, or the updater's CANDIDATE `applied` receipt before it is written. `persistedState` is the state currently on disk
// (undefined when there is none); it defaults to the judged receipt's own state, which is right when the receipt is already persisted.
export function decideReceipt({hashCard, recomputedHashes, persistedState: givenState, ...evidence}) {
  const {delta, receipt: existing} = evidence, extra = [];
  const persistedState = givenState === undefined && !('persistedState' in arguments[0]) ? existing?.application_state : givenState;
  let {card, priorCard} = evidence;
  const target = existing?.target_task_id ?? existing?.task_id ?? delta?.target_id_hint;
  // The read-back and the prior state must both be the target task's card (the verifier cannot tell).
  if (existing?.application_state === 'applied' && (!target || card?.id !== target || priorCard?.id !== target)) { extra.push('card_target_unconfirmed'); card = undefined; priorCard = undefined; }
  let hashes = recomputedHashes;
  if (!hashes && typeof hashCard === 'function' && card && priorCard) { try { hashes = {before: hashCard(priorCard), after: hashCard(card)}; } catch { extra.push('hash_recompute_failed'); } }
  // Without a receipt, or with one lacking a valid applied_at, an owner record cannot be ordered against the application: records are not offered then, so the verdict stays
  // saved_not_received / receipt_inconsistent rather than turning into an owner question.
  const result = verifyDelta({...evidence, ...(existing && validInstant(existing.applied_at) ? {} : {ownerConfirmations: undefined}), card, priorCard, recomputedHashes: hashes});
  const problems = [...new Set([...result.problems, ...extra])];
  if (result.verdict === 'inbox_integrity_error') return {verdict: result.verdict, recordState: null, action: 'reject', receipt: null, problems};
  if (result.verdict === 'saved_not_received') return {verdict: result.verdict, recordState: null, action: 'none', receipt: null, problems};
  let recordState = STATE_OF_VERDICT[result.verdict] ?? 'pending';
  // A receipt already marked pending or conflict keeps that mark until evidence says otherwise: re-running never quietly clears it.
  if (result.verdict === 'received_not_applied' && ['pending', 'conflict'].includes(persistedState)) recordState = persistedState;
  // The owner's basis is a RECORD {event_id, task_id, confirmed_at, basis_id} supplied by the caller (evidence.ownerConfirmations), not a field the packet claims for itself:
  // same event, same target task, basis_id one of the delta's source_message_ids, and source_instruction_at <= confirmed_at <= applied_at (nothing in the future).
  if (recordState === 'applied') {
    if (!hasBasis(delta)) { recordState = 'pending'; problems.push('owner_basis_missing'); }
    else {
      const owner = matchOwnerConfirmation(evidence.ownerConfirmations, delta, {target, packet: evidence.packet, receipt: existing, now: evidence.now});
      if (!owner.record) { recordState = 'pending'; problems.push('owner_record_missing_or_mismatched', ...owner.rejected); }
    }
  }
  if (recordState === 'applied' && card?.legacyStatus && delta?.card_assertions?.status !== undefined) { recordState = 'pending'; problems.push('status_not_persisted_legacy'); }
  const previous = persistedState;
  const action = previous === recordState ? 'keep' : previous === 'applied' ? 'flag_downgrade' : 'write';
  // The proposed receipt only carries fields already present on the existing receipt (no time, hash or read-back flag is ever invented).
  const keep = ['event_id', 'batch_id', 'received_at', 'source_instruction_at', 'target_task_id'];
  const proposed = Object.fromEntries(keep.filter(key => existing?.[key] !== undefined).map(key => [key, existing[key]]));
  Object.assign(proposed, {event_id: proposed.event_id ?? delta?.event_id, batch_id: proposed.batch_id ?? evidence.packet?.batch_id, application_state: recordState});
  if (recordState === 'applied') Object.assign(proposed, {applied_at: existing.applied_at, before_hash: existing.before_hash, after_hash: existing.after_hash, readback_verified: true});
  return {verdict: result.verdict, recordState, action, receipt: action === 'keep' ? null : proposed, problems: [...new Set(problems)]};
}

// The receipt the existing updater stores uses other names than the verifier: before_sha256 / after_sha256 / official_cli_readback. This maps NAMES only.
// It never sets readback_verified, never invents a time, and does not treat official_cli_readback as the public-card read-back: the hashes still have to be recomputed from
// real bytes by the caller (hashCard / recomputedHashes) and the card read back through snapshotCard before anything can reach `applied`.
export function fromStoredReceipt(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {receipt: undefined, unmapped: []};
  const {before_sha256, after_sha256, official_cli_readback, ...rest} = stored, receipt = {...rest};
  if (before_sha256 !== undefined && receipt.before_hash === undefined) receipt.before_hash = before_sha256;
  if (after_sha256 !== undefined && receipt.after_hash === undefined) receipt.after_hash = after_sha256;
  return {receipt, unmapped: official_cli_readback === undefined ? [] : ['official_cli_readback']};
}
