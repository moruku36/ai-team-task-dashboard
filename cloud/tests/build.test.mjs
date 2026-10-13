import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, assets } from '../build.mjs';
test('static output contains only three allowlisted assets; unexpected files fail build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-build-synthetic-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'cloud', 'public'), { recursive: true });
  for (const name of assets) await writeFile(join(root, 'cloud', 'public', name), `synthetic-${name}`);
  await writeFile(join(root, '.env'), 'SYNTHETIC_SECRET'); await writeFile(join(root, 'README.md'), 'synthetic source document');
  const output = await build(root); assert.deepEqual((await readdir(output)).sort(), [...assets].sort());
  for (const name of assets) assert.equal(await readFile(join(output, name), 'utf8'), `synthetic-${name}`);
  await writeFile(join(output, 'README.md'), 'unexpected'); await assert.rejects(build(root), /Unexpected public output/);
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.outputDirectory, 'dist/public'); assert.equal(config.buildCommand, 'node cloud/build.mjs');
  assert.deepEqual(config.rewrites.map(r => r.source), ['/api/tasks']);
});
