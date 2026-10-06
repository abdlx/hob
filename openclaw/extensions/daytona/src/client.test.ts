import { describe, expect, it, vi } from "vitest";
import { DaytonaClient, daytonaConfigLabel } from "./client.js";
import type { DaytonaConfig } from "./config.js";

const runtimeId = "openclaw-12345678-1234-4234-8234-123456789012";
const config: DaytonaConfig = {
  apiKey: "synthetic-test-credential",
  snapshot: "test-snapshot",
  knownHostsFile: "/test/known_hosts",
  workspaceRoot: "/home/daytona/.openclaw",
  timeoutMs: 1000,
};
const sandbox = (state = "started") => ({
  id: "sandbox-test",
  name: runtimeId,
  state,
  labels: { "openclaw.runtime": runtimeId, "openclaw.config": daytonaConfigLabel(config) },
});
const json = (value: unknown) => Response.json(value);
const missing = () => new Response(null, { status: 404 });

describe("Daytona reserved-runtime lifecycle", () => {
  it("allocates under the exact durable name and waits for started", async () => {
    const fetchApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(json(sandbox("creating")))
      .mockResolvedValueOnce(json(sandbox()));
    await expect(new DaytonaClient(config, fetchApi).ensure(runtimeId, () => {}))
      .resolves.toMatchObject({ name: runtimeId, state: "started" });
    const post = fetchApi.mock.calls[1];
    expect(post?.[0]).toBe("https://app.daytona.io/api/sandbox");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      name: runtimeId,
      snapshot: "test-snapshot",
      public: false,
      autoDeleteInterval: -1,
    });
    expect(post?.[1]?.redirect).toBe("error");
  });

  it("reconciles a lost allocation reply without issuing a second POST", async () => {
    const fetchApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(missing())
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(json(sandbox()));
    const client = new DaytonaClient(config, fetchApi);
    await expect(client.ensure(runtimeId, () => {})).rejects.toThrow("inspect the reserved runtime");
    await expect(client.ensure(runtimeId, () => {})).resolves.toMatchObject({ name: runtimeId });
    expect(fetchApi.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("refuses foreign generations even when the name matches", async () => {
    const foreign = sandbox();
    foreign.labels["openclaw.runtime"] = "foreign";
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(json(foreign));
    await expect(new DaytonaClient(config, fetchApi).remove(runtimeId)).rejects.toThrow("reserved generation");
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("rechecks authority after inspection before allocating", async () => {
    let active = true;
    const fetchApi = vi.fn<typeof fetch>().mockImplementation(async () => {
      active = false;
      return missing();
    });
    await expect(new DaytonaClient(config, fetchApi).ensure(runtimeId, () => {
      if (!active) { throw new Error("revoked"); }
    })).rejects.toThrow("revoked");
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("revokes an exact new token if authority closes during access creation", async () => {
    let active = true;
    const fetchApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(sandbox()))
      .mockImplementationOnce(async () => { active = false; return json({ token: "test-token" }); })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(new DaytonaClient(config, fetchApi).createSshAccess(runtimeId, () => {
      if (!active) { throw new Error("revoked"); }
    })).rejects.toThrow("revoked");
    expect(fetchApi.mock.calls[2]?.[0]).toContain("ssh-access?token=test-token");
    expect(fetchApi.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  it("proves destruction rather than treating DELETE acceptance as cleanup", async () => {
    const fetchApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(sandbox()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(missing());
    await new DaytonaClient(config, fetchApi).remove(runtimeId);
    expect(fetchApi.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("keeps an indeterminate destruction retryable", async () => {
    const fetchApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(sandbox()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("network lost"));
    await expect(new DaytonaClient(config, fetchApi).remove(runtimeId)).rejects.toThrow("transport failed");
  });

  it("does not expose token-bearing URLs or vendor error bodies", async () => {
    const fetchApi = vi.fn<typeof fetch>().mockRejectedValue(new Error("URL contains test-token"));
    await expect(new DaytonaClient(config, fetchApi).revokeSshAccess(runtimeId, "test-token"))
      .rejects.toThrow("Daytona transport failed");
    const httpFailure = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-test-credential", { status: 403 }));
    await expect(new DaytonaClient(config, httpFailure).inspect(runtimeId)).rejects.toThrow("HTTP 403");
  });

  it("blocks stale snapshot configurations and non-owned runtime names", async () => {
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(json(sandbox()));
    await expect(new DaytonaClient({ ...config, snapshot: "different" }, fetchApi).inspect(runtimeId))
      .rejects.toThrow("configuration differs");
    await expect(new DaytonaClient(config, fetchApi).inspect("foreign-name"))
      .rejects.toThrow("reserved generation");
  });
});
