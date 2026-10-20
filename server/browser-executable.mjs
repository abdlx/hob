// Chromium executable discovery, deliberately free of runtime dependencies.
//
// The deployment probe runs from /app/deploy, where the server's `ws` dependency
// is not resolvable; importing browser-launcher.mjs there would fail. This module
// keeps discovery shared between the application and the container probe so the
// probe can never pass with a layout the application cannot launch.

import { accessSync, constants as fsConstants, readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

// Candidate executables, most specific first. `PLAYWRIGHT_BROWSERS_PATH` is
// consulted because the production Linux image ships Chromium under
// /opt/hermes/tools rather than on PATH.
export function linuxCandidates() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/hermes/tools', '/opt/hermes/chromium', '/usr/lib/chromium'];
  const names = ['chrome', 'headless_shell', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    out.push(path.join(root, 'chrome'), path.join(root, 'chromium'), path.join(root, 'chrome-linux', 'chrome'),
      path.join(root, 'chrome-linux64', 'chrome'));
    for (const name of names) out.push(path.join(root, name));
    // Playwright / Chrome for Testing keep Chromium under a revision directory:
    // chromium-<revision>/chrome-linux/chrome or .../chrome-linux64/chrome.
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { /* next root */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^chrom(e|ium)(_headless_shell|-headless-shell)?-\d+$/.test(entry.name)) continue;
      for (const directory of ['chrome-linux', 'chrome-linux64']) {
        for (const name of names) out.push(path.join(root, entry.name, directory, name));
      }
    }
  }
  for (const name of names) out.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`);
  return out;
}

function darwinCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
}

function windowsCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(programFiles, 'Chromium\\Application\\chrome.exe'),
  ].filter(Boolean);
}

export function chromiumCandidates() {
  const explicit = (process.env.HOB_CHROMIUM_PATH || '').trim();
  const discovered = process.platform === 'win32' ? windowsCandidates()
    : process.platform === 'darwin' ? darwinCandidates() : linuxCandidates();
  return explicit ? [explicit, ...discovered] : discovered;
}

/**
 * Locate a Chromium-family executable. Returns `null` rather than throwing so
 * callers can report an actionable "install Chromium" error at start time.
 */
/** Bounded search for a browser binary, for layouts that are not fixed. */
export function findChromiumExecutable(directory, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isFile() || !['chrome', 'chromium', 'headless_shell'].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* not executable */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findChromiumExecutable(path.join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

export async function resolveChromiumExecutable() {
  for (const candidate of chromiumCandidates()) {
    try {
      await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  if (process.platform !== 'win32') {
    for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/hermes/tools', '/opt/hermes/chromium']) {
      if (!root) continue;
      const found = findChromiumExecutable(root);
      if (found) return found;
    }
  }
  return null;
}
