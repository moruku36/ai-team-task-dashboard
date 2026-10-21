// Synthetic regression for the "applied but the card does not show it" defect. No real ledger, inbox or card text is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256, verifyDelta, batchVerdict, planApply, deltaFingerprint, assertionFailures} from '../scripts/inbox-receipt-verify.mjs';

const delta = {
  event_id: 'dot-synth-balance-research-1', target_id_hint: 'SYNTH-17', source_event_at: '2026-10-21T07:48Z',
  card_assertions: {status: 'Blocked', due_at: '2026-10-22T00:00:00+09:00', blocked: true, blocker_summary: 'CLI DNS'}
};
const packet = {batch_id: 'dot-synth-batch-1', source_instruction_at: '2026-10-21T07:44:42Z', deltas: [delta]};
const bytes = Buffer.from(JSON.stringify(packet));
const batch = {batch_id: packet.batch_id, packet_sha256: sha256(bytes), application_state: 'unapplied'};
const receipt = (over = {}) => ({event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'applied', received_at: '2026-10-21T09:03:36Z', applied_at: '2026-10-21T09:14:00Z',
  target_task_id: 'SYNTH-17', before_hash: 'aaa', after_hash: 'aaa', readback_verified: true, source_instruction_at: packet.source_instruction_at, ...over});
const staleCard = {id: 'SYNTH-17', status: 'In Progress', title: 'Synthetic balance task', body: 'Display work finished earlier. Nothing about a deadline.'};
const goodCard = {...staleCard, status: 'Blocked', body: 'Research due 2026-10-22 JST. Blocked: CLI DNS resolution fails, no balance obtained.'};
const run = over => verifyDelta({batch, packetBytes: bytes, packet, delta, receipt: receipt(), card: staleCard, ...over});

test('receipt "applied" + readback + matching packet hash is NOT enough when the card lacks the deadline and blocker', () => {
  const result = run({});
  assert.equal(result.verdict, 'mismatch_content_not_reflected');
  assert.equal(result.stages.saved_to_inbox, true);
  assert.equal(result.stages.received, true);
  assert.equal(result.stages.applied_to_task, false);
  for (const code of ['card_hash_unchanged', 'due_at_not_on_card', 'blocker_summary_not_on_card', 'status_mismatch']) assert.ok(result.problems.includes(code), code);
  assert.equal(batchVerdict([result]), 'mismatch');
});

test('applied is verified only when hashes changed and the card shows the deadline, blocker and status', () => {
  const result = run({receipt: receipt({after_hash: 'bbb'}), card: goodCard});
  assert.equal(result.verdict, 'applied_verified');
  assert.deepEqual(result.problems, []);
  assert.equal(result.stages.displayed, 'unknown', 'screen state is never assumed');
  assert.equal(run({receipt: receipt({after_hash: 'bbb'}), card: goodCard, displayed: staleCard}).verdict, 'applied_not_displayed');
  assert.equal(run({receipt: receipt({after_hash: 'bbb'}), card: goodCard, displayed: goodCard}).stages.displayed, true);
});

test('stages stay distinct: saved only, received only, packet tampering', () => {
  assert.equal(run({receipt: undefined}).verdict, 'saved_not_received');
  assert.equal(run({receipt: receipt({application_state: 'received_unapplied'}), card: staleCard}).verdict, 'received_not_applied');
  assert.equal(run({packetBytes: Buffer.from('tampered')}).verdict, 'inbox_integrity_error');
});

test('unverified is kept apart from mismatch: a legacy packet without assertions is not declared broken', () => {
  const bare = {event_id: delta.event_id, target_id_hint: 'SYNTH-17'};
  const legacy = verifyDelta({batch, packetBytes: bytes, packet, delta: bare, receipt: receipt({after_hash: 'bbb'}), card: staleCard});
  assert.equal(legacy.verdict, 'unverified');
  assert.ok(legacy.problems.includes('no_card_assertions_content_unverifiable'));
  assert.equal(batchVerdict([legacy]), 'unverified');
  assert.equal(run({receipt: receipt({after_hash: 'bbb'}), card: undefined}).verdict, 'unverified', 'card not read back -> cannot judge');
  assert.equal(batchVerdict([run({receipt: receipt({after_hash: 'bbb'}), card: undefined})]), 'unverified');
});

test('assertions are expectations only: they are always compared with the real card, and an empty assertion object checks nothing', () => {
  const selfDeclared = {...delta, card_assertions: {status: 'Blocked', due_at: '2026-10-22'}};
  const lying = verifyDelta({batch, packetBytes: bytes, packet, delta: selfDeclared, receipt: receipt({after_hash: 'bbb'}), card: staleCard});
  assert.equal(lying.verdict, 'mismatch_content_not_reflected', 'the packet saying so does not make it so');
  for (const empty of [{}, {must_include: []}, {blocker_summary: ''}, {blocked: false}]) {
    const result = verifyDelta({batch, packetBytes: bytes, packet, delta: {...delta, card_assertions: empty}, receipt: receipt({after_hash: 'bbb'}), card: staleCard});
    assert.equal(result.verdict, 'unverified', JSON.stringify(empty));
  }
  assert.ok(assertionFailures({must_include: ['']}, goodCard).includes('required_text_missing'));
});

test('content already on the card but no recorded change is reported as such, not as a fresh application', () => {
  assert.equal(run({card: goodCard}).verdict, 'content_present_no_recorded_change');
});

test('target mismatch, missing applied_at/readback and changed source time are reported', () => {
  const result = run({receipt: receipt({after_hash: 'bbb', target_task_id: 'SYNTH-99', applied_at: null, readback_verified: false, source_instruction_at: '2026-10-22T00:00:00Z'}), card: goodCard});
  assert.equal(result.verdict, 'receipt_inconsistent');
  for (const code of ['target_task_mismatch', 'applied_without_applied_at', 'applied_without_readback', 'source_instruction_at_changed']) assert.ok(result.problems.includes(code), code);
});

test('a new request is not silently merged into an earlier Done card without the owner confirming the target', () => {
  const doneCard = {id: 'SYNTH-17', status: 'Done', title: 'Synthetic balance task', body: 'Done earlier. due 2026-10-22 Blocked CLI DNS'};
  const result = run({receipt: receipt({after_hash: 'bbb'}), card: doneCard});
  assert.equal(result.verdict, 'needs_owner_decision');
  const confirmed = {...delta, owner_confirmed_target_task_id: 'SYNTH-17'};
  const again = verifyDelta({batch, packetBytes: bytes, packet, delta: confirmed, receipt: receipt({after_hash: 'bbb'}), card: {...doneCard, status: 'Blocked'}});
  assert.equal(again.verdict, 'applied_verified');
});

test('double application is prevented: resend skips, changed content with the same event_id conflicts, duplicate batch ids conflict', () => {
  const ledger = {};
  assert.deepEqual(planApply(ledger, packet, [batch]).map(p => p.action), ['apply']);
  ledger[delta.event_id] = deltaFingerprint(delta);
  assert.deepEqual(planApply(ledger, packet, [batch]).map(p => p.action), ['skip_duplicate']);
  const changed = {...packet, deltas: [{...delta, card_assertions: {...delta.card_assertions, due_at: '2026-10-30T00:00:00+09:00'}}]};
  assert.deepEqual(planApply(ledger, changed, [batch]).map(p => p.reason), ['same_event_id_different_content']);
  assert.equal(planApply({}, packet, [batch, {...batch}])[0].reason, 'duplicate_batch_id_in_inbox');
  assert.equal(planApply({}, {...packet, deltas: [delta, delta]}, [batch])[1].action, 'conflict');
  assert.equal(deltaFingerprint({b: 1, a: 2}), deltaFingerprint({a: 2, b: 1}), 'key order does not change identity');
});

test('assertion matching accepts date notations and rejects absent facts', () => {
  assert.deepEqual(assertionFailures({due_at: '2026-10-22'}, {title: 'x', body: '期限: 10月22日'}), []);
  assert.deepEqual(assertionFailures({due_at: '2026-10-22'}, {title: 'x', body: '期限: 2026/10/22'}), []);
  assert.deepEqual(assertionFailures({due_at: '2026-10-22'}, {title: 'x', body: 'no date'}), ['due_at_not_on_card']);
  assert.deepEqual(assertionFailures({}, null), ['card_missing']);
});

test('a receipt for another event or batch, or with a changed instruction time, can never verify', () => {
  const base = {after_hash: 'bbb'};
  for (const [name, over, code] of [['other event', {event_id: 'dot-other-event'}, 'receipt_identity_mismatch'], ['other batch', {batch_id: 'dot-other-batch'}, 'receipt_identity_mismatch'],
    ['no received_at', {received_at: null}, 'received_at_invalid'], ['instruction time changed', {source_instruction_at: '2026-10-22T00:00:00Z'}, 'source_instruction_at_changed']]) {
    const result = run({receipt: receipt({...base, ...over}), card: goodCard});
    assert.equal(result.verdict, 'receipt_inconsistent', name);
    assert.equal(result.stages.applied_to_task, false, name);
    assert.ok(result.problems.includes(code), name);
    assert.notEqual(batchVerdict([result]), 'applied_verified', name);
  }
});

test('missing change evidence (hashes) is never a verified success, yet is not reported as a content mismatch', () => {
  for (const hashes of [{before_hash: undefined, after_hash: undefined}, {before_hash: 'aaa', after_hash: undefined}, {before_hash: undefined, after_hash: 'bbb'}, {before_hash: '', after_hash: ''}]) {
    const ok = run({receipt: receipt(hashes), card: goodCard});
    assert.equal(ok.verdict, 'unverified', JSON.stringify(hashes));
    assert.ok(ok.problems.includes('card_hash_missing'));
    assert.equal(ok.stages.applied_to_task, false);
    assert.equal(batchVerdict([ok]), 'unverified');
    // when the real card contradicts the packet, it stays a mismatch (distinct from "not enough to compare")
    assert.equal(run({receipt: receipt(hashes), card: staleCard}).verdict, 'mismatch_content_not_reflected');
  }
  assert.equal(run({receipt: receipt({after_hash: 'bbb'}), card: goodCard}).verdict, 'applied_verified');
});

test('received_at must be a valid instant and the instruction time may not be missing; none of these can verify', () => {
  const ok = {after_hash: 'bbb'};
  for (const bad of [undefined, null, '', 'yesterday', '2026-13-40T00:00:00Z', '2026-02-30T10:00:00Z', '2026-10-21 09:03:36', '2026-10-21T09:03:36', 20261021, {}]) {
    const result = run({receipt: receipt({...ok, received_at: bad}), card: goodCard});
    assert.equal(result.verdict, 'receipt_inconsistent', String(bad));
    assert.ok(result.problems.includes('received_at_invalid'), String(bad));
    assert.equal(result.stages.received, false); assert.equal(result.stages.applied_to_task, false);
    assert.notEqual(batchVerdict([result]), 'applied_verified');
  }
  for (const bad of [undefined, null, '', 'not-a-time']) {
    const result = run({receipt: receipt({...ok, source_instruction_at: bad}), card: goodCard});
    assert.equal(result.verdict, 'receipt_inconsistent', `receipt time ${String(bad)}`);
    assert.ok(result.problems.includes('source_instruction_at_missing_in_receipt'));
  }
  // packet without a (valid) instruction time: nothing to compare with -> not verified, but not called a mismatch either
  for (const bad of [undefined, '', 'garbage']) {
    const result = verifyDelta({batch, packetBytes: bytes, packet: {...packet, source_instruction_at: bad}, delta, receipt: receipt(ok), card: goodCard});
    assert.notEqual(result.verdict, 'applied_verified', String(bad));
    assert.ok(result.problems.includes('source_instruction_at_missing_in_packet'));
  }
  // applied_at must be valid and not earlier than received_at
  assert.ok(run({receipt: receipt({...ok, applied_at: 'soon'}), card: goodCard}).problems.includes('applied_at_invalid'));
  assert.equal(run({receipt: receipt({...ok, applied_at: '2026-10-21T09:00:00Z'}), card: goodCard}).verdict, 'receipt_inconsistent');
  assert.equal(run({receipt: receipt(ok), card: goodCard}).verdict, 'applied_verified');
});

test('expects_no_card_change is the only exception to the hash rule: hashes may then be equal or absent, but content must still match', () => {
  const noChange = {...delta, card_assertions: {...delta.card_assertions, expects_no_card_change: true}};
  const go = (over, card = goodCard) => verifyDelta({batch, packetBytes: bytes, packet, delta: noChange, receipt: receipt(over), card});
  assert.equal(go({}).verdict, 'applied_verified', 'equal hashes accepted when no change is expected');
  assert.equal(go({before_hash: undefined, after_hash: undefined}).verdict, 'applied_verified');
  assert.equal(go({}, staleCard).verdict, 'mismatch_content_not_reflected', 'the real card still has to match');
  assert.equal(run({card: goodCard}).verdict, 'content_present_no_recorded_change', 'without the flag, equal hashes are not a verified application');
});
