// Synthetic, focused tests for scripts/inbox-apply-contract.mjs. No real inbox, packet, receipt, ledger, card text, path or credential is used.
// `hashCard` below is a TEST-ONLY algorithm: the real receipt-contract hash is not public, which is why decideReceipt takes it as an injected input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256, deltaFingerprint} from '../scripts/inbox-receipt-verify.mjs';
import {parseInbox, planReception, snapshotCard, decideReceipt, fromStoredReceipt, RECEIPT_STATES} from '../scripts/inbox-apply-contract.mjs';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const hashCard = card => sha256(JSON.stringify([card.id, card.status, card.body]));
const delta = {event_id: 'synth-event-1', target_id_hint: 'SYNTH-17', source_message_ids: ['msg-1'], card_assertions: {status: 'Blocked', due_at: '2026-10-22', blocker_summary: 'CLI DNS'}};
const delta2 = {event_id: 'synth-event-2', target_id_hint: 'SYNTH-18', source_message_ids: ['msg-2']};
const packet = {schema_version: 1, batch_id: 'synth-batch-1', source_instruction_at: '2026-10-21T07:44:42Z', deltas: [delta, delta2]};
const packetBytes = Buffer.from(JSON.stringify(packet));
const batch = {batch_id: packet.batch_id, packet_path: 'synthetic/packet.json', packet_sha256: sha256(packetBytes), source_instruction_at: packet.source_instruction_at, receipt_directory: 'synthetic/receipts', application_state: 'unapplied'};
const priorCard = {id: 'SYNTH-17', title: 'Synthetic', status: 'In Progress', body: 'earlier'};
const goodCard = {id: 'SYNTH-17', title: 'Synthetic', status: 'Blocked', body: 'Due: 2026-10-22\nBlocker: CLI DNS resolution fails'};
const staleCard = {...goodCard, status: 'In Progress', body: 'Nothing about a deadline.'};
const appliedReceipt = (over = {}) => ({event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'applied', received_at: '2026-10-21T09:03:36Z', applied_at: '2026-10-21T09:14:00Z',
  target_task_id: 'SYNTH-17', before_hash: hashCard(priorCard), after_hash: hashCard(goodCard), readback_verified: true, source_instruction_at: packet.source_instruction_at, ...over});
const ownerRecord = (over = {}) => ({event_id: delta.event_id, task_id: 'SYNTH-17', confirmed_at: '2026-10-21T08:00:00Z', basis_id: 'msg-1', ...over});
const decide = (over = {}) => decideReceipt({batch, packetBytes, packet, delta, receipt: appliedReceipt(), card: goodCard, priorCard, hashCard, ownerConfirmations: [ownerRecord()], now: NOW, ...over});

test('parseInbox: schema_version 1 with every contract field; invalid, duplicate or unexpected batches are excluded and never echo paths', () => {
  const ok = parseInbox({schema_version: 1, batches: [batch]});
  assert.deepEqual([ok.ok, ok.batches.length, ok.problems.length], [true, 1, 0]);
  for (const bad of [null, {schema_version: 2, batches: []}, {schema_version: 1}, {schema_version: 1, batches: 'x'}]) assert.deepEqual(parseInbox(bad).problems[0].reasons, ['inbox_schema_unsupported']);
  const broken = parseInbox({schema_version: 1, batches: [{...batch, batch_id: 'b-2', packet_sha256: 'zz'}, {...batch, batch_id: 'b-3', receipt_directory: ''}, {...batch, batch_id: 'b-4', source_instruction_at: 'tomorrow'},
    {...batch, batch_id: 'b-5', application_state: 'unknown'}, {...batch, batch_id: 'dup'}, {...batch, batch_id: 'dup'}, null, {...batch, batch_id: 'bad id/../x'}]});
  assert.equal(broken.ok, false); assert.equal(broken.batches.length, 0);
  const why = Object.fromEntries(broken.problems.map(p => [p.batch_id ?? `#${p.index}`, p.reasons]));
  assert.deepEqual(why['b-2'], ['packet_sha256_invalid']); assert.deepEqual(why['b-3'], ['receipt_directory_invalid']); assert.deepEqual(why['b-4'], ['source_instruction_at_invalid']);
  assert.deepEqual(why['b-5'], ['application_state_invalid']); assert.deepEqual(why['dup'], ['duplicate_batch_id']); assert.deepEqual(why['#6'], ['batch_not_object']); assert.ok(why['#7'].includes('batch_id_invalid'));
  assert.doesNotMatch(JSON.stringify(broken), /synthetic\/packet\.json|synthetic\/receipts/);
});

test('parseInbox: valid historical aggregate states coexist with new unapplied work without becoming application evidence', () => {
  const states = ['unapplied', ...RECEIPT_STATES];
  const mixed = states.map((application_state, index) => ({...batch, batch_id: `synth-history-${index}`, application_state}));
  const result = parseInbox({schema_version: 1, batches: mixed});
  assert.equal(result.ok, true); assert.equal(result.batches.length, states.length); assert.deepEqual(result.problems, []);
  assert.deepEqual(result.batches.map(b => b.application_state), states);
  const historical = {...batch, application_state: 'applied'};
  const reception = planReception({batch: historical, packetBytes, packet});
  assert.equal(reception.accepted, true);
  assert.deepEqual(reception.events.map(e => e.action), ['record_received', 'record_received'], 'an aggregate alone never skips or applies an event');
  const duplicates = parseInbox({schema_version: 1, batches: [batch, {...batch, application_state: 'applied'}]});
  assert.equal(duplicates.ok, false); assert.equal(duplicates.batches.length, 0);
  assert.ok(duplicates.problems.every(p => p.reasons.includes('duplicate_batch_id')));
});

test('planReception: standalone calls reject unsupported schema, unknown times, malformed event IDs and unknown receipt states', () => {
  const reception = (candidate, batchOverrides = {}, receipts = {}) => {
    const bytes = Buffer.from(JSON.stringify(candidate));
    return planReception({batch: {...batch, packet_sha256: sha256(bytes), ...batchOverrides}, packetBytes: bytes, packet: candidate, receipts});
  };
  for (const schema_version of [undefined, 2, '1', null]) {
    assert.deepEqual(reception({...packet, schema_version}).reasons, ['packet_schema_unsupported']);
  }
  for (const source_instruction_at of [null, undefined, 'tomorrow', '2026-02-30T00:00:00Z']) {
    assert.deepEqual(reception({...packet, source_instruction_at}).reasons, ['source_instruction_at_invalid']);
    assert.deepEqual(reception(packet, {source_instruction_at}).reasons, ['source_instruction_at_invalid']);
  }
  for (const event of [null, 42, [], {}, {...delta, event_id: 'bad/id'}, {...delta, event_id: ' '}, {...delta, event_id: 7}]) {
    const result = reception({...packet, deltas: [event]});
    assert.deepEqual(result, {accepted: false, reasons: ['event_id_invalid'], events: []});
  }
  assert.deepEqual(reception(packet, {application_state: 'unknown'}).reasons, ['application_state_invalid']);
  const receipt = {...appliedReceipt(), application_state: 'unknown'};
  assert.deepEqual(reception(packet, {}, {[delta.event_id]: receipt}).events[0], {event_id: delta.event_id, action: 'conflict', reason: 'receipt_state_invalid'});
});

test('planReception: the hash-verified UTF-8 JSON bytes and the parsed packet must agree semantically', () => {
  const reception = (bytes, candidate = packet) => planReception({batch: {...batch, packet_sha256: sha256(bytes)}, packetBytes: bytes, packet: candidate});
  const other = {...packet, deltas: [{...delta, target_id_hint: 'SYNTH-99'}, delta2]};
  assert.deepEqual(reception(packetBytes, other), {accepted: false, reasons: ['packet_content_mismatch'], events: []}, 'a valid hash cannot authorize a different target');
  assert.deepEqual(reception(packetBytes, {...packet, deltas: [{...delta, summary: 'different instruction'}, delta2]}).reasons, ['packet_content_mismatch']);
  const reordered = {deltas: packet.deltas.map(d => Object.fromEntries(Object.entries(d).reverse())), source_instruction_at: packet.source_instruction_at, batch_id: packet.batch_id, schema_version: packet.schema_version};
  const formatted = Buffer.from(JSON.stringify(reordered, null, 4));
  assert.equal(reception(formatted).accepted, true, 'JSON whitespace and object-key order do not change the instruction');
  assert.equal(reception(packetBytes, reordered).accepted, true, 'the parsed argument may have a different key order');
  for (const bytes of [Buffer.from('{invalid json'), Buffer.concat([packetBytes.subarray(0, -1), Buffer.from(',"invalid":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
    assert.deepEqual(reception(bytes), {accepted: false, reasons: ['packet_json_invalid'], events: []}, 'matching hashes do not make invalid JSON or corrupt UTF-8 acceptable');
  }
});

test('planReception: a verified packet is only RECEIVED; tampering, id mismatch, duplicates and conflicts are rejected or conflict; nothing is ever "applied"', () => {
  const base = {batch, packetBytes, packet, inboxBatches: [batch]};
  const ok = planReception(base);
  assert.deepEqual([ok.accepted, ok.events.map(e => e.action)], [true, ['record_received', 'record_received']]);
  assert.ok(!JSON.stringify(ok).includes('applied'));
  assert.deepEqual(planReception({...base, packetBytes: Buffer.from('tampered')}).reasons, ['packet_hash_mismatch']);
  assert.deepEqual(planReception({...base, packet: {...packet, batch_id: 'other'}}).reasons, ['batch_id_mismatch']);
  assert.deepEqual(planReception({...base, packet: {...packet, deltas: []}}).reasons, ['no_deltas']);
  assert.deepEqual(planReception({...base, packet: {...packet, source_instruction_at: '2026-10-21T07:44:43Z'}}).reasons, ['source_instruction_at_mismatch'], 'the inbox record and the packet must agree on the instruction time');
  assert.deepEqual(planReception({...base, packetBytes: Buffer.from(JSON.stringify({...packet, source_instruction_at: '2026-10-21T07:44:43Z'}))}).reasons, ['packet_hash_mismatch'], 'any edit of the immutable packet bytes is caught by the hash');
  assert.deepEqual(planReception({...base, inboxBatches: [batch, batch]}).reasons, ['duplicate_batch_id_in_inbox']);
  const dupEvent = {...packet, deltas: [delta, delta]}, dupBytes = Buffer.from(JSON.stringify(dupEvent));
  const dup = planReception({batch: {...batch, packet_sha256: sha256(dupBytes)}, packetBytes: dupBytes, packet: dupEvent, inboxBatches: [batch]});
  assert.deepEqual(dup.events.map(e => [e.action, e.reason]), [['record_received', undefined], ['conflict', 'missing_or_duplicate_event_id']]);
  const again = planReception({...base, ledger: {[delta.event_id]: deltaFingerprint(delta)}});
  assert.deepEqual(again.events.map(e => e.action), ['skip_duplicate', 'record_received']); assert.equal(again.events[0].reverify, true);
  const changed = planReception({...base, ledger: {[delta.event_id]: 'f'.repeat(64)}});
  assert.deepEqual([changed.events[0].action, changed.events[0].reason], ['conflict', 'same_event_id_different_content']);
  const foreign = planReception({...base, receipts: {[delta.event_id]: {event_id: delta.event_id, batch_id: 'another-batch', application_state: 'received_unapplied'}}});
  assert.deepEqual([foreign.events[0].action, foreign.events[0].reason], ['conflict', 'receipt_identity_mismatch']);
  assert.equal(planReception({...base, receipts: {[delta.event_id]: {event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'received_unapplied'}}}).events[0].action, 'continue');
  assert.deepEqual(planReception({...base, receipts: {[delta.event_id]: appliedReceipt()}}).events[0], {event_id: delta.event_id, action: 'pending', reason: 'applied_receipt_without_ledger_entry'}, 'an applied receipt with no ledger entry is not trusted');
});

test('snapshotCard: the public snapshot card (detail) becomes the verifier card (body); absent, duplicated or malformed cards are undefined', () => {
  const snap = {tasks: [{id: 'SYNTH-17', title: 'T', status: 'Blocked', detail: 'text', version: 4}, {id: 'SYNTH-DUP', title: 'a', status: 'To Do', detail: '', version: 1}, {id: 'SYNTH-DUP', title: 'b', status: 'To Do', detail: '', version: 1}, {id: 'SYNTH-BAD', title: 'c', status: 'To Do', detail: 5}, {id: 'SYNTH-LEG', title: 'l', status: 'Blocked', detail: '', version: 2, legacyStatus: 'Awaiting Approval'}]};
  assert.deepEqual(snapshotCard(snap, 'SYNTH-17'), {id: 'SYNTH-17', title: 'T', status: 'Blocked', body: 'text', version: 4});
  for (const id of ['NOPE', 'SYNTH-DUP', 'SYNTH-BAD', 7]) assert.equal(snapshotCard(snap, id), undefined, String(id));
  assert.equal(snapshotCard({tasks: 'x'}, 'SYNTH-17'), undefined); assert.equal(snapshotCard(null, 'SYNTH-17'), undefined);
  assert.equal(snapshotCard(snap, 'SYNTH-LEG').legacyStatus, 'Awaiting Approval');
});

test('decideReceipt: full evidence yields applied; the same inputs again are idempotent (keep, nothing rewritten)', () => {
  const first = decide({receipt: appliedReceipt({application_state: 'received_unapplied'})});
  assert.equal(first.verdict, 'received_not_applied'); assert.deepEqual([first.recordState, first.action], ['received_unapplied', 'keep']);
  const claimed = decide({receipt: appliedReceipt({application_state: 'applied'})});
  assert.deepEqual([claimed.verdict, claimed.recordState, claimed.action, claimed.receipt, claimed.problems], ['applied_verified', 'applied', 'keep', null, []]);
  assert.deepEqual(decide({receipt: appliedReceipt()}), claimed, 'a second run decides exactly the same');
  const fromPending = decide({receipt: appliedReceipt({application_state: 'pending'})});
  assert.equal(fromPending.verdict, 'received_not_applied', 'a non-applied receipt never becomes applied by this function alone');
  assert.ok(RECEIPT_STATES.includes(claimed.recordState));
});

test('decideReceipt: saving to the inbox or the packet existing is never evidence; no receipt means nothing to record, a tampered packet is rejected', () => {
  const none = decide({receipt: undefined});
  assert.deepEqual([none.verdict, none.recordState, none.action, none.receipt], ['saved_not_received', null, 'none', null]);
  const tampered = decide({packetBytes: Buffer.from('tampered')});
  assert.deepEqual([tampered.verdict, tampered.recordState, tampered.action], ['inbox_integrity_error', null, 'reject']);
});

test('decideReceipt: a claimed "applied" is never kept when the evidence is missing, wrong or contradicted (flag_downgrade, never silent)', () => {
  const noAlgorithm = decide({hashCard: undefined});
  assert.deepEqual([noAlgorithm.verdict, noAlgorithm.recordState, noAlgorithm.action], ['unverified', 'pending', 'flag_downgrade']); assert.ok(noAlgorithm.problems.includes('card_hash_not_recomputed'));
  const wrongHash = decide({hashCard: () => 'a'.repeat(64)});
  assert.deepEqual([wrongHash.verdict, wrongHash.recordState, wrongHash.action], ['receipt_inconsistent', 'conflict', 'flag_downgrade']);
  const stale = decide({card: staleCard, hashCard: card => (card === staleCard ? appliedReceipt().after_hash : hashCard(card))});
  assert.deepEqual([stale.verdict, stale.recordState, stale.action], ['mismatch_content_not_reflected', 'conflict', 'flag_downgrade']); assert.ok(stale.problems.includes('due_at_not_on_card'));
  const noReadback = decide({card: undefined});
  assert.deepEqual([noReadback.recordState, noReadback.action], ['pending', 'flag_downgrade']);
  assert.equal(decide({receipt: appliedReceipt({applied_at: undefined})}).recordState, 'conflict');
  assert.equal(decide({receipt: appliedReceipt({readback_verified: false})}).recordState, 'conflict');
  for (const result of [noAlgorithm, wrongHash, stale, noReadback]) assert.notEqual(result.receipt.application_state, 'applied');
});

test('decideReceipt: the card must be the target task\'s; the owner\'s basis and a persisted (non-legacy) status are required for applied', () => {
  const wrongTarget = decide({card: {...goodCard, id: 'SYNTH-99'}});
  assert.deepEqual([wrongTarget.recordState, wrongTarget.action], ['pending', 'flag_downgrade']); assert.ok(wrongTarget.problems.includes('card_target_unconfirmed'));
  assert.ok(decide({priorCard: {...priorCard, id: undefined}}).problems.includes('card_target_unconfirmed'));
  for (const source_message_ids of [undefined, [], [' '], [3]]) {
    const r = decide({delta: {...delta, source_message_ids}});
    assert.deepEqual([r.recordState, r.action], ['pending', 'flag_downgrade'], JSON.stringify(source_message_ids)); assert.ok(r.problems.some(p => ['owner_basis_missing', 'owner_confirmation_instruction_not_linked'].includes(p)), r.problems.join());
  }
  const legacy = decide({card: {...goodCard, legacyStatus: 'Awaiting Approval'}, hashCard: card => (card.legacyStatus ? appliedReceipt().after_hash : hashCard(card))});
  assert.equal(legacy.recordState, 'pending'); assert.ok(legacy.problems.includes('status_not_persisted_legacy'));
});

test('decideReceipt: reopening a Done card needs a matching owner record; the proposed receipt never invents a time, hash or read-back flag', () => {
  const reopenWith = ownerConfirmations => decide({ownerConfirmations, priorCard: {...priorCard, status: 'Done'}, hashCard: card => (card === goodCard ? appliedReceipt().after_hash : appliedReceipt().before_hash)});
  const reopen = reopenWith([]);
  assert.deepEqual([reopen.verdict, reopen.recordState], ['needs_owner_decision', 'pending']);
  assert.equal(reopenWith([ownerRecord()]).recordState, 'applied', 'a matching owner record is what allows the reopening');
  const pendingFromApplied = decide({delta: {...delta, source_message_ids: undefined}});
  assert.deepEqual(Object.keys(pendingFromApplied.receipt).sort(), ['application_state', 'batch_id', 'event_id', 'received_at', 'source_instruction_at', 'target_task_id']);
  const bare = decideReceipt({batch, packetBytes, packet, delta, receipt: {event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'received_unapplied', received_at: '2026-10-21T09:03:36Z', source_instruction_at: packet.source_instruction_at}, now: NOW});
  assert.equal(bare.receipt, null); assert.equal(bare.action, 'keep');
  const marked = decide({receipt: appliedReceipt({application_state: 'pending'}), delta});
  assert.deepEqual([marked.verdict, marked.recordState, marked.action, marked.receipt], ['received_not_applied', 'pending', 'keep', null], 'a pending mark is kept and no applied receipt is fabricated');
  assert.deepEqual([decide({receipt: appliedReceipt({application_state: 'conflict'})}).recordState, decide({receipt: appliedReceipt({application_state: 'conflict'})}).action], ['conflict', 'keep']);
});

test('decideReceipt: judging the updater\'s CANDIDATE applied receipt against the persisted state: write only with full evidence, otherwise a non-applied state', () => {
  const candidate = appliedReceipt();
  const accepted = decide({receipt: candidate, persistedState: 'received_unapplied'});
  assert.deepEqual([accepted.verdict, accepted.recordState, accepted.action], ['applied_verified', 'applied', 'write']);
  assert.deepEqual(accepted.receipt, {event_id: delta.event_id, batch_id: packet.batch_id, received_at: candidate.received_at, source_instruction_at: candidate.source_instruction_at, target_task_id: 'SYNTH-17',
    application_state: 'applied', applied_at: candidate.applied_at, before_hash: candidate.before_hash, after_hash: candidate.after_hash, readback_verified: true}, 'every value comes from the candidate; nothing is invented');
  assert.deepEqual([decide({receipt: candidate, persistedState: 'applied'}).action, decide({receipt: candidate, persistedState: 'applied'}).receipt], ['keep', null], 'already persisted: idempotent');
  const unproven = decide({receipt: candidate, persistedState: 'received_unapplied', hashCard: undefined});
  assert.deepEqual([unproven.recordState, unproven.action, unproven.receipt.application_state], ['pending', 'write', 'pending'], 'without the hash algorithm the candidate is written as pending, never as applied');
  const none = decide({receipt: candidate, persistedState: undefined, card: undefined});
  assert.deepEqual([none.recordState, none.action], ['pending', 'write']);
  assert.equal(decide({receipt: candidate, persistedState: undefined}).action, 'write', 'a first receipt for the event is a write');
});

test('decideReceipt: the owner record must match event, target task, a basis listed in the delta, and source_instruction_at <= confirmed_at <= applied_at; no time is filled in', () => {
  const states = over => { const r = decide({ownerConfirmations: [ownerRecord(over)]}); return [r.recordState, r.action]; };
  assert.deepEqual(states({}), ['applied', 'keep'], 'the matching record');
  const cases = {event: {event_id: 'synth-event-9'}, task: {task_id: 'SYNTH-99'}, basis: {basis_id: 'msg-404'}, beforeInstruction: {confirmed_at: '2026-10-21T07:00:00Z'}, afterApply: {confirmed_at: '2026-10-21T10:00:00Z'},
    future: {confirmed_at: '2999-01-01T00:00:00Z'}, noTime: {confirmed_at: undefined}, badTime: {confirmed_at: 'soon'}};
  for (const [name, over] of Object.entries(cases)) assert.deepEqual(states(over), ['pending', 'flag_downgrade'], name);
  assert.equal(decide({ownerConfirmations: undefined}).recordState, 'pending'); assert.ok(decide({ownerConfirmations: undefined}).problems.includes('owner_record_missing_or_mismatched'));
  assert.ok(decide({ownerConfirmations: [ownerRecord({confirmed_at: '2026-10-21T07:00:00Z'})]}).problems.includes('owner_confirmation_predates_instruction'));
  const wrongTime = decide({ownerConfirmations: [ownerRecord({confirmed_at: undefined})], receipt: appliedReceipt({application_state: 'pending'})});
  assert.equal(wrongTime.receipt, null, 'a pending receipt with no new evidence is left as it is');
});

test('fromStoredReceipt: maps the stored names only; the result alone is never verified, and official_cli_readback is not the public-card read-back', () => {
  const stored = {event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'applied', received_at: '2026-10-21T09:03:36Z', applied_at: '2026-10-21T09:14:00Z', target_task_id: 'SYNTH-17',
    source_instruction_at: packet.source_instruction_at, before_sha256: hashCard(priorCard), after_sha256: hashCard(goodCard), official_cli_readback: {opaque: true}};
  const {receipt, unmapped} = fromStoredReceipt(stored);
  assert.deepEqual([receipt.before_hash, receipt.after_hash, receipt.readback_verified, 'before_sha256' in receipt, 'official_cli_readback' in receipt], [stored.before_sha256, stored.after_sha256, undefined, false, false]);
  assert.deepEqual(unmapped, ['official_cli_readback']);
  const judged = decide({receipt, persistedState: 'received_unapplied'});
  assert.notEqual(judged.recordState, 'applied', 'names alone do not verify: no readback_verified claim, so it is not applied');
  const noCards = decide({receipt, card: undefined, priorCard: undefined, persistedState: 'applied'});
  assert.notEqual(noCards.recordState, 'applied'); assert.equal(noCards.action, 'flag_downgrade');
  assert.deepEqual(fromStoredReceipt(null), {receipt: undefined, unmapped: []});
});
