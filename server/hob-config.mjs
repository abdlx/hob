import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';

/** One upgrade boundary; application code uses only the canonical HOB namespace. */
export function hobEnv(source = process.env) {
  const result = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('MUSE_')) continue;
    const canonical = `HOB_${key.slice(5)}`;
    if (result[canonical] === undefined) result[canonical] = value;
    delete result[key];
  }
  return result;
}

export async function hobLocalHome(projectDir) {
  const root = path.resolve(projectDir);
  const destination = path.join(root, '.hob-data');
  const legacy = path.join(root, '.muse-data');
  const [current, previous] = await Promise.all([destination, legacy].map(value => lstat(value).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })));
  if (current && previous) throw new Error('Two local data directories exist. Set HERMES_HOME explicitly before starting hob.');
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('The legacy data directory must be a real directory. Set HERMES_HOME explicitly.');
    await rename(legacy, destination);
  }
  if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error('The hob data directory must be a real directory.');
  return path.join(destination, 'hermes');
}
