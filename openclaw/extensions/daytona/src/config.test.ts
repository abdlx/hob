import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDaytonaConfig } from "./config.js";

const input = { apiKey: "synthetic-test-credential", snapshot: "test-snapshot", knownHostsFile: path.resolve("test-known-hosts") };

describe("Daytona config admission", () => {
  it("uses bounded lifecycle timeouts and the remote-shell workspace root", () => {
    expect(resolveDaytonaConfig(input)).toMatchObject({ timeoutMs: 120000, workspaceRoot: "/home/daytona/.openclaw" });
  });
  it("refuses unhydrated SecretRefs instead of falling back to ambient credentials", () => {
    expect(() => resolveDaytonaConfig({ ...input, apiKey: { source: "env", provider: "default", id: "DAYTONA_API_KEY" } })).toThrow();
  });
  it.each(["/", "/home/../tmp", "relative", "/home/daytona\nProxyCommand attacker"])("rejects unsafe remote path %s", (workspaceRoot) => {
    expect(() => resolveDaytonaConfig({ ...input, workspaceRoot })).toThrow();
  });
  it("rejects SSH config injection, unpinned hosts and endpoint redirection", () => {
    expect(() => resolveDaytonaConfig({ ...input, knownHostsFile: "relative" })).toThrow();
    expect(() => resolveDaytonaConfig({ ...input, knownHostsFile: `${input.knownHostsFile}\nStrictHostKeyChecking no` })).toThrow();
    expect(() => resolveDaytonaConfig({ ...input, apiUrl: "https://untrusted.invalid" })).toThrow();
  });
});
