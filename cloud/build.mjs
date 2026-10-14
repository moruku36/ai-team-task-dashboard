import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const assets = ['index.html', 'app.js', 'style.css', 'favicon.png'];
export async function build(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  for (const directory of [root, join(root, 'cloud'), join(root, 'cloud', 'public')]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked or non-directory source refused');
  }
  const dist = join(root, 'dist'), output = join(dist, 'public');
  for (const path of [dist, output]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Linked output refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path, { recursive: true });
  }
  const existing = await readdir(output);
  if (existing.some(name => !assets.includes(name))) throw new Error('Unexpected public output; refusing to publish');
  for (const name of assets) {
    const source = join(root, 'cloud', 'public', name);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Linked or non-file source refused');
    const target = join(output, name);
    try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Non-file output refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(target, await readFile(source));
  }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await build());
