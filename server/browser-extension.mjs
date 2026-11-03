// Chrome extension management for HOB managed browsers.
//
// Downloads unpacked extensions or CRX3 packages via Google Omaha,
// strips the CRX header, extracts the ZIP payload into `<profileDir>/extensions/<id>`,
// and validates `manifest.json`.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OMAHA_URL = 'https://clients2.google.com/service/update2/crx';
export const OMAHA_PRODVERSION = '130.0';
export const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Build the Omaha download URL for a given extension ID and Chrome version.
 *
 * @param {string} extensionId Chrome extension ID (e.g. 32-char webstore ID)
 * @param {string} [prodversion='130.0'] Target Chrome product version
 * @returns {string} Fully qualified Omaha download URL
 */
export function omahaUrl(extensionId, prodversion = OMAHA_PRODVERSION) {
  if (!extensionId || typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`Invalid extension ID "${extensionId}".`);
  }
  const params = new URLSearchParams({
    response: 'redirect',
    prodversion,
    acceptformat: 'crx2,crx3',
    x: `id=${extensionId}&uc`,
  });
  return `${OMAHA_URL}?${params.toString()}`;
}

/**
 * Download a CRX package from Google Omaha.
 *
 * @param {string} extensionId Chrome extension ID
 * @param {object} [options]
 * @param {string} [options.prodversion='130.0']
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<Buffer>} CRX file bytes
 */
export async function downloadCrx(extensionId, { prodversion = OMAHA_PRODVERSION, fetchImpl = fetch } = {}) {
  const url = omahaUrl(extensionId, prodversion);
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download extension "${extensionId}": HTTP ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Strip the CRX header (CRX3 or CRX2) and return the raw ZIP archive buffer.
 *
 * CRX3 structure:
 *   - bytes 0-3: Magic "Cr24" (0x43 0x72 0x32 0x34)
 *   - bytes 4-7: Version (3, little-endian)
 *   - bytes 8-11: Header size N (little-endian)
 *   - bytes 12..(12+N-1): Header data
 *   - bytes (12+N)..: ZIP payload (starts with "PK")
 *
 * @param {Buffer|Uint8Array} crxBuffer Raw CRX file buffer
 * @returns {Buffer} Stripped ZIP archive buffer
 */
export function stripCrxHeader(crxBuffer) {
  const buf = Buffer.isBuffer(crxBuffer) ? crxBuffer : Buffer.from(crxBuffer);
  if (buf.length < 16) {
    throw new Error('Buffer too small to be a valid CRX or ZIP package.');
  }

  // Already a raw ZIP archive
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return buf;
  }

  const magic = buf.subarray(0, 4).toString('utf8');
  if (magic !== 'Cr24') {
    throw new Error(`Invalid CRX magic: expected "Cr24", got "${magic}".`);
  }

  const version = buf.readUInt32LE(4);
  let zipOffset;

  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    zipOffset = 12 + headerSize;
  } else if (version === 2) {
    const keySize = buf.readUInt32LE(8);
    const sigSize = buf.readUInt32LE(12);
    zipOffset = 16 + keySize + sigSize;
  } else {
    throw new Error(`Unsupported CRX version: ${version}.`);
  }

  if (zipOffset > buf.length) {
    throw new Error(`CRX header size (${zipOffset}) exceeds buffer length (${buf.length}).`);
  }

  const zip = buf.subarray(zipOffset);
  if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new Error('CRX payload does not contain a valid ZIP archive signature.');
  }

  return zip;
}

/**
 * Unzip extension ZIP buffer into target directory using the Python zipfile CLI.
 *
 * @param {Buffer} zipBuffer Raw ZIP archive bytes
 * @param {string} targetDir Destination directory
 * @param {object} [options]
 * @param {string} [options.pythonBin] Python executable path
 */
export async function unzipExtension(zipBuffer, targetDir, { pythonBin = process.env.HERMES_PYTHON || 'python3' } = {}) {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const tempZipPath = path.join(tmpdir(), `hob-ext-${randomUUID()}.zip`);
  await writeFile(tempZipPath, zipBuffer);
  try {
    const proc = spawnSync(pythonBin, ['-m', 'zipfile', '-e', tempZipPath, targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (proc.status !== 0) {
      const err = proc.stderr?.toString('utf8') || `exit code ${proc.status}`;
      throw new Error(`Failed to extract extension ZIP: ${err}`);
    }
  } finally {
    await rm(tempZipPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Validate that `manifest.json` exists in `targetDir` and has required fields.
 *
 * @param {string} targetDir Unpacked extension directory
 * @returns {Promise<object>} Parsed manifest object
 */
export async function validateManifest(targetDir) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  let content;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`Missing manifest.json in extension directory: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in manifest.json: ${err.message}`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Extension manifest must be a JSON object.');
  }

  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new Error('Missing or empty "name" in manifest.json.');
  }

  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    throw new Error('Missing or empty "version" in manifest.json.');
  }

  if (typeof manifest.manifest_version !== 'number' || manifest.manifest_version < 2) {
    throw new Error(`Invalid "manifest_version" in manifest.json: ${manifest.manifest_version}.`);
  }

  return manifest;
}

/**
 * Download, strip, unzip, and validate an extension into `<profileDir>/extensions/<id>`.
 *
 * @param {string} extensionId Chrome extension ID
 * @param {string} profileDir Browser profile directory
 * @param {object} [options]
 * @param {Buffer} [options.crxBuffer] Optional pre-downloaded CRX bytes (skips network)
 * @param {string} [options.prodversion='130.0'] Target Chrome version
 * @returns {Promise<{ id: string, targetDir: string, manifest: object, name: string, version: string, manifestVersion: number }>}
 */
export async function installExtension(extensionId, profileDir, options = {}) {
  if (!extensionId || typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`Invalid extension ID "${extensionId}".`);
  }
  if (!profileDir || typeof profileDir !== 'string') {
    throw new Error('profileDir is required.');
  }

  const id = extensionId.toLowerCase();
  const targetDir = path.resolve(profileDir, 'extensions', id);

  const crxBuffer = options.crxBuffer || await downloadCrx(id, options);
  const zipBuffer = stripCrxHeader(crxBuffer);
  await unzipExtension(zipBuffer, targetDir, options);
  const manifest = await validateManifest(targetDir);

  return {
    id,
    targetDir,
    manifest,
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
  };
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , extensionId, profileDir] = process.argv;
  if (!extensionId || !profileDir) {
    console.error('Usage: node browser-extension.mjs <extensionId> <profileDir>');
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
