// Minimal regression: modified official binary must be refused before --version or any other spawn.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--exe');
const source = i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(repo, '.runtime', 'backlog.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ttd-binguard-'));
assert.equal(path.dirname(root), os.tmpdir());
const modified = path.join(root, 'modified-backlog.exe');
const outputs = path.join(root, 'results');
try {
  fs.copyFileSync(source, modified);
  fs.appendFileSync(modified, Buffer.from('synthetic corruption regression'));
  const result = spawnSync(process.execPath, [path.join(repo, 'tests', 'frontend.mjs'), '--exe', modified, '--results-dir', outputs, '--preflight-only'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  const names = fs.readdirSync(outputs);
  assert.equal(names.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(outputs, names[0]), 'utf8'));
  assert.equal(report.ok, false);
  assert.match(report.error, /official pinned SHA-256 before execution/);
  assert.equal(report.metrics.childProcessStarts, 0);
  assert.equal(report.checks.some(c => c.name === 'binary reports v1.53.0'), false);
  assert.ok(Object.values(report.tempDirsRemoved).every(Boolean));
  console.log('PASS modified binary rejected by official digest before any child process starts; --version not executed; frontend temp roots removed');
} finally {
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('ai-ttd-binguard-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(fs.existsSync(root), false, 'binary guard temp root cleanup failed');
}
