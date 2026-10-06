import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { assertInsideSkillsRoot } from "../lifecycle/workspace-skill-write.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { assertCollectionPreimages, assertCollectionRecoveryState, publishCollectionFiles } from "./collection-files.js";
import { assertSkillCollectionManifest } from "./collection-manifest.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { readStoredProposal } from "./store-client.js";
import { clearSkillProposalRollback, readSkillProposalRollback } from "./store-rollback.js";
import type { SkillWorkshopDirectoryStoreOptions } from "./store-sqlite-schema.js";
import { withSkillCollectionLock } from "./target-lock.js";
import type { SkillCollectionManifest, SkillProposalRecord } from "./types.js";

export async function recoverCollectionFiles(skillsRoot: string, collection: SkillCollectionManifest): Promise<void> {
  assertSkillCollectionManifest(collection);
  await assertCollectionRecoveryState(skillsRoot, collection);
  try {
    await publishCollectionFiles(skillsRoot, [...collection.operations].toReversed(), "rollback");
    await assertCollectionPreimages(skillsRoot, collection);
  } finally { bumpSkillsSnapshotVersion({ reason: "workshop" }); }
}

/** A pending interrupted collection is restored, never activated from stale prior authority. */
export async function reconcileInterruptedSkillCollectionApply(request: {
  record: SkillProposalRecord;
  expectedRecordJson: string;
  skillsRoot: string;
  store: SkillWorkshopDirectoryStoreOptions;
}): Promise<boolean> {
  return withSkillCollectionLock(async (store) => {
    const stored = await readStoredProposal(request.record.id, store);
    if (!stored?.record.collection || stored.record.status !== "pending" || stored.row.record_json !== request.expectedRecordJson) { return false; }
    const rollback = await readSkillProposalRollback(stored.record.id, store);
    if (!rollback?.previousContent || rollback.previousContentHash !== sha256Hex(rollback.previousContent) || rollback.action !== stored.record.kind || path.resolve(rollback.targetSkillFile) !== path.resolve(stored.record.target.skillFile)) { return false; }
    assertInsideSkillsRoot(request.skillsRoot, stored.record.target.skillFile, "collection recovery anchor");
    const journal: unknown = JSON.parse(rollback.previousContent);
    if (!journal || typeof journal !== "object") { return false; }
    const facts = journal as Record<string, unknown>;
    if (facts.schema !== "openclaw.skill-workshop.collection-rollback.v1" || facts.revisionHash !== hashSkillProposalRevision(stored.record) || JSON.stringify(facts.collection) !== JSON.stringify(stored.record.collection)) { return false; }
    assertSkillCollectionManifest(facts.collection);
    await recoverCollectionFiles(request.skillsRoot, facts.collection);
    return clearSkillProposalRollback({ proposalId: stored.record.id, expectedRecordJson: stored.row.record_json, store });
  }, request.store).catch(() => false);
}
