import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { CANONICAL_MEMORY_BUDGET } from "openclaw/plugin-sdk/memory-core-host-status";
import { getRuntimeConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import {
  DREAMING_CANONICAL_PROPOSALS_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { storeMemoryRetrievalPreimage } from "./dreaming-consolidation-artifacts.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import {
  commitMemoryContent,
  hashMemoryContent,
  readMemoryContent,
  resolveMemoryWritePath,
  MemoryAtomicPublicationError,
} from "./short-term-promotion-memory-write.js";
import { reserveMemoryEntryOrigins } from "./memory-entry-origins.js";
import { isContaminatedDreamingSnippet } from "./short-term-promotion-utils.js";

export type CanonicalMemoryProposal = {
  id: string;
  status: "pending" | "applied" | "rejected";
  beforeHash: string;
  before: string;
  after: string;
  createdAt: string;
  origins?: Omit<Parameters<typeof reserveMemoryEntryOrigins>[0], "previousMemory">;
};

export function renderCanonicalMemoryProposalDiff(proposal: CanonicalMemoryProposal): string {
  const before = proposal.before.split("\n");
  const after = proposal.after.split("\n");
  return [
    "--- MEMORY.md (reviewed preimage)",
    "+++ MEMORY.md (pending proposal)",
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join("\n");
}

/** Absence is not authority to rewrite canonical facts. */
export function resolveCanonicalActivationPolicy(cfg?: OpenClawConfig): "pending" | "auto" {
  const config = cfg?.plugins?.entries?.["memory-core"]?.config;
  return config?.canonicalActivationPolicy === "auto" ? "auto" : "pending";
}

export function assertAutomaticCanonicalActivationAllowed(workspaceDir?: string): void {
  if (workspaceDir && getAgentWorkspaceAccess(workspaceDir)) {
    throw new Error("Remote automatic canonical rewrites require host-side policy revalidation; review the pending proposal.");
  }
  if (resolveCanonicalActivationPolicy(getRuntimeConfig()) !== "auto") {
    throw new Error("Automatic canonical memory activation authority was revoked; review the pending proposal.");
  }
}

export function requiresCanonicalReview(workspaceDir: string, policy?: "pending" | "auto"): boolean {
  return policy !== "auto" || getAgentWorkspaceAccess(workspaceDir) !== undefined;
}

export async function listCanonicalMemoryProposals(
  workspaceDir: string,
): Promise<CanonicalMemoryProposal[]> {
  return (await readMemoryCoreWorkspaceEntries<CanonicalMemoryProposal>({
    namespace: DREAMING_CANONICAL_PROPOSALS_NAMESPACE,
    workspaceDir,
  })).map(({ value }) => value);
}

function proposalId(before: string, after: string, origins?: CanonicalMemoryProposal["origins"]): string {
  return createHash("sha256").update(before).update("\0").update(after).update("\0").update(JSON.stringify(origins ?? null)).digest("hex");
}

export async function stageCanonicalMemoryProposal(params: {
  workspaceDir: string;
  before: string;
  after: string;
  nowMs: number;
  origins?: CanonicalMemoryProposal["origins"];
}): Promise<CanonicalMemoryProposal> {
  validateCanonicalContent(params.after);
  const id = proposalId(params.before, params.after, params.origins);
  const existing = (await listCanonicalMemoryProposals(params.workspaceDir)).find((proposal) => proposal.id === id);
  if (existing) return existing;
  const proposal: CanonicalMemoryProposal = { id, status: "pending", beforeHash: hashMemoryContent(params.before), before: params.before, after: params.after, createdAt: new Date(params.nowMs).toISOString(), ...(params.origins ? { origins: params.origins } : {}) };
  await writeMemoryCoreWorkspaceEntry({ namespace: DREAMING_CANONICAL_PROPOSALS_NAMESPACE, workspaceDir: params.workspaceDir, key: id, value: proposal });
  return proposal;
}

function validateCanonicalContent(content: string): void {
  if (content.length > CANONICAL_MEMORY_BUDGET.memoryMaxChars || content.includes("\0") || isContaminatedDreamingSnippet(content)) {
    throw new Error("Canonical memory proposal exceeds the memory budget or contains rejected content.");
  }
}

/** Called only by the operator CLI, after inspecting the exact before/after record. */
export async function decideCanonicalMemoryProposal(params: {
  workspaceDir: string;
  id: string;
  decision: "apply" | "reject";
  assertCurrent?: () => void;
  indexArchive: () => Promise<void>;
}): Promise<CanonicalMemoryProposal> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) throw new Error("Memory workspace authority changed while approving canonical memory.");
  };
  return await withMemoryWorkspaceLock(params.workspaceDir, async () => {
    const proposal = (await listCanonicalMemoryProposals(params.workspaceDir)).find((entry) => entry.id === params.id);
    if (!proposal || proposal.status !== "pending") throw new Error("Canonical memory proposal is not pending.");
    if (proposalId(proposal.before, proposal.after, proposal.origins) !== proposal.id || hashMemoryContent(proposal.before) !== proposal.beforeHash) {
      throw new Error("Canonical memory proposal content changed; generate a new proposal.");
    }
    assertCurrent();
    if (params.decision === "apply") {
      validateCanonicalContent(proposal.after);
      const filePath = await resolveMemoryWritePath(path.join(params.workspaceDir, "MEMORY.md"), params.workspaceDir);
      if (hashMemoryContent(await readMemoryContent(filePath, params.workspaceDir)) !== proposal.beforeHash) {
        throw new Error("MEMORY.md changed since review; generate a new canonical proposal.");
      }
      await storeMemoryRetrievalPreimage({ workspaceDir: params.workspaceDir, content: proposal.before });
      await params.indexArchive();
      assertCurrent();
      const rollbackOrigins = proposal.origins ? await reserveMemoryEntryOrigins({ ...proposal.origins, previousMemory: proposal.before }) : undefined;
      try {
        await commitMemoryContent({ workspaceDir: params.workspaceDir, filePath, tempPrefix: "MEMORY.md.canonical", expectedHash: proposal.beforeHash, content: proposal.after, assertCurrent });
      } catch (error) {
        if (!(error instanceof MemoryAtomicPublicationError)) await rollbackOrigins?.();
        throw error;
      }
    }
    const decided = { ...proposal, status: params.decision === "apply" ? "applied" as const : "rejected" as const };
    assertCurrent();
    await writeMemoryCoreWorkspaceEntry({ namespace: DREAMING_CANONICAL_PROPOSALS_NAMESPACE, workspaceDir: params.workspaceDir, key: proposal.id, value: decided });
    return decided;
  });
}
