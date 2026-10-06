import path from "node:path";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { root, walkDirectory } from "../../infra/fs-safe.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { decodeSkillLibraryFile } from "../library/bundle.js";
import { assertInsideSkillsRoot } from "../lifecycle/workspace-skill-write.js";
import { collectionSnapshotHash, readCollectionSkillFiles } from "./collection-manifest.js";
import type { SkillCollectionManifest, SkillCollectionOperation } from "./types.js";

const fileSignature = (file: SkillLibraryFile) => JSON.stringify([sha256Hex(decodeSkillLibraryFile(file)), file.executable === true]);

export async function assertCollectionPreimages(skillsRoot: string, manifest: SkillCollectionManifest): Promise<void> {
  for (const op of manifest.operations) {
    const target = path.join(skillsRoot, op.skillKey);
    assertInsideSkillsRoot(skillsRoot, target, "collection skill directory");
    if (collectionSnapshotHash(await readCollectionSkillFiles(target)) !== collectionSnapshotHash(op.before)) {
      throw new Error(`Collection target changed after proposal creation: ${op.skillKey}`);
    }
  }
}

/** Recover only files that are still an exact preimage, candidate, or a planned transition gap. */
export async function assertCollectionRecoveryState(skillsRoot: string, manifest: SkillCollectionManifest): Promise<void> {
  for (const op of manifest.operations) {
    const before = new Map((op.before ?? []).map((file) => [file.path, fileSignature(file)]));
    const after = new Map((op.after ?? []).map((file) => [file.path, fileSignature(file)]));
    const current = await readCollectionSkillFiles(path.join(skillsRoot, op.skillKey));
    for (const file of current ?? []) {
      const signature = fileSignature(file);
      if (signature !== before.get(file.path) && signature !== after.get(file.path)) {
        throw new Error(`Collection recovery refuses changed user content: ${op.skillKey}/${file.path}`);
      }
    }
    const currentPaths = new Set((current ?? []).map((file) => file.path));
    for (const [relativePath, signature] of before) {
      if (!currentPaths.has(relativePath) && after.get(relativePath) === signature) {
        throw new Error(`Collection recovery refuses removal of an untouched file: ${op.skillKey}/${relativePath}`);
      }
    }
  }
}

export async function publishCollectionFiles(skillsRoot: string, operations: readonly SkillCollectionOperation[],
  direction: "forward" | "rollback", assertCurrent?: () => void): Promise<void> {
  const safe = await root(skillsRoot, { assertBeforeMutation: assertCurrent });
  for (const op of operations) {
    assertCurrent?.();
    const target = path.join(skillsRoot, op.skillKey);
    assertInsideSkillsRoot(skillsRoot, target, "collection skill directory");
    const desired = new Map(((direction === "forward" ? op.after : op.before) ?? []).map((file) => [file.path, file]));
    const current = await readCollectionSkillFiles(target);
    const currentMap = new Map((current ?? []).map((file) => [file.path, file]));
    const paths = [...new Set([...currentMap.keys(), ...desired.keys()])].toSorted((a, b) => {
      if (a === "SKILL.md") { return 1; }
      if (b === "SKILL.md") { return -1; }
      return a.localeCompare(b);
    });
    for (const relativePath of paths) {
      const previous = currentMap.get(relativePath);
      const next = desired.get(relativePath);
      if (previous && next && fileSignature(previous) === fileSignature(next)) { continue; }
      const targetPath = `${op.skillKey}/${relativePath}`;
      if (previous) {
        const live = await safe.read(targetPath, { hardlinks: "reject", symlinks: "reject", maxBytes: 1024 * 1024 });
        if (!live.buffer.equals(decodeSkillLibraryFile(previous))) { throw new Error(`Collection target changed before mutation: ${targetPath}`); }
        assertCurrent?.();
        await safe.remove(targetPath);
      }
      if (next) {
        assertCurrent?.();
        await safe.create(targetPath, decodeSkillLibraryFile(next), { mkdir: true, mode: next.executable ? 0o700 : 0o600, durable: "file" });
      }
      assertCurrent?.();
    }
    if (!desired.size && current !== null) {
      // Remove only empty directories. Unexpected files are never recursively discarded.
      const walked = await walkDirectory(target, { symlinks: "include", maxDepth: 17, maxEntries: 512 });
      if (walked.truncated || walked.failedDirs.length || walked.entries.some((entry) => entry.kind !== "directory")) {
        throw new Error(`Collection retirement found unexpected content: ${op.skillKey}`);
      }
      for (const entry of walked.entries.toSorted((a, b) => b.depth - a.depth)) {
        assertCurrent?.();
        await removePathWithinRoot({ rootDir: skillsRoot, relativePath: path.relative(skillsRoot, entry.path), recursive: false, force: false, assertBeforeMutation: assertCurrent });
      }
      assertCurrent?.();
      await removePathWithinRoot({ rootDir: skillsRoot, relativePath: op.skillKey, recursive: false, force: false, assertBeforeMutation: assertCurrent });
    }
  }
}
