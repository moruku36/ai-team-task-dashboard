// The command-line entry point, run as a real child process on synthetic files in a temporary folder (nothing real is read).
// The CLI supplies neither a prior card nor recomputed hashes, so it can never print applied_verified: its output is reference information.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../scripts/inbox-receipt-verify.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'inbox-receipt-verify.mjs');
const HA = sha256('synthetic-before'), HB = sha256('synthetic-after');
const INSTRUCTION = '2026-10-21T07:44:42Z';

function synthetic(root) {
  const receipts = path.join(root, 'receipts'); mkdirSync(receipts);
  const d1 = {event_id: 'e1', target_id_hint: 'T1', source_message_ids: ['m1'], card_assertions: {status: 'Blocked', must_include: ['SYNTHETIC-CARD-TEXT']}};
  const d2 = {event_id: 'e2', target_id_hint: 'T2', owner_confirmed_target_task_id: 'T2', source_message_ids: ['m2'], card_assertions: {must_include: ['SYNTHETIC-CARD-TEXT']}};
  const packet = {batch_id: 'b1', source_instruction_at: INSTRUCTION, deltas: [d1, d2]};
  const packetPath = path.join(root, 'packet.json'), bytes = Buffer.from(JSON.stringify(packet)); writeFileSync(packetPath, bytes);
  for (const [d, task] of [[d1, 'T1'], [d2, 'T2']]) writeFileSync(path.join(receipts, `${d.event_id}.json`), JSON.stringify({event_id: d.event_id, batch_id: 'b1', application_state: 'applied', received_at: '2026-10-21T09:00:00Z',
    applied_at: '2026-10-21T09:05:00Z', target_task_id: task, before_hash: HA, after_hash: HB, readback_verified: true, source_instruction_at: INSTRUCTION}));
  const inbox = path.join(root, 'inbox.json');
  writeFileSync(inbox, JSON.stringify({batches: [{batch_id: 'b1', packet_path: packetPath, packet_sha256: sha256(bytes), receipt_directory: receipts, application_state: 'unapplied'}]}));
  const cards = path.join(root, 'cards.json');
  writeFileSync(cards, JSON.stringify({T1: {status: 'Blocked', title: 't', body: 'SYNTHETIC-CARD-TEXT'}, T2: {status: 'In Progress', title: 't', body: 'SYNTHETIC-CARD-TEXT'}}));
  const confirmations = path.join(root, 'confirmations.json');
  writeFileSync(confirmations, JSON.stringify([{event_id: 'e2', task_id: 'T2', confirmed_at: '2026-10-21T08:00:00Z', basis_id: 'm2'}]));
  return {inbox, cards, confirmations};
}
const runCli = args => {
  const r = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  return {lines, raw: r.stdout};
};

test('CLI (real child process): never prints applied_verified, says its output is reference only, and keeps the caution about unauthenticated confirmation records', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-cli-test-'));
  try {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    const f = synthetic(root);
    // Every input the CLI can take is present and consistent: owner confirmation matches, cards satisfy the assertions, receipts are well-formed.
    const {lines, raw} = runCli([f.inbox, '--cards', f.cards, '--confirmations', f.confirmations]);
    assert.equal(lines.length, 1);
    const [batch] = lines;
    assert.equal(batch.reference_only, true);
    assert.deepEqual(batch.limits, ['no_prior_card_supplied', 'no_recomputed_hashes_supplied']);
    assert.notEqual(batch.verified, 'applied_verified'); assert.equal(batch.verified, 'unverified');
    for (const d of batch.deltas) {
      assert.notEqual(d.verdict, 'applied_verified', d.event_id); assert.equal(d.verdict, 'unverified');
      assert.ok(d.problems.includes('prior_state_unavailable')); assert.ok(d.problems.includes('card_hash_not_recomputed'));
    }
    // the caution travels with the delta that used the record, and to the batch; the other delta has none
    const [e1, e2] = batch.deltas;
    assert.deepEqual(e1.caveats, []);
    assert.deepEqual(e2.caveats, ['owner_confirmation_record_authenticity_not_verified']);
    assert.deepEqual(batch.caveats, ['owner_confirmation_record_authenticity_not_verified']);
    // ids, verdicts and codes only: no card text
    assert.doesNotMatch(raw, /SYNTHETIC-CARD-TEXT/);

    // Without the records the CLI neither invents a caution nor a confirmation: the self-declared one stays an open owner question.
    const without = runCli([f.inbox, '--cards', f.cards]).lines[0];
    assert.equal(without.verified, 'needs_owner_decision'); assert.deepEqual(without.caveats, []);
    assert.equal(without.deltas[1].verdict, 'needs_owner_decision'); assert.deepEqual(without.deltas[1].caveats, []);
    assert.equal(without.reference_only, true);
    // Without cards nothing can be compared: still not applied_verified
    const noCards = runCli([f.inbox]).lines[0];
    assert.notEqual(noCards.verified, 'applied_verified'); for (const d of noCards.deltas) assert.notEqual(d.verdict, 'applied_verified');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('CLI (real child process): an unreachable packet path or unparseable packet is reported, not skipped or promoted', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-cli-test-'));
  try {
    const f = synthetic(root);
    writeFileSync(path.join(root, 'packet.json'), '{not json');
    assert.equal(runCli([f.inbox]).lines[0].verified, 'packet_unparseable');
    writeFileSync(f.inbox, JSON.stringify({batches: [{batch_id: 'b2', packet_path: path.join(root, 'missing.json'), packet_sha256: 'x', receipt_directory: root, application_state: 'applied'}]}));
    assert.equal(runCli([f.inbox]).lines[0].verified, 'packet_path_unreachable');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
