import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { applySkillProposal } from "./service.js";
import type { SkillWorkshopProposalMutationBudget } from "./types.js";

/** Host-owned activation after successful synthesis. The model never receives apply authority. */
export async function activateAutonomousSkillProposals(input: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  workspaceDir: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  budget: SkillWorkshopProposalMutationBudget;
  assertSourceCurrent: () => void;
}): Promise<string[]> {
  if (resolveSkillWorkshopConfig(input.config).autonomous.mode !== "auto") {
    return [];
  }
  const assertCommitAllowed = retainMutationAuthority(() => {
    input.assertSourceCurrent();
    if (resolveSkillWorkshopConfig(input.getCurrentConfig()).autonomous.mode !== "auto") {
      throw new Error("Automatic learning was revoked; the proposal remains pending.");
    }
  });
  const applied: string[] = [];
  for (const [proposalId, revisionHash] of input.budget.mutatedProposalRevisions ?? []) {
    assertCommitAllowed();
    await applySkillProposal({
      config: input.getCurrentConfig(),
      workspaceDir: input.workspaceDir,
      agentId: input.agentId,
      env: input.env,
      proposalId,
      expectedRevisionHash: revisionHash,
      reason: "Explicit automatic learning policy after staged review",
      assertCommitAllowed,
    });
    applied.push(proposalId);
  }
  return applied;
}
