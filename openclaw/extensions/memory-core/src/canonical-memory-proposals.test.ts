import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ records: new Map<string, unknown>(), content: "old fact", archive: [] as string[], indexed: false }));
vi.mock("./dreaming-state.js", () => ({
  DREAMING_CANONICAL_PROPOSALS_NAMESPACE: "canonical-test",
  readMemoryCoreWorkspaceEntries: async () => [...state.records].map(([key, value]) => ({ key, value })),
  writeMemoryCoreWorkspaceEntry: async ({ key, value }: { key: string; value: unknown }) => { state.records.set(key, value); },
}));
vi.mock("./memory-workspace-lock.js", () => ({ withMemoryWorkspaceLock: async (_workspace: string, run: () => Promise<unknown>) => run() }));
vi.mock("./dreaming-consolidation-artifacts.js", () => ({ storeMemoryRetrievalPreimage: async ({ content }: { content: string }) => { state.archive.push(content); } }));
vi.mock("./memory-entry-origins.js", () => ({ reserveMemoryEntryOrigins: async () => async () => {} }));
vi.mock("./short-term-promotion-memory-write.js", () => ({
  hashMemoryContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  readMemoryContent: async () => state.content,
  resolveMemoryWritePath: async (path: string) => path,
  MemoryAtomicPublicationError: class extends Error {},
  commitMemoryContent: async ({ content, assertCurrent, expectedHash }: { content: string; assertCurrent: () => void; expectedHash: string }) => {
    assertCurrent();
    if (!state.indexed) throw new Error("Archive not indexed");
    if (createHash("sha256").update(state.content).digest("hex") !== expectedHash) throw new Error("Source changed");
    state.content = content;
  },
}));
vi.mock("openclaw/plugin-sdk/agent-workspace-runtime", () => ({ getAgentWorkspaceAccess: () => undefined }));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./short-term-promotion-utils.js", () => ({ isContaminatedDreamingSnippet: (content: string) => content.includes("malicious") }));
import { decideCanonicalMemoryProposal, listCanonicalMemoryProposals, resolveCanonicalActivationPolicy, stageCanonicalMemoryProposal } from "./canonical-memory-proposals.js";

beforeEach(() => { state.records.clear(); state.content = "old fact"; state.archive.length = 0; state.indexed = false; });
describe("canonical memory review", () => {
  const stage = () => stageCanonicalMemoryProposal({ workspaceDir: "/workspace", before: "old fact", after: "compact fact", nowMs: 0 });
  const indexArchive = async () => { state.indexed = true; };
  it("requires explicit automatic policy and never mutates while staging", async () => {
    expect(resolveCanonicalActivationPolicy()).toBe("pending");
    expect(resolveCanonicalActivationPolicy({ plugins: { entries: { "memory-core": { config: { canonicalActivationPolicy: "invalid" } } } } })).toBe("pending");
    expect(resolveCanonicalActivationPolicy({ plugins: { entries: { "memory-core": { config: { canonicalActivationPolicy: "auto" } } } } })).toBe("auto");
    await stage();
    expect(state.content).toBe("old fact");
    expect((await listCanonicalMemoryProposals("/workspace"))[0]?.status).toBe("pending");
  });
  it("preserves and indexes the exact preimage before approved publication", async () => {
    const proposal = await stage();
    await decideCanonicalMemoryProposal({ workspaceDir: "/workspace", id: proposal.id, decision: "apply", indexArchive });
    expect(state.archive).toEqual(["old fact"]);
    expect(state.content).toBe("compact fact");
    expect((await listCanonicalMemoryProposals("/workspace"))[0]?.status).toBe("applied");
  });
  it("rejects a stale reviewed preimage without archiving or writing", async () => {
    const proposal = await stage(); state.content = "new user fact";
    await expect(decideCanonicalMemoryProposal({ workspaceDir: "/workspace", id: proposal.id, decision: "apply", indexArchive })).rejects.toThrow("changed since review");
    expect(state.archive).toEqual([]);
    expect(state.content).toBe("new user fact");
  });
  it("leaves canonical memory unchanged if retrieval indexing fails", async () => {
    const proposal = await stage();
    await expect(decideCanonicalMemoryProposal({ workspaceDir: "/workspace", id: proposal.id, decision: "apply", indexArchive: async () => { throw new Error("index unavailable"); } })).rejects.toThrow("index unavailable");
    expect(state.content).toBe("old fact");
    expect((await listCanonicalMemoryProposals("/workspace"))[0]?.status).toBe("pending");
  });
  it("rechecks authority after indexing and rejects without publication", async () => {
    const proposal = await stage(); let current = true;
    await expect(decideCanonicalMemoryProposal({ workspaceDir: "/workspace", id: proposal.id, decision: "apply", assertCurrent: () => { if (!current) throw new Error("revoked"); }, indexArchive: async () => { state.indexed = true; current = false; } })).rejects.toThrow("revoked");
    expect(state.content).toBe("old fact");
  });
  it("rejects without changing the source, and rejects unsafe/oversized proposals", async () => {
    const proposal = await stage();
    await decideCanonicalMemoryProposal({ workspaceDir: "/workspace", id: proposal.id, decision: "reject", indexArchive });
    expect(state.content).toBe("old fact");
    expect((await listCanonicalMemoryProposals("/workspace"))[0]?.status).toBe("rejected");
    await expect(stageCanonicalMemoryProposal({ workspaceDir: "/workspace", before: "old", after: "x".repeat(4_001), nowMs: 0 })).rejects.toThrow("budget");
    await expect(stageCanonicalMemoryProposal({ workspaceDir: "/workspace", before: "old", after: "malicious", nowMs: 0 })).rejects.toThrow("rejected content");
  });
});
