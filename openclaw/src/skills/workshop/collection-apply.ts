import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginHookSkillBundleSnapshot } from "../../plugins/hook-types.js";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { prepareSkillBundle } from "../library/bundle.js";
import { assertSkillTrust } from "../security/trust.js";
import { skillTrustSource } from "../security/trust-admission.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { assertCollectionPreimages, publishCollectionFiles } from "./collection-files.js";
import { assertSkillCollectionManifest, collectionSnapshotHash, readCollectionSkillFiles } from "./collection-manifest.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged, runSkillProposalEvaluators } from "./plugin-hooks.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { assertExpectedRevisionHash, normalizeEvaluationOutcomes } from "./service-evaluation.js";
import { readRequiredProposal } from "./service-query.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { captureSkillWorkshopStoreOptions } from "./store-client.js";
import { assertSkillProposalEvaluationWithinLimit } from "./store-record.js";
import { recordSkillProposalEvaluation } from "./store-evaluation.js";
import { clearSkillProposalRollback, writeSkillProposalRollback } from "./store-rollback.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import { commitPendingSkillProposalTransition, readCommittedSkillProposalTransition } from "./store-transition.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA, type SkillProposalActionInput, type SkillProposalApplyResult, type SkillProposalEvaluateInput, type SkillProposalEvaluateResult, type SkillProposalRecord } from "./types.js";

function snapshot(files: SkillLibraryFile[]): PluginHookSkillBundleSnapshot {
  const prepared = prepareSkillBundle(files);
  const entries = prepared.files.map((file) => ({ path: file.path, content: file.bytes.toString("base64"), encoding: "base64" as const, sha256: file.sha256, sizeBytes: file.sizeBytes }));
  return { skillMd: entries.find((file) => file.path === "SKILL.md")!, files: entries.filter((file) => file.path !== "SKILL.md"), treeSha256: prepared.revision };
}

export async function evaluateSkillCollection(input: SkillProposalEvaluateInput, options: SkillWorkshopStoreOptions = {}): Promise<SkillProposalEvaluateResult> {
  const store = captureSkillWorkshopStoreOptions({ ...options, env: options.env ?? input.env, agentId: input.agentId, config: input.config });
  const read = await readRequiredProposal(input.proposalId, store);
  if (!read.record.collection || read.record.status !== "pending") { throw new Error("A pending collection proposal is required."); }
  assertSkillCollectionManifest(read.record.collection);
  assertExpectedRevisionHash(read.revisionHash, input.expectedRevisionHash);
  const skillsRoot = resolveWorkshopSkillsDir(input.config, input.agentId!, store.env);
  await assertCollectionPreimages(skillsRoot, read.record.collection);
  const startedAt = new Date().toISOString();
  const outcomes: SkillProposalEvaluateResult["evaluation"]["outcomes"] = [];
  for (const op of read.record.collection.operations) {
    if (!op.after) { continue; }
    const results = await runSkillProposalEvaluators({
      proposal: { id: read.record.id, kind: op.action === "create" ? "create" : "update", revision: read.record.proposedVersion, revisionSha256: read.revisionHash },
      skill: { name: op.skillKey, skillKey: op.skillKey, description: read.record.description, source: "openclaw-workshop" },
      candidate: snapshot(op.after), ...(op.before ? { baseline: snapshot(op.before) } : {}), reason: input.trigger ?? "manual",
    }, { workspaceDir: input.workspaceDir, agentId: input.agentId });
    for (const result of normalizeEvaluationOutcomes(results)) {
      outcomes.push(result);
    }
    if (outcomes.length > 64) { throw new Error("Collection evaluation exceeded outcome limits."); }
  }
  const completedAt = new Date().toISOString();
  const evaluation = { id: randomUUID(), proposedVersion: read.record.proposedVersion, revisionHash: read.revisionHash, trigger: input.trigger ?? "manual" as const, startedAt, completedAt, outcomes };
  assertSkillProposalEvaluationWithinLimit(evaluation);
  const eventInput = createSkillProposalEvent({ record: read.record, type: "evaluation_completed", actor: input.eventActor, occurredAt: completedAt, evaluation });
  const stored = await withSkillCollectionLock(async (lockedStore) => {
    const current = await readRequiredProposal(input.proposalId, { ...lockedStore, config: input.config }, { reconcile: false });
    if (current.record.status !== "pending" || current.revisionHash !== read.revisionHash) { throw new Error("Collection changed during evaluation."); }
    await assertCollectionPreimages(skillsRoot, read.record.collection!);
    return recordSkillProposalEvaluation({ proposalId: read.record.id, expectedProposedVersion: read.record.proposedVersion, expectedRevisionHash: read.revisionHash, evaluation, event: eventInput, store: lockedStore });
  }, store);
  await dispatchSkillProposalChanged({ event: stored.event, record: stored.record, workspaceDir: input.workspaceDir, agentId: input.agentId });
  return { record: stored.record, evaluation };
}

export async function applySkillCollection(input: SkillProposalActionInput): Promise<SkillProposalApplyResult> {
  const assertCurrent = input.assertCommitAllowed ? retainMutationAuthority(input.assertCommitAllowed) : undefined;
  assertCurrent?.();
  if (!input.agentId) { throw new Error("Collection activation requires an agent id."); }
  const store = captureSkillWorkshopStoreOptions({ env: input.env, agentId: input.agentId, config: input.config });
  const evaluated = await evaluateSkillCollection({ ...input, trigger: "apply" }, store);
  if (evaluated.evaluation.outcomes.some((outcome) => outcome.status === "error" || (outcome.status === "completed" && outcome.result.decision !== undefined && outcome.result.decision !== "pass"))) {
    throw new Error("Collection activation was refused by an evaluator; inspect the pending evaluation.");
  }
  assertCurrent?.();
  const result = await withSkillCollectionLock(async (lockedStore) => {
    assertCurrent?.();
    const read = await readRequiredProposal(input.proposalId, { ...lockedStore, config: input.config }, { reconcile: false });
    assertCurrent?.();
    if (!read.record.collection || read.record.status !== "pending" || read.record.evaluation?.id !== evaluated.evaluation.id) { throw new Error("Collection decision changed before activation."); }
    assertExpectedRevisionHash(read.revisionHash, evaluated.evaluation.revisionHash);
    const collection = read.record.collection;
    assertSkillCollectionManifest(collection);
    const skillsRoot = resolveWorkshopSkillsDir(input.config, input.agentId!, lockedStore.env);
    await assertCollectionPreimages(skillsRoot, collection);
    for (const op of collection.operations) {
      if (!op.after) { continue; }
      const source = skillTrustSource(path.join(skillsRoot, op.skillKey));
      await assertSkillTrust({ objectId: `skill:${source}`, source, files: op.after, assertCurrent, options: { env: lockedStore.env } });
      assertCurrent?.();
    }
    await assertCollectionPreimages(skillsRoot, collection);
    assertCurrent?.();
    const journal = JSON.stringify({ schema: "openclaw.skill-workshop.collection-rollback.v1", revisionHash: read.revisionHash, collection });
    await writeSkillProposalRollback({ proposalId: read.record.id, rollback: {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA, proposalId: read.record.id, writtenAt: new Date().toISOString(),
      targetSkillFile: read.record.target.skillFile, action: read.record.kind, previousContent: journal, previousContentHash: sha256Hex(journal),
    }, store: lockedStore });
    assertCurrent?.();
    try {
      await publishCollectionFiles(skillsRoot, collection.operations, "forward", assertCurrent);
      for (const op of collection.operations) {
        const target = path.join(skillsRoot, op.skillKey);
        const actual = await readCollectionSkillFiles(target);
        if (collectionSnapshotHash(actual) !== collectionSnapshotHash(op.after)) { throw new Error("Collection publication differs from its reviewed candidate."); }
        if (actual) {
          const source = skillTrustSource(target);
          await assertSkillTrust({ objectId: `skill:${source}`, source, files: actual, assertCurrent, options: { env: lockedStore.env } });
        }
        assertCurrent?.();
      }
      const now = new Date().toISOString();
      const applied: SkillProposalRecord = { ...read.record, status: "applied", updatedAt: now, appliedAt: now, scan: { ...read.record.scan, state: "clean", scannedAt: now } };
      const eventInput = createSkillProposalEvent({ record: applied, type: "applied", actor: input.eventActor, occurredAt: now, payload: { collectionOperations: collection.operations.length } });
      let committed;
      try {
        committed = await commitPendingSkillProposalTransition({ expected: read.record, record: applied, event: eventInput, store: lockedStore, operationLabel: "skill-workshop.collection.apply", assertCommitAllowed: assertCurrent });
        if (committed.state !== "committed") { throw new Error("Collection changed before status commit."); }
      } catch (error) {
        const recovered = await readCommittedSkillProposalTransition({ record: applied, event: eventInput, store: lockedStore });
        if (!recovered) { throw error; }
        committed = recovered;
      }
      return { record: applied, targetSkillFile: applied.target.skillFile, event: committed.event };
    } catch (error) {
      // Exact restoration remains authorized after forward authority is revoked.
      const { recoverCollectionFiles } = await import("./collection-recovery.js");
      await recoverCollectionFiles(skillsRoot, collection);
      await clearSkillProposalRollback({ proposalId: read.record.id, expectedRecordJson: JSON.stringify(read.record), store: lockedStore });
      throw error;
    } finally {
      bumpSkillsSnapshotVersion({ reason: "workshop" });
    }
  }, store);
  await dispatchSkillProposalChanged({ event: result.event, record: result.record, workspaceDir: input.workspaceDir, agentId: input.agentId });
  return { record: result.record, targetSkillFile: result.targetSkillFile };
}
