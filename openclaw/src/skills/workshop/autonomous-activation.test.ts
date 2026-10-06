import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { activateAutonomousSkillProposals } from "./autonomous-activation.js";

const apply = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise host activation authority without the SQLite/file commit owner.
vi.mock("./service.js", () => ({ applySkillProposal: apply }));

const auto: OpenClawConfig = { skills: { workshop: { autonomous: { mode: "auto" } } } };

beforeEach(() => apply.mockReset());

describe("autonomous proposal activation", () => {
  it.each([{}, { skills: { workshop: { autonomous: { mode: "propose" as const } } } }, { skills: { workshop: { autonomous: { mode: "off" as const } } } }])(
    "never upgrades captured non-auto consent (%j)", async (config) => {
      await expect(activateAutonomousSkillProposals({
        config, getCurrentConfig: () => auto, agentId: "main", workspaceDir: "/workspace",
        budget: { remaining: 0, mutatedProposalRevisions: new Map([["draft-1", "a".repeat(64)]]) },
        assertSourceCurrent: () => {},
      })).resolves.toEqual([]);
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("redeems the run's exact staged revision through the ordinary apply owner", async () => {
    apply.mockImplementation(async (input) => input.assertCommitAllowed());
    await expect(activateAutonomousSkillProposals({
      config: auto, getCurrentConfig: () => auto, agentId: "main", workspaceDir: "/workspace",
      budget: { remaining: 0, mutatedProposalRevisions: new Map([["draft-1", "a".repeat(64)]]) },
      assertSourceCurrent: () => {},
    })).resolves.toEqual(["draft-1"]);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: "draft-1", expectedRevisionHash: "a".repeat(64), assertCommitAllowed: expect.any(Function),
    }));
  });

  it("revokes authority before an awaited apply can publish, and never revives it", async () => {
    let current = auto;
    let effects = 0;
    apply.mockImplementation(async (input) => {
      await Promise.resolve();
      current = {};
      expect(() => input.assertCommitAllowed()).toThrow("revoked");
      current = auto;
      input.assertCommitAllowed();
      effects += 1;
    });
    await expect(activateAutonomousSkillProposals({
      config: auto, getCurrentConfig: () => current, agentId: "main", workspaceDir: "/workspace",
      budget: { remaining: 0, mutatedProposalRevisions: new Map([["draft-1", "a".repeat(64)]]) },
      assertSourceCurrent: () => {},
    })).rejects.toThrow("revoked");
    expect(effects).toBe(0);
  });

  it("does not activate a pending proposal just because its id appeared in a review", async () => {
    await activateAutonomousSkillProposals({
      config: auto, getCurrentConfig: () => auto, agentId: "main", workspaceDir: "/workspace",
      budget: { remaining: 0, mutatedProposalIds: new Set(["manual-1"]) },
      assertSourceCurrent: () => {},
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("retains pending state when the source is revoked before activation", async () => {
    await expect(activateAutonomousSkillProposals({
      config: auto, getCurrentConfig: () => auto, agentId: "main", workspaceDir: "/workspace",
      budget: { remaining: 0, mutatedProposalRevisions: new Map([["draft-1", "a".repeat(64)]]) },
      assertSourceCurrent: () => { throw new Error("source deleted"); },
    })).rejects.toThrow("source deleted");
    expect(apply).not.toHaveBeenCalled();
  });
});
