// Synthetic non-GUI regressions only. Real Chrome / pinned Backlog browser tests run separately.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['cloud/tests', 'tests'].flatMap(dir => readdirSync(dir)
  .filter(name => name.endsWith('.test.mjs') && name !== 'board-layout.test.mjs')
  .map(name => `${dir}/${name}`));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
