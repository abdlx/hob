import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function seedHermesConfig(home, workspace) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Native Hermes settings only. JSON is a YAML subset; Hermes owns migrations.
  const config = { gateway: { multiplex_profiles: true }, terminal: { cwd: workspace },
    auth: { adopt_external_logins: false } };
  try {
    await writeFile(join(home, 'config.yaml'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const home = resolve(process.env.HERMES_HOME || '/opt/data');
  await seedHermesConfig(home, resolve(process.env.HOB_MAIN_WORKSPACE || join(home, 'workspaces', 'main')));
}
