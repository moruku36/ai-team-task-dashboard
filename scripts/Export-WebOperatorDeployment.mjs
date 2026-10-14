// Packages reviewed Web source; authenticating/deploying is delegated to the existing Vercel connector.
// No credential retrieval, network call or local Backlog write.
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const commit = option('--commit'), output = option('--output'), request = option('--job-request');
if (!commit || !output) throw Error('--commit and private --output required');
const outside = file => { const path = resolve(file), r = relative(root, path); if (!r || !r.startsWith('..') && !isAbsolute(r)) throw Error('Private file must be outside repository'); return path; };
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== commit || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw Error('Exact clean commit required');
const paths = ['package.json','vercel.json','api/index.mjs','cloud/server.mjs','cloud/postgres.mjs','cloud/model.mjs','cloud/synthetic.mjs','cloud/auth.mjs','cloud/owner-auth.mjs','cloud/quota.mjs','cloud/quota-freshness.mjs','cloud/build.mjs','cloud/build-deployment.mjs','cloud/deployment-preflight.mjs','cloud/public/index.html','cloud/public/app.js','cloud/public/style.css','cloud/public/favicon.png','cloud/usage-metadata.mjs'];
if (request) paths.push('cloud/task-operator.mjs','cloud/run-task-operator-job.mjs');
const files = paths.map(file => {
  for (let n = 1; n <= file.split('/').length; n++) if (lstatSync(resolve(root, ...file.split('/').slice(0, n))).isSymbolicLink()) throw Error('Linked source refused');
  let bytes = readFileSync(resolve(root, file));
  // vercel.json overrides request projectSettings; change only this private deployment copy.
  if (request && file === 'vercel.json') { const config = JSON.parse(bytes); config.buildCommand = 'node cloud/run-task-operator-job.mjs'; bytes = Buffer.from(JSON.stringify(config)); }
  return { file, data: bytes.toString('base64'), encoding: 'base64' };
});
if (request) { const raw = readFileSync(outside(request)); if (raw.length > 65536) throw Error('Private request too large'); const value = JSON.parse(raw); if (!['inspect','apply'].includes(value.mode)) throw Error('Invalid job mode'); files.push({ file: 'task-operator-request.json', data: raw.toString('base64'), encoding: 'base64' }); }
writeFileSync(outside(output), JSON.stringify({ commit, files, buildCommand: request ? 'node cloud/run-task-operator-job.mjs' : 'node cloud/build-deployment.mjs' }));
console.log(JSON.stringify({ commit, sourceFiles: files.length, privateRequestIncluded: Boolean(request) }));
