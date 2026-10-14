// An authenticated Vercel operator explicitly invokes this with a one-job private request.
// Existing production credentials stay inside Vercel. No new endpoint or credential.
import { readFileSync } from 'node:fs';
import { buildDeployment } from './build-deployment.mjs';
import { connectStore } from './postgres.mjs';
import { applyOperatorBatch, inspectOperatorMatches, taskDigest } from './task-operator.mjs';
let store, stage = 'preflight', committed = false;
try {
  await buildDeployment();
  if (process.env.DATABASE_NEON_PROJECT_ID !== 'bold-wave-73777705' || !process.env.OWNER_VERCEL_SUBJECT) throw Error('Wrong target');
  stage = 'request'; const request = JSON.parse(readFileSync('task-operator-request.json', 'utf8'));
  if (!request || Object.keys(request).some(k => !['mode', 'batch'].includes(k)) || !['inspect', 'apply'].includes(request.mode)) throw Error('Invalid mode');
  stage = 'connect'; store = await connectStore();
  if (request.mode === 'inspect') {
    console.log('DASHBOARD_OPERATOR_INSPECT=' + JSON.stringify({ matches: await inspectOperatorMatches(store, request.batch), credentialsExported: false }));
  } else {
    const before = await store.read();
    const preserved = taskDigest({ quota: before.quota, migrationArchive: before.migrationArchive });
    stage = 'apply'; const result = await applyOperatorBatch(store, request.batch); committed = true;
    stage = 'readback'; const board = await store.read();
    for (const saved of result.results) if (taskDigest(board.tasks.find(t => t.id === saved.id)) !== saved.taskDigest) throw Error('Readback differs');
    if (taskDigest({ quota: board.quota, migrationArchive: board.migrationArchive }) !== preserved) throw Error('Preserved data changed');
    const changedIds = new Set(result.results.map(t => t.id));
    for (const old of before.tasks.filter(t => !changedIds.has(t.id))) if (taskDigest(board.tasks.find(t => t.id === old.id)) !== taskDigest(old)) throw Error('Unrelated task changed');
    console.log('DASHBOARD_OPERATOR_PROOF=' + JSON.stringify({ ...result, readbackVerified: true, unrelatedTasksPreserved: true, quotaAndArchivePreserved: true, credentialsExported: false, localStoreTouched: false }));
  }
} catch { console.error('DASHBOARD_OPERATOR_FAILED=' + JSON.stringify({ stage, transactionCommitted: committed })); process.exitCode = 1; }
finally { await store?.pool.end(); }
