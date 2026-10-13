import { readFile } from 'node:fs/promises';
import { connectStore, initialize } from './postgres.mjs';
import { taskInput, Problem } from './model.mjs';
const [operation, file, ...flags] = process.argv.slice(2);
if (operation === 'plan') {
  const tasks = JSON.parse(await readFile(file, 'utf8')).map(taskInput);
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || tasks.length > 1000) throw new Error('Duplicate ID or too many tasks');
  console.log(JSON.stringify({ count: tasks.length, statuses: Object.fromEntries([...new Set(tasks.map(t => t.status))].map(s => [s, tasks.filter(t => t.status === s).length])) }));
} else if (operation === 'init' || operation === 'import') {
  if (!flags.includes('--approved-resource')) throw new Error('Resource approval required');
  const store = await connectStore();
  try {
    if (operation === 'init') await initialize(store);
    else {
      if (!flags.includes('--confirm-cloud-authoritative')) throw new Error('Cutover confirmation required');
      const tasks = JSON.parse(await readFile(file, 'utf8')).map(taskInput);
      if (new Set(tasks.map(t => t.id)).size !== tasks.length || tasks.length > 1000) throw new Error('Invalid inventory');
      await store.transaction(board => {
        if (board.tasks.length || board.revision) throw new Problem(409, 'Import only into empty canonical store');
        board.tasks = tasks.map(t => ({ ...t, version: 1, updatedAt: new Date().toISOString() }));
        board.revision = 1;
        board.audit.push({ revision: 1, actor: 'owner', at: new Date().toISOString(), count: tasks.length, action: 'cutover-import' });
      });
    }
  } finally { await store.pool.end(); }
} else throw new Error('Usage: plan FILE | init placeholder --approved-resource | import FILE --approved-resource --confirm-cloud-authoritative');
