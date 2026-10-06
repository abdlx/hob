import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { createSandbox } from "../../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { agentsHandlers } from "./agents.js";

type HandlerCall = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The real remote scripts require GNU tools, as they do on the execution host.
const hasGnuShell =
  process.platform !== "win32" &&
  spawnSync("stat", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU coreutils");

for (const storage of ["local", "remote"] as const) {
  describe.runIf(storage === "local" || hasGnuShell)(
    `agents.files.get/set content hashes (${storage})`,
    () => {
      const tempDirs = useAutoCleanupTempDirTracker(afterEach);
      let workspace: string;
      let storageDir: string;
      let release: (() => void) | undefined;
      let remoteBridge: ReturnType<typeof createRemoteShellSandboxFsBridge> | undefined;

      afterEach(() => {
        release?.();
        release = undefined;
      });

      beforeEach(() => {
        workspace = fs.realpathSync(tempDirs.make("openclaw-agent-files-"));
        storageDir = workspace;
        remoteBridge = undefined;
        if (storage === "remote") {
          storageDir = fs.realpathSync(tempDirs.make("openclaw-remote-agent-files-"));
          remoteBridge = createRemoteShellSandboxFsBridge({
            sandbox: createSandbox({ workspaceDir: workspace, agentWorkspaceDir: workspace }),
            runtime: {
              remoteWorkspaceDir: storageDir,
              remoteAgentWorkspaceDir: storageDir,
              runRemoteShellScript: createLocalRemoteShellScriptRunner(),
            },
          });
          release = registerAgentWorkspaceAccess(workspace, { bridge: remoteBridge });
        }
      });

      async function invokeAgentFilesHandler(
        method: "agents.files.list" | "agents.files.get" | "agents.files.set",
        params: Record<string, unknown>,
      ): Promise<HandlerCall> {
        const calls: HandlerCall[] = [];
        await agentsHandlers[method]?.({
          req: { type: "req", id: method, method, params: {} },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            calls.push({ ok, payload, error });
          },
          context: {
            getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
          } as never,
        });
        expect(calls).toHaveLength(1);
        return calls[0] as HandlerCall;
      }

      function readMemory(): string {
        return fs.readFileSync(path.join(storageDir, "MEMORY.md"), "utf8");
      }

      it("preserves the first creation when two clients read a missing document", async () => {
        const name = "MEMORY.md";
        for (let reader = 0; reader < 2; reader += 1) {
          const read = await invokeAgentFilesHandler("agents.files.get", { agentId: "main", name });
          expect(read).toMatchObject({ ok: true, payload: { file: { missing: true } } });
        }
        expect(fs.existsSync(path.join(storageDir, name))).toBe(false);
        const first = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name,
          content: "# Memory\n- first operator\n",
          expectedMissing: true,
        });
        expect(first.ok).toBe(true);
        const second = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name,
          content: "# Memory\n- second operator\n",
          expectedMissing: true,
        });
        expect(second).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { type: "agent_file_conflict", name } },
        });
        expect(readMemory()).toBe("# Memory\n- first operator\n");
      });

      it.runIf(storage === "remote")(
        "refuses conditional creation without provider support while preserving explicit blind writes",
        async () => {
          if (!remoteBridge) {
            throw new Error("Expected the remote workspace fixture");
          }
          release?.();
          release = registerAgentWorkspaceAccess(workspace, {
            bridge: {
              readFile: remoteBridge.readFile.bind(remoteBridge),
              writeFile: remoteBridge.writeFile.bind(remoteBridge),
              stat: remoteBridge.stat.bind(remoteBridge),
            },
          });
          const refused = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "unsaved new memory",
            expectedMissing: true,
          });
          expect(refused).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          expect(refused.error?.message).toContain("Update its workspace provider");
          expect(fs.existsSync(path.join(storageDir, "MEMORY.md"))).toBe(false);
          const result = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "explicit blind write",
          });
          expect(result.ok).toBe(true);
          expect(readMemory()).toBe("explicit blind write");
        },
      );

      it("lists a directory named AGENTS.md as a missing document", async () => {
        fs.mkdirSync(path.join(storageDir, "AGENTS.md"));
        const call = await invokeAgentFilesHandler("agents.files.list", { agentId: "main" });
        expect(call.ok).toBe(true);
        const file = (
          call.payload as { files: Array<{ name: string; missing: boolean }> }
        ).files.find((entry) => entry.name === "AGENTS.md");
        expect(file).toMatchObject({ name: "AGENTS.md", missing: true });
        expect(file).not.toHaveProperty("size", expect.any(Number));
      });

      it.each(["conflicting-preconditions", "expected-present", "stale", "gone"] as const)(
        "refuses a save with %s preconditions without overwriting the document",
        async (variant) => {
          const name = "MEMORY.md";
          let expectedHash = hashContent("# Memory\n");
          if (variant === "stale") {
            fs.writeFileSync(path.join(storageDir, name), "# Memory\n");
            const opened = await invokeAgentFilesHandler("agents.files.get", {
              agentId: "main",
              name,
            });
            expect(opened.ok).toBe(true);
            const openedHash = (opened.payload as { file: { hash: string } }).file.hash;
            expect(openedHash).toBe(expectedHash);
            expectedHash = openedHash;
            fs.appendFileSync(path.join(storageDir, name), "- agent learned a birthday\n");
          }
          const preconditions =
            variant === "conflicting-preconditions"
              ? { expectedMissing: true, expectedHash: hashContent("old") }
              : variant === "expected-present"
                ? { expectedMissing: false }
                : { expectedHash };
          const call = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name,
            content: "# Memory\n- operator note\n",
            ...preconditions,
          });
          expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          if (variant === "stale" || variant === "gone") {
            expect(call.error?.details).toEqual({
              type: "agent_file_conflict",
              name,
              ...(variant === "stale"
                ? { currentHash: hashContent("# Memory\n- agent learned a birthday\n") }
                : {}),
            });
          }
          if (variant === "stale") {
            expect(readMemory()).toBe("# Memory\n- agent learned a birthday\n");
          } else {
            expect(fs.existsSync(path.join(storageDir, name))).toBe(false);
          }
        },
      );

      it.each(["uppercase", "omitted"] as const)(
        "writes with an %s expectedHash and returns the new hash",
        async (hashCase) => {
          fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
          const expectedHash = hashContent("# Memory\n");

          const call = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- operator note\n",
            ...(hashCase === "uppercase" ? { expectedHash: expectedHash.toUpperCase() } : {}),
          });

          expect(call.ok).toBe(true);
          expect((call.payload as { file: { hash?: string } }).file.hash).toBe(
            hashContent("# Memory\n- operator note\n"),
          );
          expect(readMemory()).toBe("# Memory\n- operator note\n");
        },
      );

      it("admits only one of two concurrent saves that share an expectedHash", async () => {
        fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
        const expectedHash = hashContent("# Memory\n");

        const [first, second] = await Promise.all([
          invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- first operator\n",
            expectedHash,
          }),
          invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- second operator\n",
            expectedHash,
          }),
        ]);

        const calls = [first, second];
        expect(calls.filter((call) => call.ok)).toHaveLength(1);
        const conflict = calls.find((call) => !call.ok)?.error as {
          details: { type: string; currentHash: string };
        };
        expect(conflict.details.type).toBe("agent_file_conflict");
        expect(["# Memory\n- first operator\n", "# Memory\n- second operator\n"]).toContain(
          readMemory(),
        );
        expect(conflict.details.currentHash).toBe(hashContent(readMemory()));
      });
    },
  );
}
