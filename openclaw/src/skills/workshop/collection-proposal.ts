import path from "node:path";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { normalizeWorkspaceSkillSupportPath } from "../lifecycle/workspace-skill-write.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { assertSkillCollectionManifest, readCollectionSkillFiles } from "./collection-manifest.js";
import { renderSkillCollectionDiff } from "./collection-diff.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { renderProposalMarkdown, stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { createSkillProposalGenerationDraftFile } from "./proposal-generation.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { mergeProposalOriginRunProvenance, normalizeProposalOrigin } from "./service-propose.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { captureSkillWorkshopStoreOptions } from "./store-client.js";
import { createSkillProposalId, resolveSkillProposalTarget, writeSkillProposal } from "./store.js";
import { SKILL_WORKSHOP_COLLECTION_SCHEMA, type SkillCollectionManifest, type SkillCollectionOperation, type SkillProposalCreateInput, type SkillProposalReadResult, type SkillProposalRecord, type SkillProposalSupportFileInput } from "./types.js";

export type SkillCollectionOperationInput = {
  action: "create" | "update" | "retire";
  skillName: string;
  content?: string;
  description?: string;
  supportFiles?: SkillProposalSupportFileInput[];
  expectedCurrentContentHash?: string;
};
export type SkillCollectionCreateInput = Omit<SkillProposalCreateInput, "name" | "content" | "supportFiles"> & {
  operations: SkillCollectionOperationInput[];
};

export async function proposeSkillCollection(input: SkillCollectionCreateInput): Promise<SkillProposalReadResult> {
  if (!input.agentId) { throw new Error("Skill Workshop requires the active agent id."); }
  if (!input.operations.length || input.operations.length > 16) { throw new Error("Collection proposals require 1 to 16 operations."); }
  const store = captureSkillWorkshopStoreOptions({ env: input.env, agentId: input.agentId, config: input.config });
  const config = resolveSkillWorkshopConfig(input.config);
  const operations: SkillCollectionOperation[] = [];
  const now = new Date().toISOString();
  for (const op of structuredClone(input.operations)) {
    input.assertCommitAllowed?.();
    const target = resolveSkillProposalTarget({ skillName: op.skillName, config: input.config, agentId: input.agentId, env: store.env });
    if (target.skillKey !== normalizeSkillIndexName(op.skillName) || target.skillKey.length > 63) { throw new Error("Invalid collection skill key."); }
    const before = await readCollectionSkillFiles(target.skillDir);
    input.assertCommitAllowed?.();
    if ((op.action === "create") !== (before === null)) { throw new Error(`Collection target existence changed: ${target.skillKey}`); }
    const previousSkill = before?.find((file) => file.path === "SKILL.md");
    if (op.expectedCurrentContentHash && (!previousSkill || sha256Hex(Buffer.from(previousSkill.content, previousSkill.encoding === "base64" ? "base64" : "utf8")) !== op.expectedCurrentContentHash)) {
      throw new Error(`Collection skill changed since reviewer read: ${target.skillKey}`);
    }
    let after: SkillLibraryFile[] | null = null;
    if (op.action !== "retire") {
      if (!op.content?.trim()) { throw new Error("Collection create/update requires complete skill content."); }
      const prepared = prepareSkillProposalDraft({ name: target.skillKey, description: op.description ?? input.description, skillDescription: op.description ?? input.description, content: op.content, date: now, maxSkillBytes: config.maxSkillBytes, supportFiles: op.supportFiles });
      const files = new Map((before ?? []).map((file) => [file.path, file]));
      files.set("SKILL.md", { path: "SKILL.md", content: stripProposalFrontmatterForSkill(prepared.content), encoding: "utf8", executable: false });
      for (const file of op.supportFiles ?? []) {
        const relativePath = normalizeWorkspaceSkillSupportPath(file.path);
        if (file.delete) {
          if (op.action === "create" || file.content !== "" || !files.has(relativePath)) { throw new Error("Collection supporting-file deletion requires an existing exact target."); }
          files.delete(relativePath);
        } else {
          files.set(relativePath, { path: relativePath, content: file.content, encoding: "utf8", executable: files.get(relativePath)?.executable ?? false });
        }
      }
      after = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
    } else if (op.content !== undefined || op.supportFiles?.length) { throw new Error("Retirement cannot contain candidate writes."); }
    operations.push({ action: op.action, skillKey: target.skillKey, before, after });
  }
  const collection: SkillCollectionManifest = { schema: "openclaw.skill-workshop.change-set.v1", operations };
  assertSkillCollectionManifest(collection);
  const first = operations[0]!;
  const skillsRoot = resolveWorkshopSkillsDir(input.config, input.agentId, store.env);
  const content = renderProposalMarkdown({ name: "collection-change-set", description: input.description, content: renderSkillCollectionDiff(collection), date: now });
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) { throw new Error("Collection proposal draft exceeds its bounded artifact budget."); }
  const origin = normalizeProposalOrigin({ ...input.origin, agentId: input.origin?.agentId ?? input.agentId });
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_COLLECTION_SCHEMA, collection,
    id: createSkillProposalId("collection"), kind: first.action === "create" ? "create" : "update", status: "pending",
    title: `Collection change-set (${operations.length} operations)`, description: input.description,
    createdAt: now, updatedAt: now, createdBy: input.createdBy ?? "skill-workshop",
    ...(input.autonomousCapture ? { autonomousCapture: true } : {}), ...(origin ? { origin } : {}),
    ...mergeProposalOriginRunProvenance(undefined, origin),
    proposedVersion: "v1", draftFile: createSkillProposalGenerationDraftFile(), draftHash: sha256Hex(content),
    target: { skillName: first.skillKey, skillKey: first.skillKey, skillDir: path.join(skillsRoot, first.skillKey), skillFile: path.join(skillsRoot, first.skillKey, "SKILL.md"), source: "openclaw-workshop" },
    scan: { state: "pending", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
    ...(input.goal ? { goal: input.goal } : {}), ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  const event = await writeSkillProposal({ record, content, ownerAgentId: input.agentId, maxPending: config.maxPending, event: createSkillProposalEvent({ record, type: "created", actor: input.eventActor }), store, assertCommitAllowed: input.assertCommitAllowed });
  await dispatchSkillProposalChanged({ event, record, workspaceDir: input.workspaceDir, agentId: input.agentId });
  return { record, revisionHash: hashSkillProposalRevision(record), content };
}
