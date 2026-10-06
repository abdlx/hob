import fs from "node:fs/promises";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { prepareSkillBundle, prepareSkillLibraryBundle, readSkillBundleTree } from "../library/bundle.js";
import type { SkillCollectionManifest } from "./types.js";

export const MAX_COLLECTION_MANIFEST_BYTES = 768 * 1024;
/** Complete portable file snapshots are the decision boundary, not mutable child proposal IDs. */
export function assertSkillCollectionManifest(value: unknown): asserts value is SkillCollectionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Invalid collection change-set."); }
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).some((key) => key !== "schema" && key !== "operations") || manifest.schema !== "openclaw.skill-workshop.change-set.v1" ||
      !Array.isArray(manifest.operations) || !manifest.operations.length || manifest.operations.length > 16 ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_COLLECTION_MANIFEST_BYTES) {
    throw new Error("Collection change-set version or limits are invalid.");
  }
  const names = new Set<string>();
  for (const item of manifest.operations) {
    if (!item || typeof item !== "object") { throw new Error("Invalid collection operation."); }
    const op = item as Record<string, unknown>;
    if (Object.keys(op).some((key) => !["action", "skillKey", "before", "after"].includes(key))) { throw new Error("Unknown collection operation field."); }
    if (typeof op.skillKey !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(op.skillKey) || names.has(op.skillKey)) {
      throw new Error("Collection operation requires a distinct normalized skill key.");
    }
    names.add(op.skillKey);
    if (op.action !== "create" && op.action !== "update" && op.action !== "retire") { throw new Error("Unknown collection operation."); }
    if ((op.action === "create") !== (op.before === null) || (op.action === "retire") !== (op.after === null)) {
      throw new Error("Collection operation preimages/results do not match its action.");
    }
    for (const files of [op.before, op.after]) {
      if (files === null) { continue; }
      if (!Array.isArray(files) || files.some((file) => !file || typeof file !== "object" || Object.keys(file).some((key) => !["path", "content", "encoding", "executable"].includes(key)) || typeof file.path !== "string" || typeof file.content !== "string" || (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64") || (file.executable !== undefined && typeof file.executable !== "boolean"))) {
        throw new Error("Invalid collection artifact snapshot.");
      }
      prepareSkillBundle(files);
    }
    if (op.after !== null) { prepareSkillLibraryBundle(op.after as SkillLibraryFile[]); }
  }
}

export function isSkillCollectionManifest(value: unknown): value is SkillCollectionManifest {
  try { assertSkillCollectionManifest(value); return true; } catch { return false; }
}

export async function readCollectionSkillFiles(skillDir: string): Promise<SkillLibraryFile[] | null> {
  try {
    const stat = await fs.lstat(skillDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error("Collection target must be a real directory."); }
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) { return null; }
    throw error;
  }
  return readSkillBundleTree(skillDir);
}

export function collectionSnapshotHash(files: readonly SkillLibraryFile[] | null): string | null {
  return files === null ? null : prepareSkillBundle(files).revision;
}

