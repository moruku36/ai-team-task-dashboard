// Offline packaging preflight. Never installs, connects to storage, or authenticates.
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export function deploymentPreflight(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const issues = [];
  const fail = code => { if (!issues.includes(code)) issues.push(code); };
  const file = name => {
    try {
      const parts = name.split('/');
      for (let index = 0; index < parts.length; index++) {
        const info = lstatSync(join(root, ...parts.slice(0, index + 1)));
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw Error('Invalid file');
      }
      return readFileSync(join(root, name), 'utf8');
    } catch { fail(`missing_or_unsafe:${name}`); return null; }
  };
  const json = name => { const text = file(name); if (text === null) return null; try { return JSON.parse(text); } catch { fail(`invalid_json:${name}`); return null; } };
  const manifest = json('package.json'), lock = json('package-lock.json');
  if (!/^\d+\.\d+\.\d+$/.test(manifest?.dependencies?.pg ?? '')) fail('pg_must_have_exact_root_version');
  for (const name of ['api/index.mjs','cloud/server.mjs','cloud/postgres.mjs','cloud/model.mjs','cloud/synthetic.mjs','cloud/auth.mjs','cloud/owner-auth.mjs','cloud/quota.mjs','cloud/quota-freshness.mjs']) file(name);
  if (lock) {
    if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') fail('unsupported_lockfile');
    if (lock.packages?.['']?.dependencies?.pg !== manifest?.dependencies?.pg || lock.packages?.['node_modules/pg']?.version !== manifest?.dependencies?.pg) fail('root_pg_lock_mismatch');
    for (const [name, value] of Object.entries(lock.packages ?? {})) {
      if (name === '') continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('invalid_locked_package'); continue; }
      if (!name.startsWith('node_modules/') || value.link || typeof value.version !== 'string') fail('invalid_locked_package');
      let url; try { url = new URL(value.resolved); } catch { /* refused below */ }
      if (!url || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.port || url.search || url.hash || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity ?? '')) fail('unverified_locked_artifact');
    }
  }
  const installed = json('node_modules/pg/package.json');
  if (installed && installed.version !== manifest?.dependencies?.pg) fail('installed_pg_version_mismatch');
  if (installed) {
    try {
      const entry = createRequire(join(root, 'package.json')).resolve('pg');
      const expected = join(root, 'node_modules', 'pg') + '/';
      if (!entry.replaceAll('\\','/').startsWith(expected.replaceAll('\\','/'))) fail('pg_resolves_outside_project');
    } catch { fail('pg_entry_unresolvable'); }
  }
  return { ready: issues.length === 0, issues, checks: 'offline root manifest, lock integrity metadata, source files and installed pg entry', deploymentTraceVerified: false, databaseVerified: false, authenticationVerified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = deploymentPreflight(); console.log(JSON.stringify(result, null, 2)); if (!result.ready) process.exitCode = 1;
}
