// Synthetic regression: the public /api/tasks card carries its text in `detail`, the inbox/CLI card in `body`.
// A card read back from the public snapshot must be judged by what it says, not declared "not reflected" because the field has another name.
// No real inbox, receipt, card text or credential is used. Success still needs every piece of evidence (see inbox-receipt-verify.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256, verifyDelta, assertionCheck} from '../scripts/inbox-receipt-verify.mjs';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const HA = sha256('synthetic-before'), HB = sha256('synthetic-after');
const assertions = {status: 'Blocked', due_at: '2026-10-22', blocked: true, blocker_summary: 'CLI DNS', must_include: ['SYNTH-MARK']};
const delta = {event_id: 'synth-event-1', target_id_hint: 'SYNTH-17', source_message_ids: ['m1'], card_assertions: assertions};
const packet = {batch_id: 'synth-batch-1', source_instruction_at: '2026-10-21T07:44:42Z', deltas: [delta]};
const bytes = Buffer.from(JSON.stringify(packet)), batch = {batch_id: packet.batch_id, packet_sha256: sha256(bytes), application_state: 'unapplied'};
const receipt = {event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'applied', received_at: '2026-10-21T09:03:36Z', applied_at: '2026-10-21T09:14:00Z',
  target_task_id: 'SYNTH-17', before_hash: HA, after_hash: HB, readback_verified: true, source_instruction_at: packet.source_instruction_at};
const text = 'Due: 2026-10-22\nBlocker: CLI DNS resolution fails\nSYNTH-MARK';
const publicCard = (over = {}) => ({id: 'SYNTH-17', title: 'Synthetic', status: 'Blocked', owner: '', group: null, detail: text, lastConfirmedAt: null, version: 4, updatedAt: '2026-10-21T09:14:00.000Z', ...over});
const inboxCard = (over = {}) => ({id: 'SYNTH-17', title: 'Synthetic', status: 'Blocked', body: text, ...over});
const prior = {id: 'SYNTH-17', title: 'Synthetic', status: 'In Progress', body: 'earlier'};
const verify = card => verifyDelta({batch, packetBytes: bytes, packet, delta, receipt, card, priorCard: prior, recomputedHashes: {before: HA, after: HB}, now: NOW});

test('a public-shaped card (detail) is judged exactly like the same card in inbox shape (body)', () => {
  assert.deepEqual(assertionCheck(assertions, publicCard()), {failures: [], indeterminate: []});
  assert.deepEqual(assertionCheck(assertions, publicCard()), assertionCheck(assertions, inboxCard()));
  assert.equal(verify(publicCard()).verdict, 'applied_verified');
  assert.equal(verify(publicCard()).verdict, verify(inboxCard()).verdict);
});

test('nothing is loosened: a public-shaped card that lacks the content still contradicts, with the same findings as the inbox shape', () => {
  const stale = 'Nothing about a deadline.';
  const viaDetail = assertionCheck(assertions, publicCard({detail: stale})), viaBody = assertionCheck(assertions, inboxCard({body: stale}));
  assert.deepEqual(viaDetail, viaBody);
  for (const code of ['due_at_not_on_card', 'blocker_summary_not_on_card', 'required_text_missing']) assert.ok(viaDetail.failures.includes(code), code);
  assert.equal(verify(publicCard({detail: stale})).verdict, 'mismatch_content_not_reflected');
  assert.equal(verify(publicCard({status: 'In Progress'})).verdict, 'mismatch_content_not_reflected', 'a wrong status is still a contradiction');
});

test('a card with no readable text field never counts as success', () => {
  const none = assertionCheck(assertions, {id: 'SYNTH-17', title: 'Synthetic', status: 'Blocked'});
  assert.ok(none.failures.includes('due_at_not_on_card'));
  assert.notEqual(verify({id: 'SYNTH-17', title: 'Synthetic', status: 'Blocked', detail: 42}).verdict, 'applied_verified');
});

test('body and detail that disagree are ambiguous: indeterminate, never success and never a contradiction', () => {
  assert.deepEqual(assertionCheck(assertions, {...publicCard(), body: 'a different text'}), {failures: [], indeterminate: ['card_text_ambiguous']});
  const r = verify({...publicCard(), body: 'a different text'});
  assert.equal(r.verdict, 'unverified'); assert.ok(r.findings.insufficient.includes('card_text_ambiguous')); assert.notEqual(r.verdict, 'applied_verified');
  assert.deepEqual(assertionCheck(assertions, {...publicCard(), body: text}), {failures: [], indeterminate: []}, 'identical text in both fields is not ambiguous');
});

test('`body` wins when only it is a string, and `detail` is used when `body` is absent', () => {
  assert.deepEqual(assertionCheck({must_include: ['ONLY-BODY']}, {title: 't', body: 'ONLY-BODY'}), {failures: [], indeterminate: []});
  assert.deepEqual(assertionCheck({must_include: ['ONLY-DETAIL']}, {title: 't', detail: 'ONLY-DETAIL'}), {failures: [], indeterminate: []});
  assert.deepEqual(assertionCheck({must_include: ['MISSING']}, {title: 't', detail: 'ONLY-DETAIL'}).failures, ['required_text_missing']);
});
