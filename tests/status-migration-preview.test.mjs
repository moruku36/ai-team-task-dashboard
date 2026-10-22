import test from 'node:test';
import assert from 'node:assert/strict';
import {previewFromFiles} from '../scripts/preview-status-migration.mjs';

const card = (id, status) => ({name: `${id.toLowerCase()} - Synthetic.md`, text: `---\nid: ${id}\ntitle: Synthetic\nstatus: ${status}\n---\nbody that must never be echoed`});

test('preview lists only legacy cards, never maps to Done, never echoes bodies', () => {
  const result = previewFromFiles([card('T-1', 'To Do'), card('T-2', 'Verifying'), card('T-3', 'Awaiting Approval'), card('T-4', 'Done'), card('T-5', 'Odd Status')]);
  assert.deepEqual(result.rows.map(r => [r.id, r.action, r.proposed]), [['T-2', 'propose', 'In Progress'], ['T-3', 'propose', 'Blocked'], ['T-5', 'review', null]]);
  assert.ok(result.rows.every(r => r.proposed !== 'Done'));
  assert.doesNotMatch(JSON.stringify(result), /body that must never/);
  assert.equal(result.counts.Verifying, 1);
});
