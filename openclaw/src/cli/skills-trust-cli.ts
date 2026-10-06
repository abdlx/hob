import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { decideSkillTrust, inspectSkillTrust, verifySkillTrust } from "../skills/security/trust.js";
import { readSkillBundleTree } from "../skills/library/bundle.js";
import { skillTrustSource } from "../skills/security/trust-admission.js";
import { shouldSyncSkillPath } from "../skills/loading/skill-paths.js";
import { resolveUserPath } from "../utils.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerSkillsTrustCli(skills: Command) {
  const trust = skills.command("trust").description("Inspect content trust and decide exact caution revisions");
  trust.command("scan <directory>").description("Inspect a complete local skill bundle without activating it")
    .option("--target <directory>", "Installed target identity, when inspecting an install candidate")
    .option("--source <identity>", "Exact source identity from a blocked Library revision")
    .action((directory: string, options: { target?: string; source?: string }) => runCommandWithRuntime(defaultRuntime, async () => {
      const source = options.source ?? skillTrustSource(resolveUserPath(options.target ?? directory));
      const inspection = await verifySkillTrust({ objectId: `skill:${source}`, source, files: await readSkillBundleTree(resolveUserPath(directory), shouldSyncSkillPath) });
      defaultRuntime.log(JSON.stringify(inspection, null, 2));
    }));
  trust.command("inspect <revision>").description("Show an immutable scanner attestation and its current decision")
    .action((revisionId: string) => runCommandWithRuntime(defaultRuntime, async () => {
      const record = await inspectSkillTrust(revisionId);
      if (!record) {
        throw new Error("Unknown trust revision.");
      }
      defaultRuntime.log(JSON.stringify(record, null, 2));
    }));
  for (const decision of ["allow", "reject"] as const) {
    trust.command(`${decision} <revision>`).description(`${decision === "allow" ? "Approve" : "Reject"} the exact inspected content hash`)
      .requiredOption("--hash <sha256>", "Exact content hash shown by inspect")
      .action((revisionId: string, options: { hash: string }) => runCommandWithRuntime(defaultRuntime, async () => {
        // A local operator command is explicit intent. No agent tool calls this decision owner.
        const result = await decideSkillTrust({ revisionId, contentHash: options.hash, decision, actor: "local-operator" });
        defaultRuntime.log(JSON.stringify(result, null, 2));
      }));
  }
}
