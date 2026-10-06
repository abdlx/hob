import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRuntimeLifecycleRegistration } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getSandboxBackendFactory, getSandboxBackendManager } from "openclaw/plugin-sdk/sandbox";
import plugin from "./index.js";

describe("Daytona optional backend registration lifecycle", () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) { await stop(); }
  });

  function register() {
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    plugin.register(createTestPluginApi({
      id: "daytona",
      pluginConfig: {
        apiKey: "synthetic-test-credential",
        snapshot: "test-snapshot",
        knownHostsFile: path.resolve("test-known-hosts"),
      },
      registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    }));
    const cleanup = async (context: Parameters<NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>>[0]) => {
      for (const lifecycle of lifecycles.toReversed()) { await lifecycle.cleanup?.(context); }
    };
    stops.push(() => cleanup({ reason: "disable" }));
    return cleanup;
  }

  it.each(["disable", "restart"] as const)("retires eager registrations on global %s", async (reason) => {
    const original = getSandboxBackendFactory("daytona");
    const cleanup = register();
    expect(getSandboxBackendFactory("daytona")).toEqual(expect.any(Function));
    expect(getSandboxBackendManager("daytona")).toEqual({ describeRuntime: expect.any(Function), removeRuntime: expect.any(Function) });
    await cleanup({ reason });
    expect(getSandboxBackendFactory("daytona")).toBe(original);
  });

  it("keeps a global backend during session-scoped cleanup", async () => {
    const cleanup = register();
    const factory = getSandboxBackendFactory("daytona");
    await cleanup({ reason: "disable", sessionKey: "agent:test:main" });
    expect(getSandboxBackendFactory("daytona")).toBe(factory);
  });

  it("does not resolve credentials or register a backend in discovery mode", () => {
    const original = getSandboxBackendFactory("daytona");
    plugin.register(createTestPluginApi({ id: "daytona", registrationMode: "discovery", pluginConfig: {} }));
    expect(getSandboxBackendFactory("daytona")).toBe(original);
  });
});
