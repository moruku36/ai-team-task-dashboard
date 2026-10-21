// Synthetic regression for the "applied but the card does not show it" defect. No real ledger, inbox or card text is used.
// Success needs positive evidence: receipt identity and times, a trusted prior state, recomputed hashes, an unambiguous real card, no open owner question.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256, verifyDelta, batchVerdict, batchSummary, planApply, deltaFingerprint, assertionCheck, assertionFailures, findOwnerConfirmation, matchOwnerConfirmation, validHash, validInstant} from '../scripts/inbox-receipt-verify.mjs';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const HA = sha256('synthetic-before'), HB = sha256('synthetic-after');
const delta = {
  event_id: 'dot-synth-balance-research-1', target_id_hint: 'SYNTH-17', source_event_at: '2026-10-21T07:48Z', source_message_ids: ['msg-1'],
  card_assertions: {status: 'Blocked', due_at: '2026-10-22T00:00:00+09:00', blocked: true, blocker_summary: 'CLI DNS'}
};
const packet = {batch_id: 'dot-synth-batch-1', source_instruction_at: '2026-10-21T07:44:42Z', deltas: [delta]};
const bytes = Buffer.from(JSON.stringify(packet));
const batch = {batch_id: packet.batch_id, packet_sha256: sha256(bytes), application_state: 'unapplied'};
const receipt = (over = {}) => ({event_id: delta.event_id, batch_id: packet.batch_id, application_state: 'applied', received_at: '2026-10-21T09:03:36Z', applied_at: '2026-10-21T09:14:00Z',
  target_task_id: 'SYNTH-17', before_hash: HA, after_hash: HB, readback_verified: true, source_instruction_at: packet.source_instruction_at, ...over});
const priorCard = {id: 'SYNTH-17', status: 'In Progress', title: 'Synthetic balance task', body: 'Display work finished earlier.'};
const staleCard = {id: 'SYNTH-17', status: 'In Progress', title: 'Synthetic balance task', body: 'Display work finished earlier. Nothing about a deadline.'};
const goodCard = {...staleCard, status: 'Blocked', body: 'Due: 2026-10-22\nBlocker: CLI DNS resolution fails'};
// `verify` supplies the evidence a correct caller would supply: a trusted prior state and hashes recomputed to equal the receipt's.
// A test that wants the evidence missing or wrong passes it explicitly.
function verify(args = {}) {
  const r = 'receipt' in args ? args.receipt : receipt();
  const recomputedHashes = 'recomputedHashes' in args ? args.recomputedHashes : r ? {before: r.before_hash, after: r.after_hash} : undefined;
  return verifyDelta({batch, packetBytes: bytes, packet, delta, receipt: r, card: staleCard, priorCard, now: NOW, ...args, receipt: r, recomputedHashes});
}
const run = over => verify(over);

test('receipt "applied" + readback + matching packet hash is NOT enough when the card lacks the deadline and blocker', () => {
  const result = run({});
  assert.equal(result.verdict, 'mismatch_content_not_reflected');
  assert.equal(result.stages.saved_to_inbox, true); assert.equal(result.stages.received, true); assert.equal(result.stages.applied_to_task, false);
  for (const code of ['status_mismatch', 'due_at_not_on_card', 'blocked_not_on_card']) assert.ok(result.findings.content.includes(code), code);
  assert.equal(batchVerdict([result]), 'mismatch');
});

test('applied_verified needs every piece of evidence; screen state is never assumed', () => {
  const ok = run({card: goodCard});
  assert.equal(ok.verdict, 'applied_verified'); assert.deepEqual(ok.problems, []);
  assert.deepEqual([ok.evidence.hash, ok.evidence.prior_state, ok.evidence.owner_confirmation], ['recomputed_match', 'provided', 'none']);
  assert.equal(ok.stages.displayed, 'unknown');
  assert.equal(run({card: goodCard, displayed: staleCard}).verdict, 'applied_not_displayed');
  assert.equal(run({card: goodCard, displayed: goodCard}).stages.displayed, true);
  assert.equal(batchVerdict([ok]), 'applied_verified');
});

test('stages stay distinct: saved only, received only, packet tampering', () => {
  assert.equal(run({receipt: undefined}).verdict, 'saved_not_received');
  const received = run({receipt: receipt({application_state: 'received_unapplied'})});
  assert.equal(received.verdict, 'received_not_applied'); assert.equal(received.stages.received, true);
  assert.equal(run({packetBytes: Buffer.from('tampered')}).verdict, 'inbox_integrity_error');
});

test('unverified is kept apart from mismatch: a legacy packet without assertions is not declared broken', () => {
  const bare = {event_id: delta.event_id, target_id_hint: 'SYNTH-17'};
  const legacy = run({delta: bare, card: staleCard});
  assert.equal(legacy.verdict, 'unverified'); assert.ok(legacy.findings.insufficient.includes('no_card_assertions_content_unverifiable'));
  assert.equal(batchVerdict([legacy]), 'unverified');
  const unread = run({card: undefined});
  assert.equal(unread.verdict, 'unverified'); assert.ok(unread.findings.insufficient.includes('card_not_read_back'));
});

test('assertions are expectations only: they are always compared with the real card, and an empty assertion object checks nothing', () => {
  const selfDeclared = {...delta, card_assertions: {status: 'Blocked', due_at: '2026-10-22'}};
  assert.equal(run({delta: selfDeclared, card: staleCard}).verdict, 'mismatch_content_not_reflected', 'the packet saying so does not make it so');
  for (const empty of [{}, {must_include: []}, {blocker_summary: ''}, {blocked: 'yes'}]) assert.equal(run({delta: {...delta, card_assertions: empty}}).verdict, 'unverified', JSON.stringify(empty));
  assert.ok(assertionFailures({must_include: ['']}, goodCard).includes('required_text_missing'));
});

test('content already on the card but no recorded change is reported as such, not as a fresh application', () => {
  const same = receipt({after_hash: HA});
  assert.equal(run({receipt: same, card: goodCard}).verdict, 'content_present_no_recorded_change');
});

test('target mismatch, missing applied_at/readback and changed source time are reported', () => {
  const result = run({receipt: receipt({target_task_id: 'SYNTH-99', applied_at: null, readback_verified: false, source_instruction_at: '2026-10-22T00:00:00Z'}), card: goodCard});
  assert.equal(result.verdict, 'receipt_inconsistent');
  for (const code of ['target_task_mismatch', 'applied_without_applied_at', 'applied_without_readback', 'source_instruction_at_changed']) assert.ok(result.findings.receipt.includes(code), code);
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

// ---- receipt identity and times -------------------------------------------------------------------------------------
test('a receipt for another event or batch, or with a bad/changed time, can never verify and is never "received"', () => {
  for (const [name, over, code] of [['other event', {event_id: 'dot-other-event'}, 'receipt_identity_mismatch'], ['other batch', {batch_id: 'dot-other-batch'}, 'receipt_identity_mismatch'],
    ['no received_at', {received_at: null}, 'received_at_invalid'], ['instruction time changed', {source_instruction_at: '2026-10-22T00:00:00Z'}, 'source_instruction_at_changed']]) {
    for (const state of ['applied', 'received_unapplied', 'pending']) {
      const result = run({receipt: receipt({...over, application_state: state}), card: goodCard});
      assert.equal(result.verdict, 'receipt_inconsistent', `${name}/${state}`);
      assert.equal(result.stages.received, false, `${name}/${state}: not "received"`); assert.equal(result.stages.applied_to_task, false);
      assert.ok(result.findings.receipt.includes(code), name);
      assert.notEqual(batchVerdict([result]), 'applied_verified');
    }
  }
});

test('received_at must be a valid instant and the instruction time may not be missing; none of these can verify', () => {
  for (const bad of [undefined, null, '', 'yesterday', '2026-13-40T00:00:00Z', '2026-02-30T10:00:00Z', '2026-10-21 09:03:36', '2026-10-21T09:03:36', 20261021, {}]) {
    const result = run({receipt: receipt({received_at: bad}), card: goodCard});
    assert.equal(result.verdict, 'receipt_inconsistent', String(bad)); assert.ok(result.findings.receipt.includes('received_at_invalid'));
    assert.equal(result.stages.received, false); assert.equal(result.stages.applied_to_task, false);
  }
  for (const bad of [undefined, null, '', 'not-a-time']) {
    const result = run({receipt: receipt({source_instruction_at: bad}), card: goodCard});
    assert.equal(result.verdict, 'receipt_inconsistent', `receipt time ${String(bad)}`); assert.ok(result.findings.receipt.includes('source_instruction_at_missing_in_receipt'));
  }
  for (const bad of [undefined, '', 'garbage']) {
    const result = run({packet: {...packet, source_instruction_at: bad}, packetBytes: Buffer.from(JSON.stringify({...packet, source_instruction_at: bad})), batch: {...batch, packet_sha256: sha256(Buffer.from(JSON.stringify({...packet, source_instruction_at: bad})))}, card: goodCard});
    assert.notEqual(result.verdict, 'applied_verified', String(bad)); assert.ok(result.findings.insufficient.includes('source_instruction_at_missing_in_packet'));
  }
  assert.ok(run({receipt: receipt({applied_at: 'soon'}), card: goodCard}).findings.receipt.includes('applied_at_invalid'));
  assert.equal(run({receipt: receipt({applied_at: '2026-10-21T09:00:00Z'}), card: goodCard}).verdict, 'receipt_inconsistent');
  assert.equal(validInstant('2026-10-21T09:03:36Z'), true);
});

// ---- hash evidence --------------------------------------------------------------------------------------------------
test('hashes must have the contract format (SHA-256 hex); zzz, short, non-hex or wrong-length values are not hashes', () => {
  for (const bad of ['zzz', 'aaa', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 123, {}, ' ' + HA]) {
    const r = run({receipt: receipt({before_hash: bad}), recomputedHashes: {before: HA, after: HB}, card: goodCard});
    assert.equal(r.verdict, 'receipt_inconsistent', String(bad)); assert.ok(r.findings.receipt.includes('card_hash_malformed')); assert.equal(r.evidence.hash, 'malformed');
    const r2 = run({receipt: receipt({after_hash: bad}), recomputedHashes: {before: HA, after: HB}, card: goodCard});
    assert.equal(r2.verdict, 'receipt_inconsistent', String(bad));
  }
  assert.equal(validHash(HA), true); assert.equal(validHash(HA.toUpperCase()), true); assert.equal(validHash('zzz'), false);
});

test('hash evidence has levels: absent < format only < recomputed match; only a recomputed match can verify', () => {
  const absent = run({receipt: receipt({before_hash: undefined, after_hash: undefined}), card: goodCard});
  assert.equal(absent.verdict, 'unverified'); assert.equal(absent.evidence.hash, 'absent'); assert.ok(absent.findings.insufficient.includes('card_hash_missing'));
  for (const half of [{before_hash: HA, after_hash: undefined}, {before_hash: undefined, after_hash: HB}, {before_hash: '', after_hash: ''}]) assert.equal(run({receipt: receipt(half), card: goodCard}).verdict, 'unverified');
  // well-formed strings, but nothing recomputed from the cards: string equality of a receipt with itself proves nothing
  for (const none of [undefined, null, {}, {before: 'zzz', after: 'zzz'}, {before: HA}]) {
    const r = run({recomputedHashes: none, card: goodCard});
    assert.equal(r.verdict, 'unverified', JSON.stringify(none)); assert.equal(r.evidence.hash, 'format_only'); assert.ok(r.findings.insufficient.includes('card_hash_not_recomputed'));
    assert.equal(r.stages.applied_to_task, false);
  }
  // recomputed values that disagree with the receipt: the receipt is not trustworthy
  const wrong = run({recomputedHashes: {before: HA, after: sha256('something else')}, card: goodCard});
  assert.equal(wrong.verdict, 'receipt_inconsistent'); assert.equal(wrong.evidence.hash, 'recomputed_mismatch'); assert.ok(wrong.findings.receipt.includes('card_hash_recompute_mismatch'));
  assert.equal(run({card: goodCard}).verdict, 'applied_verified');
  // a contradicting card is still a mismatch, not hidden behind missing hash evidence
  assert.equal(run({receipt: receipt({before_hash: undefined, after_hash: undefined}), card: staleCard}).verdict, 'mismatch_content_not_reflected');
});

test('expects_no_card_change requires BOTH recomputed hashes and they must be EQUAL; it never relaxes anything else', () => {
  const noChange = {...delta, card_assertions: {...delta.card_assertions, expects_no_card_change: true}};
  const same = receipt({after_hash: HA});
  const go = (over = {}, card = goodCard, d = noChange) => run({delta: d, receipt: same, card, ...over});
  assert.equal(go().verdict, 'applied_verified', 'equal recomputed hashes + matching card: the declaration is consistent');
  for (const missing of [{before_hash: undefined, after_hash: undefined}, {before_hash: HA, after_hash: undefined}, {before_hash: undefined, after_hash: HA}, {before_hash: '', after_hash: ''}]) {
    const r = go({receipt: receipt(missing)}); assert.equal(r.verdict, 'unverified', JSON.stringify(missing)); assert.ok(r.findings.insufficient.includes('card_hash_missing'));
  }
  assert.equal(go({recomputedHashes: undefined}).verdict, 'unverified', 'equal strings alone are not enough here either');
  const changed = go({receipt: receipt()});
  assert.equal(changed.verdict, 'declaration_inconsistent'); assert.ok(changed.findings.declaration.includes('hash_changed_but_no_change_expected')); assert.equal(batchVerdict([changed]), 'mismatch');
  assert.equal(go({}, staleCard).verdict, 'mismatch_content_not_reflected', 'the real card still has to match');
  assert.equal(go({receipt: receipt({after_hash: HA, received_at: 'soon'})}).verdict, 'receipt_inconsistent', 'receipt checks are not relaxed');
  assert.equal(go({priorCard: undefined}).verdict, 'unverified', 'prior state is still required');
  // without the flag: changed hashes verify, equal hashes are "no recorded change"
  assert.equal(run({card: goodCard}).verdict, 'applied_verified');
  assert.equal(run({receipt: same, card: goodCard}).verdict, 'content_present_no_recorded_change');
  for (const flag of [false, 'true', 1, undefined]) assert.equal(go({}, goodCard, {...delta, card_assertions: {...delta.card_assertions, expects_no_card_change: flag}}).verdict, 'content_present_no_recorded_change', String(flag));
});

// ---- prior state ----------------------------------------------------------------------------------------------------
test('the prior (pre-change) state is never inferred from the card after the change', () => {
  const none = run({priorCard: undefined, card: goodCard});
  assert.equal(none.verdict, 'unverified'); assert.equal(none.evidence.prior_state, 'absent'); assert.ok(none.findings.insufficient.includes('prior_state_unavailable'));
  assert.equal(none.stages.applied_to_task, false);
  // a post-change card that is not Done does not prove the card was not Done before; a Done post-change card does not prove it was
  assert.equal(run({priorCard: undefined, card: {...goodCard, status: 'Done'}}).verdict, 'mismatch_content_not_reflected');
  for (const bad of [null, 'Done', 42]) assert.equal(run({priorCard: bad, card: goodCard}).evidence.prior_state, 'absent');
  // with a trusted prior state of Done, extending or reopening the card needs an owner decision
  const reopened = run({priorCard: {...priorCard, status: 'Done'}, card: goodCard});
  assert.equal(reopened.verdict, 'needs_owner_decision'); assert.ok(reopened.findings.owner.includes('owner_target_confirmation_required'));
  assert.equal(batchVerdict([reopened]), 'needs_owner_decision');
  // staying Done is not a reopening
  const stayDone = run({delta: {...delta, card_assertions: {status: 'Done', must_include: ['Due: 2026-10-22']}}, priorCard: {...priorCard, status: 'Done'}, card: {...goodCard, status: 'Done'}});
  assert.equal(stayDone.verdict, 'applied_verified');
});

// ---- owner confirmation ---------------------------------------------------------------------------------------------
const confirmationOf = (over = {}) => ({event_id: delta.event_id, task_id: 'SYNTH-17', confirmed_at: '2026-10-21T08:00:00Z', basis_id: 'msg-1', ...over});
const doneDelta = {...delta, owner_confirmed_target_task_id: 'SYNTH-17'};
const reopenArgs = (extra = {}) => ({delta: doneDelta, priorCard: {...priorCard, status: 'Done'}, card: goodCard, now: NOW, ...extra});

test('an unresolved owner question stops success for ANY card state, individually and for the batch', () => {
  // the packet declares an owner confirmation on a card that was never Done: still only a self-declaration
  const declared = run({delta: doneDelta, card: goodCard});
  assert.equal(declared.verdict, 'needs_owner_decision'); assert.ok(declared.findings.owner.includes('owner_confirmation_self_declared_only')); assert.equal(declared.evidence.owner_confirmation, 'self_declared_only');
  assert.equal(batchVerdict([declared]), 'needs_owner_decision');
  assert.equal(batchVerdict([run({card: goodCard}), declared]), 'needs_owner_decision', 'one open question holds the whole batch');
  // a Done prior state without a record
  const reopen = run(reopenArgs());
  assert.equal(reopen.verdict, 'needs_owner_decision');
  // records that fail a condition do not count and are named
  const cases = [[{event_id: 'other'}, null], [{task_id: 'SYNTH-99'}, 'owner_confirmation_target_mismatch'], [{basis_id: 'msg-other'}, 'owner_confirmation_instruction_not_linked'],
    [{confirmed_at: 'later'}, 'owner_confirmation_time_not_orderable'], [{confirmed_at: undefined}, 'owner_confirmation_time_not_orderable'],
    [{confirmed_at: '2026-10-21T07:00:00Z'}, 'owner_confirmation_predates_instruction'], [{confirmed_at: '2026-10-23T00:00:00Z'}, 'owner_confirmation_in_future'],
    [{confirmed_at: '2026-10-21T10:00:00Z'}, 'owner_confirmation_after_apply']];
  for (const [over, reason] of cases) {
    const r = run(reopenArgs({ownerConfirmations: [confirmationOf(over)]}));
    assert.equal(r.verdict, 'needs_owner_decision', JSON.stringify(over));
    if (reason) assert.ok(r.findings.owner.includes(reason), `${JSON.stringify(over)} -> ${reason}`);
  }
  for (const junk of [null, 'x', 5, [], [null], ['x']]) assert.equal(run(reopenArgs({ownerConfirmations: junk})).verdict, 'needs_owner_decision');
});

test('a matching owner-confirmation record lifts only the owner gate; the target, content and evidence checks still apply', () => {
  const record = confirmationOf();
  const ok = run(reopenArgs({ownerConfirmations: [record]}));
  assert.equal(ok.verdict, 'applied_verified'); assert.equal(ok.evidence.owner_confirmation, 'matched_unauthenticated_input');
  assert.deepEqual(ok.caveats, ['owner_confirmation_record_authenticity_not_verified']);
  assert.ok(findOwnerConfirmation([record], doneDelta, {target: 'SYNTH-17', packet, receipt: receipt(), now: NOW}));
  assert.equal(findOwnerConfirmation([confirmationOf({basis_id: 'x'})], doneDelta, {target: 'SYNTH-17', packet, receipt: receipt(), now: NOW}), null);
  assert.deepEqual(matchOwnerConfirmation([], doneDelta, {target: 'SYNTH-17', packet, receipt: receipt(), now: NOW}), {record: null, rejected: []});
  // the content is still checked
  assert.equal(run(reopenArgs({ownerConfirmations: [record], card: {...goodCard, status: 'Done'}})).verdict, 'mismatch_content_not_reflected');
  // a record never exempts a target mismatch: the packet's own target_id_hint and the receipt's target must be the confirmed task
  const redirected = {...doneDelta, target_id_hint: 'SYNTH-18'};
  const r1 = run(reopenArgs({delta: redirected, ownerConfirmations: [record]}));
  assert.equal(r1.verdict, 'needs_owner_decision'); assert.ok(r1.findings.owner.includes('owner_confirmation_target_mismatch'));
  assert.ok(r1.findings.receipt.includes('target_task_mismatch'), 'the receipt target still has to equal target_id_hint');
  const r2 = run(reopenArgs({delta: {...doneDelta, target_id_hint: 'SYNTH-99'}, receipt: receipt({target_task_id: 'SYNTH-99'}), ownerConfirmations: [confirmationOf({task_id: 'SYNTH-99'})], card: goodCard}));
  assert.equal(r2.verdict, 'needs_owner_decision', 'declared owner_confirmed_target_task_id (SYNTH-17) differs from the hint and the record: rejected');
  const noHint = {...doneDelta}; delete noHint.target_id_hint;
  const r3 = run(reopenArgs({delta: noHint, ownerConfirmations: [record]}));
  assert.notEqual(r3.verdict, 'applied_verified'); assert.ok(r3.findings.insufficient.includes('target_id_hint_missing'));
  // a delta that lists no source messages cannot be tied to an instruction
  const noSource = {...doneDelta}; delete noSource.source_message_ids;
  assert.equal(run(reopenArgs({delta: noSource, ownerConfirmations: [record]})).verdict, 'needs_owner_decision');
  // an unparseable instruction time or apply time makes the ordering impossible
  assert.equal(run(reopenArgs({ownerConfirmations: [record], receipt: receipt({applied_at: undefined})})).verdict, 'needs_owner_decision');
  assert.equal(run(reopenArgs({ownerConfirmations: [record], ...{packet: {...packet, source_instruction_at: undefined}}})).verdict, 'needs_owner_decision');
});

// ---- deadlines ------------------------------------------------------------------------------------------------------
test('the assertion date itself is validated strictly (no trailing garbage, no impossible dates)', () => {
  const check = due => assertionCheck({due_at: due}, {title: 't', body: 'Due: 2026-10-22'});
  for (const bad of ['2026-10-22garbage', '2026-10-22 and more', '2026-10-22T', '2026-10-22T00:00', '2026-02-30', '2026-13-01', '22/10/2026', 'Oct 22 2026', '2026-10-2', 20261022, 'tomorrow', '2026-10-22T25:00:00Z'])
    assert.deepEqual(check(bad), {failures: [], indeterminate: ['due_at_invalid_assertion']}, String(bad));
  for (const good of ['2026-10-22', '2026-10-22T00:00:00+09:00', '2026-10-22T09:00:00Z']) assert.deepEqual(check(good), {failures: [], indeterminate: []}, good);
});

test('deadlines are whole dates in a deadline field; ambiguity is "unverified", not success and not a contradiction', () => {
  const check = (due, card) => assertionCheck({due_at: due}, {title: 't', body: '', ...card});
  const body = text => ({body: text});
  // different dates / years are contradictions
  assert.deepEqual(check('2026-10-02', body('Due: 10/22')), {failures: ['due_at_not_on_card'], indeterminate: []});
  assert.deepEqual(check('2026-01-05', body('Due: 11/5')), {failures: ['due_at_not_on_card'], indeterminate: []});
  assert.deepEqual(check('2026-10-22', body('Due: 2026-10-25')), {failures: ['due_at_not_on_card'], indeterminate: []});
  assert.deepEqual(check('2026-10-22', body('Due: 2027-10-22')), {failures: ['due_at_not_on_card'], indeterminate: []});
  assert.deepEqual(check('2026-10-22', body('期限: 2027年10月22日')), {failures: ['due_at_not_on_card'], indeterminate: []});
  // matches
  for (const text of ['Due: 2026-10-22', 'Due: 2026/10/22', 'Deadline: 2026.10.22', '期限: 2026年10月22日', '- Due date: 2026-10-22 JST', '締切：2026-10-22']) assert.deepEqual(check('2026-10-22', body(text)), {failures: [], indeterminate: []}, text);
  assert.deepEqual(check('2026-10-22', {body: '', due_at: '2026-10-22'}), {failures: [], indeterminate: []}, 'structured field');
  assert.deepEqual(check('2026-10-22T00:00:00+09:00', body('Due: 2026年10月22日')), {failures: [], indeterminate: []});
  // a date elsewhere in the text is NOT the deadline, whether or not it equals the assertion
  assert.deepEqual(check('2026-10-22', body('Meeting on 2026-10-22 about something else')), {failures: [], indeterminate: ['due_at_not_in_deadline_field']});
  assert.deepEqual(check('2026-10-22', body('Meeting on 2026-10-23')), {failures: [], indeterminate: ['due_at_not_in_deadline_field']});
  assert.deepEqual(check('2026-10-22', {title: 'Review 2026-10-22', body: ''}), {failures: [], indeterminate: ['due_at_not_in_deadline_field']});
  // year unknown, several candidates, unsupported formats
  assert.deepEqual(check('2026-10-22', body('Due: 10/22')), {failures: [], indeterminate: ['due_at_year_unconfirmed']});
  assert.deepEqual(check('2026-10-22', body('期限: 10月22日')), {failures: [], indeterminate: ['due_at_year_unconfirmed']});
  assert.deepEqual(check('2026-10-22', body('Due: 2026-10-22\nDeadline: 2026-11-30')), {failures: [], indeterminate: ['due_at_multiple_candidates']});
  assert.deepEqual(check('2026-10-22', body('Due: 2026-10-22 or 2026-10-23')), {failures: [], indeterminate: ['due_at_multiple_candidates']});
  assert.deepEqual(check('2026-10-22', body('Due: 2027-10-22 (earlier 10/22)')), {failures: [], indeterminate: ['due_at_multiple_candidates']});
  for (const unsupported of ['Due: Oct 22', 'Due: 22 Oct 2026', 'Due: 令和8年10月22日', 'Due: tomorrow', 'Due: 来週', 'Due: 10-22', 'Due: soon', 'Due: ']) assert.deepEqual(check('2026-10-22', body(unsupported)), {failures: [], indeterminate: ['due_at_unsupported_format']}, unsupported);
  assert.deepEqual(check('2026-10-22', body('Due: 2026-10-22\nDeadline: 22 Oct 2026')), {failures: [], indeterminate: ['due_at_unsupported_format']});
  // digits glued to other digits are not dates; no date at all is the original defect (the card does not show the deadline)
  assert.deepEqual(check('2026-10-22', body('Due: 110/220')), {failures: [], indeterminate: ['due_at_unsupported_format']});
  assert.deepEqual(check('2026-10-22', body('Nothing about a deadline.')), {failures: ['due_at_not_on_card'], indeterminate: []});
  // through the verdict
  const d1 = {...delta, card_assertions: {due_at: '2026-10-02'}};
  const verdictFor = (d, text) => run({delta: d, card: {...goodCard, body: text}}).verdict;
  assert.equal(verdictFor(d1, 'Due: 10/22'), 'mismatch_content_not_reflected');
  assert.equal(verdictFor(d1, 'Due: 10/2'), 'unverified');
  assert.equal(verdictFor(d1, 'Due: 2026-10-02'), 'applied_verified');
  assert.equal(verdictFor(d1, 'Review 2026-10-02'), 'unverified');
  assert.equal(batchVerdict([run({delta: d1, card: {...goodCard, body: 'Due: 10/2'}})]), 'unverified');
});

// ---- blockers -------------------------------------------------------------------------------------------------------
test('blocker values: negative forms (with any punctuation) are NOT blocked; real text is blocked; anything uninterpretable is unverified', () => {
  const state = (body, extra = {}) => assertionCheck({blocked: true}, {status: 'In Progress', title: 't', body, ...extra});
  const notBlocked = ['none', 'None', 'None.', 'none。', 'NONE!', 'no blockers', 'No blockers.', 'no blockers!', 'No blocker', 'not blocked', 'Not blocked.', 'not blocked!!', 'N/A', 'n/a.', 'nil', 'nothing', 'なし', 'なし。', 'なし.', '無し', '特になし', '特になし。', '特に無し', '特になし！', 'ありません。', 'ない', '阻害なし', 'ブロックなし', '問題なし', '-', '—', '(none)', '「なし」'];
  for (const value of notBlocked) {
    assert.deepEqual(state(`Blocker: ${value}`), {failures: ['blocked_not_on_card'], indeterminate: []}, `blocked:true vs "${value}"`);
    assert.deepEqual(assertionCheck({blocked: false}, {status: 'In Progress', title: 't', body: `Blocker: ${value}`}), {failures: [], indeterminate: []}, `blocked:false vs "${value}"`);
  }
  for (const value of ['CLI DNS resolution fails', 'waiting for owner decision', '外部通信が不可', 'API quota exhausted', 'Blocked by upstream release']) {
    assert.deepEqual(state(`Blocker: ${value}`), {failures: [], indeterminate: []}, value);
    assert.deepEqual(assertionCheck({blocked: false}, {status: 'In Progress', title: 't', body: `Blocker: ${value}`}).failures, ['blocked_but_not_expected'], value);
  }
  for (const value of ['', '?', '？？', 'TBD', 'tbd.', 'unknown', '不明', '未定', 'not resolving yet', 'no balance obtained', 'dns resolved', '解消済み', 'ほぼなし', 'none of the above']) {
    assert.deepEqual(state(`Blocker: ${value}`), {failures: [], indeterminate: ['blocker_uninterpretable']}, `"${value}"`);
  }
  // free prose is never read as a blocker
  assert.deepEqual(state('this is not blocked').failures, ['blocked_not_on_card']);
  assert.deepEqual(state('unblocked since monday; blocked-by nothing').failures, ['blocked_not_on_card']);
  // labels and structured values; structured wins over the body
  assert.deepEqual(state('', {blocker: 'waiting for owner'}), {failures: [], indeterminate: []});
  assert.deepEqual(state('Blocker: CLI DNS', {blocker: 'None.'}), {failures: ['blocked_not_on_card'], indeterminate: []}, 'structured value first');
  assert.deepEqual(state('', {blocked: true}), {failures: [], indeterminate: []}); assert.deepEqual(state('', {blocked: false}), {failures: ['blocked_not_on_card'], indeterminate: []});
  assert.deepEqual(state('- 阻害: 外部通信が不可'), {failures: [], indeterminate: []}); assert.deepEqual(state('待ち理由：オーナーの判断'), {failures: [], indeterminate: []});
  assert.deepEqual(state('Blocker: CLI DNS\nBlocker: none'), {failures: [], indeterminate: ['blocker_uninterpretable']}, 'conflicting lines');
  // status Blocked is a real state; conflicting with an explicit "none" it is ambiguous
  assert.deepEqual(assertionCheck({blocked: true}, {status: 'Blocked', title: 't', body: ''}), {failures: [], indeterminate: []});
  assert.deepEqual(assertionCheck({blocked: true}, {status: 'Blocked', title: 't', body: 'Blocker: none'}), {failures: [], indeterminate: ['blocker_conflicts_with_status']});
  assert.deepEqual(assertionCheck({blocked: false}, {status: 'Blocked', title: 't', body: ''}), {failures: ['blocked_but_not_expected'], indeterminate: []});
  assert.deepEqual(assertionCheck({blocked: false}, {status: 'Blocked', title: 't', body: 'Blocker: none'}), {failures: [], indeterminate: ['blocker_conflicts_with_status']});
  assert.deepEqual(assertionCheck({blocked: true}, {status: 'In Progress', title: 't', body: ''}).failures, ['blocked_not_on_card']);
  // through the verdict (individual and batch agree)
  const d = {...delta, card_assertions: {blocked: true}};
  const r1 = run({delta: d, card: {...staleCard, body: 'this is not blocked'}}), r2 = run({delta: d, card: {...staleCard, body: 'Blocker: CLI DNS'}}), r3 = run({delta: d, card: {...staleCard, body: 'Blocker: TBD'}});
  assert.deepEqual([r1.verdict, r2.verdict, r3.verdict], ['mismatch_content_not_reflected', 'applied_verified', 'unverified']);
  assert.deepEqual([batchVerdict([r1]), batchVerdict([r2]), batchVerdict([r3])], ['mismatch', 'applied_verified', 'unverified']);
});

// ---- priority and consistency ---------------------------------------------------------------------------------------
test('verdict priority: a contradiction is never hidden behind insufficient evidence; findings stay separate', () => {
  const noTime = {batch_id: packet.batch_id}, nbytes = Buffer.from(JSON.stringify(noTime)), nbatch = {batch_id: packet.batch_id, packet_sha256: sha256(nbytes)};
  const base = {packet: noTime, packetBytes: nbytes, batch: nbatch, receipt: receipt({source_instruction_at: undefined})};
  const r1 = run({...base, card: staleCard});
  assert.equal(r1.verdict, 'mismatch_content_not_reflected');
  assert.ok(r1.findings.content.includes('status_mismatch')); assert.ok(r1.findings.insufficient.includes('source_instruction_at_missing_in_packet'));
  assert.equal(run({...base, card: goodCard}).verdict, 'unverified');
  assert.equal(run({receipt: receipt({before_hash: undefined, after_hash: undefined}), card: staleCard}).verdict, 'mismatch_content_not_reflected');
  assert.equal(run({priorCard: undefined, card: staleCard}).verdict, 'mismatch_content_not_reflected');
  const d = {...delta, card_assertions: {...delta.card_assertions, due_at: '2026-10-22'}};
  const r3 = run({delta: d, card: {...staleCard, body: 'Due: 10/22'}});
  assert.equal(r3.verdict, 'mismatch_content_not_reflected'); assert.ok(r3.findings.insufficient.includes('due_at_year_unconfirmed'));
  const r4 = run({receipt: receipt({received_at: 'soon'}), card: staleCard});
  assert.equal(r4.verdict, 'receipt_inconsistent'); assert.ok(r4.findings.receipt.includes('received_at_invalid')); assert.ok(r4.findings.content.includes('status_mismatch'));
  const noChange = {...delta, card_assertions: {...delta.card_assertions, expects_no_card_change: true, due_at: '2026-10-22'}};
  const r5 = run({delta: noChange, card: {...goodCard, body: 'Due: 10/22\nBlocker: CLI DNS fails'}});
  assert.equal(r5.verdict, 'declaration_inconsistent'); assert.ok(r5.findings.insufficient.includes('due_at_year_unconfirmed'));
  for (const r of [r1, r3, r4, r5]) { assert.deepEqual(Object.keys(r.findings).sort(), ['content', 'declaration', 'insufficient', 'owner', 'receipt']); for (const list of Object.values(r.findings)) for (const p of list) assert.ok(r.problems.includes(p)); }
  assert.equal(batchVerdict([r1]), 'mismatch'); assert.equal(batchVerdict([r5]), 'mismatch');
});

test('individual and batch verdicts agree for success, mismatch, insufficient evidence and owner decision', () => {
  const ok = run({card: goodCard}), mismatch = run({card: staleCard}), insufficient = run({card: goodCard, priorCard: undefined}), owner = run({delta: doneDelta, card: goodCard});
  assert.deepEqual([ok.verdict, mismatch.verdict, insufficient.verdict, owner.verdict], ['applied_verified', 'mismatch_content_not_reflected', 'unverified', 'needs_owner_decision']);
  assert.deepEqual([[ok], [mismatch], [insufficient], [owner]].map(batchVerdict), ['applied_verified', 'mismatch', 'unverified', 'needs_owner_decision']);
  assert.equal(batchVerdict([ok, ok]), 'applied_verified');
  assert.equal(batchVerdict([ok, insufficient]), 'unverified');
  assert.equal(batchVerdict([ok, owner]), 'needs_owner_decision');
  assert.equal(batchVerdict([ok, owner, mismatch]), 'mismatch');
  assert.equal(batchVerdict([]), 'unverified');
  // nothing that can verify is reachable without the evidence
  for (const strip of [{priorCard: undefined}, {recomputedHashes: undefined}, {receipt: receipt({before_hash: undefined})}, {receipt: undefined}]) assert.notEqual(run({card: goodCard, ...strip}).verdict, 'applied_verified', JSON.stringify(Object.keys(strip)));
});

test('batchSummary carries the deltas\' caveats to the batch (de-duplicated, never dropped) without making any verdict more successful', () => {
  const record = confirmationOf();
  const withRecord = () => run({delta: doneDelta, ownerConfirmations: [record], card: goodCard});
  const a = withRecord(), b = withRecord(), plain = run({card: goodCard});
  assert.deepEqual(a.caveats, ['owner_confirmation_record_authenticity_not_verified']);
  assert.deepEqual(plain.caveats, []);
  const summary = batchSummary([a, b, plain]);
  assert.deepEqual(summary.caveats, ['owner_confirmation_record_authenticity_not_verified'], 'duplicates are merged');
  assert.equal(summary.verdict, batchVerdict([a, b, plain]), 'the verdict is exactly the batch verdict');
  // caveats stay even when the batch is not a success, and are empty when no delta has one
  const mixed = batchSummary([a, run({card: staleCard})]);
  assert.equal(mixed.verdict, 'mismatch'); assert.deepEqual(mixed.caveats, ['owner_confirmation_record_authenticity_not_verified']);
  assert.deepEqual(batchSummary([plain]), {verdict: 'applied_verified', caveats: []});
  assert.deepEqual(batchSummary([]), {verdict: 'unverified', caveats: []});
  // a delta result without a caveats field (older callers) does not break the summary
  assert.deepEqual(batchSummary([{verdict: 'unverified'}]), {verdict: 'unverified', caveats: []});
  // a used record on a delta that otherwise verifies: the delta and the batch are applied_verified AND still carry the caution
  const reopenOk = run({delta: doneDelta, priorCard: {...priorCard, status: 'Done'}, ownerConfirmations: [record], card: goodCard});
  assert.equal(reopenOk.verdict, 'applied_verified');
  assert.deepEqual(batchSummary([reopenOk]), {verdict: 'applied_verified', caveats: ['owner_confirmation_record_authenticity_not_verified']});
});
