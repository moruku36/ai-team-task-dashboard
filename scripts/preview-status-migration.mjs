// Read-only preview of the four-column status migration. Writes nothing; prints IDs, current status and the proposed
// target only (never titles, descriptions or notes). Usage: node scripts/preview-status-migration.mjs <tasks-dir> [more dirs...]
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const legacyTargets = Object.freeze({
  'Awaiting Approval': {proposed: 'Blocked', reason: 'waiting for an owner decision (external wait); confirm per card'},
  'Verifying': {proposed: 'In Progress', reason: 'work is under check; Done only with completion evidence, never automatic'}
});
const keep = new Set(['To Do', 'In Progress', 'Blocked', 'Done']);

export function previewFromFiles(files) {
  const rows = [], counts = {};
  for (const {name, text} of files) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const status = /^status:\s*['"]?(.+?)['"]?\s*$/m.exec(front)?.[1];
    const id = /^id:\s*['"]?(.+?)['"]?\s*$/m.exec(front)?.[1] ?? name.replace(/\.md$/, '').split(' - ')[0];
    if (!status) { rows.push({id, status: null, action: 'review', reason: 'status not found'}); continue; }
    counts[status] = (counts[status] ?? 0) + 1;
    if (keep.has(status)) continue;
    const target = legacyTargets[status];
    rows.push({id, status, action: target ? 'propose' : 'review', proposed: target?.proposed ?? null, reason: target?.reason ?? 'unknown status; no automatic mapping'});
  }
  return {counts, rows};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) throw new Error('Usage: node scripts/preview-status-migration.mjs <tasks-dir> [...]');
  const files = dirs.flatMap(dir => readdirSync(dir).filter(n => n.endsWith('.md')).map(name => ({name, text: readFileSync(join(dir, name), 'utf8')})));
  console.log(JSON.stringify(previewFromFiles(files), null, 1));
}
