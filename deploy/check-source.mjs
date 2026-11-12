import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Check the exact release source bytes before constructing a runtime image.
const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
async function inspect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'build'].includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await inspect(filename);
    else if (item.isFile() && item.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Invalid release source: ${path.relative(root, filename)}\n${result.stderr || result.error?.message || ''}`);
      checked++;
    }
  }
}
for (const directory of ['server', 'deploy', 'portal/src']) await inspect(path.join(root, directory));
console.log(`Release syntax verified: ${checked} JavaScript modules.`);
