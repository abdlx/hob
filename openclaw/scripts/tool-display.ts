// Tool Display script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DISPLAY_CONFIG } from "../src/agents/tool-display-config.js";
import { isTestOnlyPath } from "./lib/changed-path-facts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const toolSources = [
  path.join(repoRoot, "src/agents/apply-patch.ts"),
  path.join(repoRoot, "src/agents/bash-tools.exec-run.ts"),
  path.join(repoRoot, "src/agents/bash-tools.process.ts"),
  path.join(repoRoot, "src/auto-reply/reply/acp-projector.ts"),
];

const args = new Set(process.argv.slice(2));
const shouldCheck = args.has("--check");
const shouldWrite = args.has("--write");

if (!shouldCheck && !shouldWrite) {
  console.error("Usage: node --import tsx scripts/tool-display.ts --check|--write");
  process.exit(1);
}

ensureCoreToolCoverage();
process.stdout.write("tool-display runtime metadata is complete\n");

function ensureCoreToolCoverage() {
  const toolNames = new Set<string>();
  for (const sourcePath of toolSources) {
    collectToolNamesFromFile(sourcePath, toolNames);
  }
  for (const entry of fs.readdirSync(path.join(repoRoot, "src/agents/tools"))) {
    if (!entry.endsWith(".ts") || isTestOnlyPath(entry)) {
      continue;
    }
    collectToolNamesFromFile(path.join(repoRoot, "src/agents/tools", entry), toolNames);
  }
  const missing = [...toolNames].filter((name) => !TOOL_DISPLAY_CONFIG.tools[name]).toSorted();
  if (missing.length > 0) {
    console.error(
      `tool-display metadata missing for runtime tools: ${missing.join(", ")}\nupdate: src/agents/tool-display-config.ts`,
    );
    process.exit(1);
  }
}

function collectToolNamesFromFile(sourcePath: string, names: Set<string>) {
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const match of source.matchAll(/\bname:\s*"([A-Za-z0-9_-]+)"/g)) {
    const name = match[1]?.trim();
    if (name) {
      names.add(name);
    }
  }
}

