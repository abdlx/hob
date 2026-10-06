// Memory Core plugin module owns consolidation preimages and operator summaries.
import { createHash } from "node:crypto";
import path from "node:path";
import { updateDreamsFile } from "./dreaming-dreams-file.js";
import {
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  DREAMING_MEMORY_BACKUP_NAMESPACE,
} from "./dreaming-state.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";
import { commitMemoryContent, hashMemoryContent, readMemoryContent, resolveMemoryWritePath } from "./short-term-promotion-memory-write.js";
import { makeWorkspaceDirectory } from "./memory-workspace-files.js";

const CONSOLIDATION_BACKUP_LIMIT = 8;

/** A named Markdown retrieval source survives index rebuilds and backup rotation. */
export async function storeMemoryRetrievalPreimage(params: { workspaceDir: string; content: string }): Promise<string> {
  const contentHash = hashMemoryContent(params.content);
  const memoryDir = path.join(params.workspaceDir, "memory");
  await makeWorkspaceDirectory(params.workspaceDir, memoryDir);
  const filePath = await resolveMemoryWritePath(path.join(memoryDir, `canonical-preimage-${contentHash}.md`), params.workspaceDir);
  const current = await readMemoryContent(filePath, params.workspaceDir);
  if (current === params.content) return filePath;
  if (current.length > 0) throw new Error("Canonical retrieval archive content conflicts with its pinned hash.");
  await commitMemoryContent({ workspaceDir: params.workspaceDir, filePath, tempPrefix: "canonical-preimage", expectedHash: hashMemoryContent(""), content: params.content });
  if (hashMemoryContent(await readMemoryContent(filePath, params.workspaceDir)) !== contentHash) throw new Error("Canonical retrieval archive verification failed.");
  return filePath;
}

type ConsolidationBackup = {
  createdAt: string;
  content: string;
  contentHash: string;
};

export type MemoryConsolidationResult = {
  content: string;
  added: number;
  merged: number;
  superseded: number;
  highlights: string[];
};

export function readMemoryPreimages(workspaceDir: string) {
  return readMemoryCoreWorkspaceEntries<ConsolidationBackup>({
    namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
    workspaceDir,
  });
}

export async function storeMemoryPreimage(params: {
  workspaceDir: string;
  content: string;
  nowMs: number;
  agentIds: readonly string[];
  retainedEntryKeys: ReadonlySet<string>;
}): Promise<Set<string>> {
  await storeMemoryRetrievalPreimage(params);
  const current = await readMemoryPreimages(params.workspaceDir);
  const createdAt = new Date(params.nowMs).toISOString();
  const contentHash = createHash("sha256").update(params.content).digest("hex");
  const entries = [
    ...current,
    {
      key: `${createdAt}:${contentHash.slice(0, 12)}`,
      value: { createdAt, content: params.content, contentHash },
    },
  ]
    .toSorted((left, right) => left.value.createdAt.localeCompare(right.value.createdAt))
    .slice(-CONSOLIDATION_BACKUP_LIMIT);
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
    workspaceDir: params.workspaceDir,
    entries,
  });
  const retainedKeys = new Set(entries.flatMap(({ value }) => extractPromotionKeys(value.content)));
  // Rotating recovery backups does not release lineage: immutable retrieval
  // preimages retain these facts until an explicit forget scrubs them.
  return retainedKeys;
}

async function appendConsolidationHistory(
  workspaceDir: string,
  nowMs: number,
  bodyLines: string[],
): Promise<void> {
  const timestamp = new Date(nowMs).toISOString();
  await updateDreamsFile({
    workspaceDir,
    updater: (existing) => {
      const heading = "## Memory Consolidation History";
      const base = existing.includes(heading)
        ? existing.trimEnd()
        : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${heading}`;
      return {
        content: `${base}\n\n### ${timestamp}\n\n${bodyLines.join("\n")}\n`,
        result: undefined,
      };
    },
  });
}

export async function appendConsolidationSummary(params: {
  workspaceDir: string;
  result: MemoryConsolidationResult;
  nowMs: number;
}): Promise<void> {
  await appendConsolidationHistory(params.workspaceDir, params.nowMs, [
    `- Added: ${params.result.added}`,
    `- Merged: ${params.result.merged}`,
    `- Superseded: ${params.result.superseded}`,
    ...params.result.highlights,
  ]);
}

export async function appendConsolidationSkippedSummary(params: {
  workspaceDir: string;
  nowMs: number;
  reason: string;
}): Promise<void> {
  await appendConsolidationHistory(params.workspaceDir, params.nowMs, [
    `- Rewrite skipped: ${params.reason}.`,
    "- Fallback: append-only promotion.",
  ]);
}
