import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it.each([undefined, {}, { skills: {} }, { skills: { workshop: {} } }])(
    "defaults missing settings to staged proposals (%j)",
    (config) => {
      expect(resolveSkillWorkshopConfig(config)).toMatchObject({
        autonomous: { mode: "propose" },
        approvalPolicy: "pending",
      });
    },
  );

  it.each(["off", "propose", "auto"] as const)("reads autonomous mode %s", (mode) => {
    const config = { skills: { workshop: { autonomous: { mode } } } };
    expect(resolveSkillWorkshopConfig(config).autonomous.mode).toBe(mode);
    expect(resolveSkillWorkshopConfig(JSON.parse(JSON.stringify(config)))).toEqual(
      resolveSkillWorkshopConfig(config),
    );
  });

  it.each(["pending", "auto"] as const)("preserves explicit approval policy %s", (approvalPolicy) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { approvalPolicy } } }).approvalPolicy,
    ).toBe(approvalPolicy);
  });

  it.each([null, false, true, 0, "unknown", "AUTO", {}, []])(
    "never treats malformed settings as automatic authority (%j)",
    (value) => {
      expect(
        resolveSkillWorkshopConfig({
          skills: { workshop: { autonomous: { mode: value }, approvalPolicy: value } },
        } as never),
      ).toMatchObject({ autonomous: { mode: "propose" }, approvalPolicy: "pending" });
    },
  );

  it("keeps autonomous opt-in separate from lifecycle approval opt-in", () => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { mode: "auto" } } } }),
    ).toMatchObject({ autonomous: { mode: "auto" }, approvalPolicy: "pending" });
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { approvalPolicy: "auto" } } }),
    ).toMatchObject({ autonomous: { mode: "propose" }, approvalPolicy: "auto" });
  });

  it("does not read the retired boolean key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { enabled: false } } },
      } as never).autonomous.mode,
    ).toBe("propose");
  });
});
