import { pathToFileURL } from 'node:url';
import { deploymentPreflight } from './deployment-preflight.mjs';
import { build } from './build.mjs';

export async function buildDeployment(root) {
  const result = deploymentPreflight(root);
  if (!result.ready) throw new Error('Deployment dependency preflight failed: ' + result.issues.join(', '));
  return build(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await buildDeployment()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
