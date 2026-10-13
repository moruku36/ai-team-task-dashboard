import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentPreflight } from '../deployment-preflight.mjs';
import { buildDeployment } from '../build-deployment.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'cloud-offline-packaging-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'api')); await mkdir(join(root,'cloud'));
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',dependencies:{pg:'8.23.1'}}));
  for (const file of ['api/index.mjs','cloud/server.mjs','cloud/postgres.mjs','cloud/model.mjs','cloud/synthetic.mjs','cloud/auth.mjs','cloud/quota.mjs','cloud/quota-freshness.mjs']) await writeFile(join(root,file),'// synthetic source');
  return root;
}
test('new auth/quota sources are required and unsafe (directory) or missing ones block like existing sources',async t=>{
  const root=await fixture(t);await writeFile(join(root,'package-lock.json'),JSON.stringify(lock()));
  for (const name of ['cloud/auth.mjs','cloud/quota.mjs','cloud/quota-freshness.mjs']) {
    const path=join(root,name);await rm(path);
    assert.ok(deploymentPreflight(root).issues.includes(`missing_or_unsafe:${name}`));
    await mkdir(path);assert.ok(deploymentPreflight(root).issues.includes(`missing_or_unsafe:${name}`));
    await rm(path,{recursive:true});await writeFile(path,'// synthetic source');
  }
  assert.ok(!deploymentPreflight(root).issues.some(code=>/auth|quota/.test(code)));
});
const lock = () => ({lockfileVersion:3,packages:{'':{dependencies:{pg:'8.23.1'}},'node_modules/pg':{version:'8.23.1',resolved:'https://registry.npmjs.org/pg/-/pg-8.23.1.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}});
test('static asset success does not hide missing lockfile or installed database driver',async t=>{
  const root=await fixture(t),result=deploymentPreflight(root);
  assert.equal(result.ready,false);assert.ok(result.issues.includes('missing_or_unsafe:package-lock.json'));assert.ok(result.issues.includes('missing_or_unsafe:node_modules/pg/package.json'));
  assert.equal(result.deploymentTraceVerified,false);assert.equal(result.databaseVerified,false);assert.equal(result.authenticationVerified,false);
  await assert.rejects(buildDeployment(root),/Deployment dependency preflight failed/);
  await assert.rejects(stat(join(root,'dist')),error=>error.code==='ENOENT');
});
test('lockfile rejects version drift, missing integrity, credential URLs and malformed package records',async t=>{
  const root=await fixture(t);
  for (const change of [value=>{value.packages['node_modules/pg'].version='8.0.0';},value=>{delete value.packages['node_modules/pg'].integrity;},value=>{value.packages['node_modules/pg'].resolved='https://SYNTHETIC_SECRET@registry.npmjs.org/pg.tgz';},value=>{value.packages['node_modules/pg']=null;}]) {
    const value=lock();change(value);await writeFile(join(root,'package-lock.json'),JSON.stringify(value));const result=deploymentPreflight(root);assert.equal(result.ready,false);assert.ok(result.issues.some(code=>/lock|artifact/.test(code)));assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  }
});
test('offline checks stay separate from real platform tracing and installed version mismatch blocks',async t=>{
  const root=await fixture(t);await writeFile(join(root,'package-lock.json'),JSON.stringify(lock()));
  const module=join(root,'node_modules','pg');await mkdir(module,{recursive:true});await writeFile(join(module,'index.js'),'module.exports={}');
  await writeFile(join(module,'package.json'),JSON.stringify({name:'pg',version:'8.23.1',main:'index.js'}));
  const result=deploymentPreflight(root);assert.equal(result.ready,true);assert.equal(result.deploymentTraceVerified,false);
  await writeFile(join(module,'package.json'),JSON.stringify({name:'pg',version:'8.0.0',main:'index.js'}));assert.ok(deploymentPreflight(root).issues.includes('installed_pg_version_mismatch'));
});
