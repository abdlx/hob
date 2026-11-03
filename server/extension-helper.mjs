// Alias to browser-extension.mjs for extension management.
export * from './browser-extension.mjs';
import { installExtension } from './browser-extension.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , extensionId, profileDir] = process.argv;
  if (!extensionId || !profileDir) {
    console.error('Usage: node extension-helper.mjs <extensionId> <profileDir>');
    process.exit(1);
  }
  try {
    const result = await installExtension(extensionId, profileDir);
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
}
