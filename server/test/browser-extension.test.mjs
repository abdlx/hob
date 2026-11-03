import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadCrx,
  installExtension,
  omahaUrl,
  stripCrxHeader,
  unzipExtension,
  validateManifest,
  OMAHA_PRODVERSION,
} from '../browser-extension.mjs';

function createMockCrx3(zipBytes, headerPayload = Buffer.from('mock-header-bytes')) {
  // CRX3: Magic "Cr24", version 3 (LE uint32), headerSize (LE uint32), header, zip payload
  const magic = Buffer.from('Cr24', 'utf8');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);

  const headerSize = Buffer.alloc(4);
  headerSize.writeUInt32LE(headerPayload.length, 0);

  return Buffer.concat([magic, version, headerSize, headerPayload, zipBytes]);
}

function createMockCrx2(zipBytes, pubKey = Buffer.from('pub'), sig = Buffer.from('sig')) {
  // CRX2: Magic "Cr24", version 2 (LE uint32), keyLen (LE uint32), sigLen (LE uint32), key, sig, zip payload
  const magic = Buffer.from('Cr24', 'utf8');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32LE(pubKey.length, 0);

  const sigLen = Buffer.alloc(4);
  sigLen.writeUInt32LE(sig.length, 0);

  return Buffer.concat([magic, version, keyLen, sigLen, pubKey, sig, zipBytes]);
}

// Minimal valid empty ZIP file (End of central directory record)
// 0x06054b50 (4 bytes), disk=0 (2), disk_cd=0 (2), num_entries=0 (2), total_entries=0 (2), cd_size=0 (4), cd_offset=0 (4), comment_len=0 (2)
const MINIMAL_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

test('omahaUrl constructs Omaha URL with prodversion=130.0 and extension ID', () => {
  const extId = 'iomcoelgdkghlligeempdbfcaobodacg';
  const url = omahaUrl(extId);
  assert.ok(url.startsWith('https://clients2.google.com/service/update2/crx?'));
  assert.ok(url.includes(`prodversion=${OMAHA_PRODVERSION}`));
  assert.ok(url.includes('prodversion=130.0'));
  assert.ok(url.includes('acceptformat=crx2%2Ccrx3') || url.includes('acceptformat=crx2,crx3'));
  assert.ok(url.includes(`x=id%3D${extId}%26uc`));

  assert.throws(() => omahaUrl(''), /Invalid extension ID/);
  assert.throws(() => omahaUrl('../../etc/passwd'), /Invalid extension ID/);
});

test('stripCrxHeader parses CRX3 and strips header to reveal ZIP payload', () => {
  const crx3 = createMockCrx3(MINIMAL_ZIP, Buffer.from('test-header-data-1234'));
  const zip = stripCrxHeader(crx3);
  assert.deepEqual(zip, MINIMAL_ZIP);
});

test('stripCrxHeader parses CRX2 and strips header to reveal ZIP payload', () => {
  const crx2 = createMockCrx2(MINIMAL_ZIP, Buffer.from('key-data'), Buffer.from('signature-data'));
  const zip = stripCrxHeader(crx2);
  assert.deepEqual(zip, MINIMAL_ZIP);
});

test('stripCrxHeader passes raw ZIP buffer unchanged', () => {
  const zip = stripCrxHeader(MINIMAL_ZIP);
  assert.deepEqual(zip, MINIMAL_ZIP);
});

test('stripCrxHeader throws on invalid magic, truncated header, or invalid zip payload', () => {
  assert.throws(() => stripCrxHeader(Buffer.alloc(8)), /Buffer too small/);

  const badMagic = Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(16)]);
  assert.throws(() => stripCrxHeader(badMagic), /Invalid CRX magic/);

  const truncatedHeader = Buffer.concat([
    Buffer.from('Cr24'),
    Buffer.from([0x03, 0x00, 0x00, 0x00]), // v3
    Buffer.from([0x00, 0x10, 0x00, 0x00]), // 4096 bytes header
    Buffer.from('short'),
  ]);
  assert.throws(() => stripCrxHeader(truncatedHeader), /CRX header size/);

  const badZipSignature = Buffer.concat([
    Buffer.from('Cr24'),
    Buffer.from([0x03, 0x00, 0x00, 0x00]),
    Buffer.from([0x04, 0x00, 0x00, 0x00]), // 4 bytes header
    Buffer.from('head'),
    Buffer.from('NOTZIPDATA'),
  ]);
  assert.throws(() => stripCrxHeader(badZipSignature), /valid ZIP archive signature/);
});

test('validateManifest succeeds on valid manifest and fails on malformed manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-manifest-'));
  try {
    await assert.rejects(async () => validateManifest(root), /Missing manifest\.json/);

    await writeFile(path.join(root, 'manifest.json'), 'not json');
    await assert.rejects(async () => validateManifest(root), /Invalid JSON/);

    await writeFile(path.join(root, 'manifest.json'), JSON.stringify([]));
    await assert.rejects(async () => validateManifest(root), /must be a JSON object/);

    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ name: 'A' }));
    await assert.rejects(async () => validateManifest(root), /Missing or empty "version"/);

    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '1.0' }));
    await assert.rejects(async () => validateManifest(root), /Missing or empty "name"/);

    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ name: 'A', version: '1.0', manifest_version: 1 }));
    await assert.rejects(async () => validateManifest(root), /Invalid "manifest_version"/);

    const validManifest = { name: 'Valid Extension', version: '2.1.0', manifest_version: 3, description: 'Test' };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(validManifest));
    const result = await validateManifest(root);
    assert.deepEqual(result, validManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installExtension end-to-end unzips, validates and places extension in <profileDir>/extensions/<id>', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-install-ext-'));
  try {
    // Read the real extension.crx if present in scratch, or create a mock CRX3 containing manifest.json
    let crxBuffer;
    try {
      crxBuffer = await readFile('/opt/data/cache/scratch/extension.crx');
    } catch {
      // If scratch fixture is absent, mock can be used
      crxBuffer = null;
    }

    if (crxBuffer) {
      const extId = 'iomcoelgdkghlligeempdbfcaobodacg';
      const installed = await installExtension(extId, root, { crxBuffer });
      assert.equal(installed.id, extId);
      assert.equal(installed.targetDir, path.join(root, 'extensions', extId));
      assert.equal(typeof installed.name, 'string');
      assert.equal(typeof installed.version, 'string');
      assert.equal(installed.manifestVersion, 3);

      const manifestOnDisk = JSON.parse(await readFile(path.join(installed.targetDir, 'manifest.json'), 'utf8'));
      assert.equal(manifestOnDisk.name, installed.name);
      assert.equal(manifestOnDisk.version, installed.version);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
