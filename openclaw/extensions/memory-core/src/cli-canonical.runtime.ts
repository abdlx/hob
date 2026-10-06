import path from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { getRuntimeConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { withMemoryCommand } from "./cli-runtime-common.js";
import {
  decideCanonicalMemoryProposal,
  listCanonicalMemoryProposals,
  renderCanonicalMemoryProposalDiff,
} from "./canonical-memory-proposals.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";

export async function runMemoryCanonical(action: "list" | "inspect" | "apply" | "reject", id: string | undefined, opts: { agent?: string }, host?: MemoryCoreRuntimeHost): Promise<void> {
  await withMemoryCommand({
    commandName: `memory canonical ${action}`,
    agent: opts.agent,
    purpose: "cli",
    requiresMemorySlot: true,
    ...host,
    run: async ({ manager, agentId }) => {
      const workspaceDir = manager.status().workspaceDir;
      if (!workspaceDir) throw new Error("Canonical memory review requires a workspace.");
      const assertCurrent = () => {
        if (path.resolve(resolveAgentWorkspaceDir(getRuntimeConfig(), agentId)) !== path.resolve(workspaceDir)) {
          throw new Error("Canonical memory workspace owner changed during approval.");
        }
      };
      assertCurrent();
      const proposals = await listCanonicalMemoryProposals(workspaceDir);
      if (action === "list") {
        defaultRuntime.writeJson(proposals.map(({ id, status, beforeHash, createdAt }) => ({ id, status, beforeHash, createdAt })));
        return;
      }
      const proposal = proposals.find((entry) => entry.id === id);
      if (!proposal) throw new Error("Canonical memory proposal was not found.");
      if (action === "inspect") {
        defaultRuntime.writeJson({ ...proposal, diff: renderCanonicalMemoryProposalDiff(proposal) });
        return;
      }
      defaultRuntime.writeJson(await decideCanonicalMemoryProposal({
        workspaceDir, id: proposal.id, decision: action, assertCurrent,
        indexArchive: async () => {
          if (!manager.sync || !manager.status().sources?.includes("memory")) throw new Error("Canonical archive indexing is unavailable.");
          await manager.sync({ reason: "canonical-memory-preservation", force: true });
        },
      }));
    },
  });
}
