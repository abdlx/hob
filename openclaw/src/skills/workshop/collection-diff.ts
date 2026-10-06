import { isUtf8 } from "node:buffer";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { decodeSkillLibraryFile } from "../library/bundle.js";
import type { SkillCollectionManifest } from "./types.js";

export function skillCollectionDiffArtifacts(manifest: SkillCollectionManifest): Array<{ path: string; content: string; sizeBytes: number }> {
  const artifacts: Array<{ path: string; content: string; sizeBytes: number }> = [];
  const describe = (file: SkillLibraryFile | undefined) => file
    ? `${sha256Hex(decodeSkillLibraryFile(file))} executable=${file.executable === true}` : "absent";
  for (const op of manifest.operations) {
    const before = new Map((op.before ?? []).map((file) => [file.path, file]));
    const after = new Map((op.after ?? []).map((file) => [file.path, file]));
    for (const relativePath of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
      const previous = before.get(relativePath);
      const next = after.get(relativePath);
      if (describe(previous) === describe(next)) { continue; }
      const oldBytes = previous ? decodeSkillLibraryFile(previous) : Buffer.alloc(0);
      const newBytes = next ? decodeSkillLibraryFile(next) : Buffer.alloc(0);
      const lines = [`--- before/${op.skillKey}/${relativePath} (${describe(previous)})`, `+++ after/${op.skillKey}/${relativePath} (${describe(next)})`];
      if (isUtf8(oldBytes) && isUtf8(newBytes) && !oldBytes.includes(0) && !newBytes.includes(0)) {
        lines.push(...oldBytes.toString("utf8").split("\n").map((line) => `-${line}`), ...newBytes.toString("utf8").split("\n").map((line) => `+${line}`));
      } else { lines.push("Binary content changed; full byte snapshots are retained in the collection manifest."); }
      const content = lines.join("\n");
      artifacts.push({ path: `changes/${op.skillKey}/${relativePath}.diff`, content, sizeBytes: Buffer.byteLength(content) });
    }
  }
  return artifacts;
}

export function renderSkillCollectionDiff(manifest: SkillCollectionManifest): string {
  return [`# Collection change-set`, ...manifest.operations.map((op) => `- ${op.action} ${op.skillKey}`), "", ...skillCollectionDiffArtifacts(manifest).map((file) => file.content)].join("\n\n");
}
