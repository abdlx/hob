import path from "node:path";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { getAgentWorkspaceAccess, WorkspaceAccessUnavailableError } from "../../agents/workspace-access.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { prepareSkillBundle, readSkillBundleTree, stageSkillLibraryBundle } from "../library/bundle.js";
import { shouldSyncSkillPath } from "../loading/skill-paths.js";
import { recordSkillFileHost, resolveSkillFileHost } from "../skill-file-host.js";
import type { SkillEntry } from "../types.js";
import type { SkillSnapshot } from "../types.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { formatSkillsForPromptBounded } from "../loading/skill-prompt-limits.js";
import { assertSkillTrust, SkillTrustBlockedError } from "./trust.js";

const log = createSubsystemLogger("skills/trust");
export function skillTrustSource(directory: string, host: "gateway" | "workspace" = "gateway") {
  return `${host}:${directory}`;
}

export async function publishTrustedSkillFiles(params: {
  files: readonly SkillLibraryFile[];
  source: string;
  description: string;
  assertCurrent: () => void;
  env?: NodeJS.ProcessEnv;
}) {
  const bundle = prepareSkillBundle(params.files);
  const objectId = `skill:${params.source}`;
  const inspection = await assertSkillTrust({ objectId, source: params.source, files: params.files, assertCurrent: params.assertCurrent, options: { env: params.env } });
  params.assertCurrent();
  const digest = sha256Hex(JSON.stringify(["openclaw.trusted-skill-copy.v1", params.source]));
  const artifactId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const staged = await stageSkillLibraryBundle(artifactId, { ...bundle, description: params.description }, params.env, params.assertCurrent);
  try {
    const baseDir = await staged.publish();
    params.assertCurrent();
    return { baseDir, artifactId, bundle, inspection };
  } finally {
    await staged.cleanup();
  }
}

/** Read once, inspect those bytes, then publish a private immutable runtime copy. */
export async function admitSkillEntry(entry: SkillEntry, workspaceDir: string, assertCurrent: () => void): Promise<SkillEntry> {
  assertCurrent();
  const skill = entry.skill;
  const node = skill.filePath.startsWith("node://");
  if (node && !skill.nodeResources) {
    throw new WorkspaceAccessUnavailableError("Node-hosted skill requires a complete immutable bundle carrier; instruction-only descriptors cannot establish skill trust. Upgrade the node resource protocol.");
  }
  const remote = resolveSkillFileHost(skill) === "workspace";
  const libraryId = skill.source === "openclaw-library"
    ? path.basename(path.dirname(path.dirname(skill.baseDir)))
    : undefined;
  const source = skill.trust?.source ?? (node ? skill.baseDir.split("/revisions/")[0]! : libraryId ? `library:${libraryId}` : skillTrustSource(skill.baseDir, remote ? "workspace" : "gateway"));
  const objectId = skill.trust?.objectId ?? `skill:${source}`;
  const resources = remote ? getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.skillResources : undefined;
  if (remote && !resources) {
    throw new WorkspaceAccessUnavailableError("Remote workspace cannot provide the complete skill bundle required for trust verification.");
  }
  const files = node ? skill.nodeResources!.files : remote
    ? await resources!.readSkillFiles(skill, { allowMissingRoot: false })
    : await readSkillBundleTree(entry.syncSourceDir ?? skill.baseDir, shouldSyncSkillPath);
  assertCurrent();
  if (!files) {
    throw new Error("Skill root is unavailable for trust verification.");
  }
  const bundle = prepareSkillBundle(files);
  if (node && (bundle.revision !== skill.nodeResources!.revision || bundle.files.find((file) => file.path === "SKILL.md")!.bytes.toString("utf8") !== skill.readContent)) {
    throw new Error("Node skill bundle does not match its advertised immutable revision.");
  }
  if (skill.trust && skill.trust.contentHash !== bundle.revision) {
    throw new Error("An admitted immutable skill artifact changed; refresh skill selection.");
  }
  const { baseDir, artifactId, inspection } = await publishTrustedSkillFiles({
    source, files, description: skill.description, assertCurrent,
  });
    return {
      ...entry,
      syncSourceDir: baseDir,
      syncDirName: `trusted-${artifactId}-${bundle.revision}`,
      skill: recordSkillFileHost({
        ...skill,
        baseDir,
        filePath: path.join(baseDir, "SKILL.md"),
        readContent: bundle.files.find((file) => file.path === "SKILL.md")!.bytes.toString("utf8"),
        contentHash: bundle.revision,
        trust: { objectId, source, revisionId: inspection.revisionId, contentHash: bundle.revision },
      }, "gateway"),
    };
}

export async function admitSkillEntries(entries: readonly SkillEntry[], workspaceDir: string, assertCurrent: () => void) {
  const admitted: SkillEntry[] = [];
  for (const entry of entries) {
    assertCurrent();
    try {
      admitted.push(await admitSkillEntry(entry, workspaceDir, assertCurrent));
    } catch (error) {
      assertCurrent();
      // Preserve the rest of the catalog, while the withheld object never reaches model context.
      if (error instanceof SkillTrustBlockedError) {
        log.warn(error.message);
      } else {
        log.warn(`Skill withheld because complete trust admission failed: ${JSON.stringify(entry.skill.name)}`);
      }
    }
  }
  assertCurrent();
  return admitted;
}

/** Hydrated session snapshots are discovery hints, never retained trust grants. */
export async function admitSkillSnapshot(
  snapshot: SkillSnapshot,
  workspaceDir: string,
  assertCurrent: () => void,
  additionalEntries: readonly SkillEntry[] = [],
): Promise<SkillSnapshot> {
  const candidates = new Map([
    ...(snapshot.discoverySkills ?? []), ...(snapshot.resolvedSkills ?? []),
    ...additionalEntries.filter((entry) => snapshot.skills.some((selected) => selected.name === entry.skill.name)).map((entry) => entry.skill),
  ].map((skill) => [skill.name, skill]));
  const entries = [...candidates.values()].map((skill) => ({
    skill, frontmatter: parseSkillFrontmatter(skill.readContent ?? ""),
  }));
  const admitted = await admitSkillEntries(entries, workspaceDir, assertCurrent);
  const byName = new Map(admitted.map((entry) => [entry.skill.name, entry.skill]));
  const resolvedSkills = (snapshot.resolvedSkills ?? []).flatMap((skill) => {
    const selected = byName.get(skill.name);
    return selected ? [selected] : [];
  });
  const discoverySkills = (snapshot.discoverySkills ?? []).flatMap((skill) => {
    const selected = byName.get(skill.name);
    return selected ? [selected] : [];
  });
  assertCurrent();
  return {
    ...snapshot,
    prompt: formatSkillsForPromptBounded({ skills: resolvedSkills, preserveOrder: true }),
    resolvedSkills,
    discoverySkills,
    skills: snapshot.skills.flatMap((skill) => {
      const selected = byName.get(skill.name);
      return selected ? [{ ...skill, gatewayFilePath: selected.filePath }] : [];
    }),
    librarySelections: snapshot.librarySelections?.filter((selection) => byName.has(selection.name)),
  };
}
