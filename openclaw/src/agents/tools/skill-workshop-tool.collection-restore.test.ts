import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { seedLegacyCollectionBackup } from "../../skills/workshop/collection-backup.test-support.js";
import { resolveSkillCollectionBackupRoot } from "../../skills/workshop/collection-paths.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();

describe("skill_workshop collection restore", () => {
  it.each(["off", "propose"] as const)(
    "restores an operator-reviewed backup in mode %s",
    async (mode) => {
      const config: OpenClawConfig = { skills: { workshop: { autonomous: { mode } } } };
      const testState = await createOpenClawTestState({ layout: "state-only" });
      const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-");
      const skillsRoot = resolveWorkshopSkillsDir(config, "main", testState.env);
      const skillFile = path.join(skillsRoot, "duplicate", "SKILL.md");
      try {
        await fs.mkdir(path.dirname(skillFile), { recursive: true });
        await fs.writeFile(
          skillFile,
          "---\nname: duplicate\ndescription: Original\n---\n\n# Original\n",
        );
        await seedLegacyCollectionBackup(
          skillsRoot,
          resolveSkillCollectionBackupRoot(config, "main", testState.env),
          async () => {
            await fs.writeFile(skillFile, "---\nname: duplicate\ndescription: New\n---\n\n# New\n");
          },
        );

        const tool = createSkillWorkshopTool({
          workspaceDir,
          config,
          agentId: "main",
          env: testState.env,
        });
        await tool.execute("restore", { action: "restore_collection" });
        await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
      } finally {
        await testState.cleanup();
        await tempDirs.cleanup();
      }
    },
  );

  it.each(["before restore", "during forward copy"] as const)(
    "refuses captured automatic restore approval revoked %s",
    async (when) => {
      const testState = await createOpenClawTestState({ layout: "state-only" });
      const config: OpenClawConfig = { skills: { workshop: { approvalPolicy: "auto" } } };
      setRuntimeConfigSnapshot(config);
      const skillsRoot = resolveWorkshopSkillsDir(config, "main", testState.env);
      const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
      try {
        await fs.mkdir(path.dirname(skillFile), { recursive: true });
        await fs.writeFile(
          skillFile,
          "---\nname: procedure\ndescription: Procedure\n---\n\n# Original\n",
        );
        const backupDir = await seedLegacyCollectionBackup(
          skillsRoot,
          resolveSkillCollectionBackupRoot(config, "main", testState.env),
          () =>
            fs.writeFile(
              skillFile,
              "---\nname: procedure\ndescription: Procedure\n---\n\n# Reviewed\n",
            ),
        );
        const before = await fs.readFile(skillFile);
        const tool = createSkillWorkshopTool({
          workspaceDir: testState.workspaceDir,
          config,
          agentId: "main",
          env: testState.env,
        });
        const revoke = () =>
          setRuntimeConfigSnapshot({ skills: { workshop: { approvalPolicy: "pending" } } });
        if (when === "before restore") {
          revoke();
        } else {
          const copy = fs.cp.bind(fs);
          vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
            await copy(source, destination, options);
            if (source === path.join(backupDir, "skills", "procedure")) {
              revoke();
            }
          });
        }
        await expect(tool.execute("restore", { action: "restore_collection" })).rejects.toThrow(
          "automatic approval was revoked",
        );
        expect(await fs.readFile(skillFile)).toEqual(before);
        await expect(
          fs.readFile(path.join(backupDir, "skills", "procedure", "SKILL.md"), "utf8"),
        ).resolves.toContain("# Original");
        expect(
          (await fs.readdir(backupDir)).some((entry) => entry.startsWith(".restore-")),
        ).toBe(false);
      } finally {
        vi.restoreAllMocks();
        clearRuntimeConfigSnapshot();
        await testState.cleanup();
      }
    },
  );
});
