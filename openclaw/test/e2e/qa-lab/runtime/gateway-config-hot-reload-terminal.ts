import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type {
  TerminalAckResult,
  TerminalDataEvent,
  TerminalOpenResult,
} from "../../../../packages/gateway-protocol/src/schema/terminal.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

type TerminalProofParams = {
  gateway: QaGatewayChild;
  primary: HotReloadConnection;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown) => Promise<unknown>;
  http: (route: string) => Promise<{ status: number; text: string; headers: Headers }>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
};

export async function writeHotReloadTerminalCatalog(root: string): Promise<string> {
  const directory = path.join(root, "catalog-plugin");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "qa-hot-reload-shell",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "qa-hot-reload-shell",
      name: "Hot reload synthetic CLI catalog",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(directory, "index.mjs"),
    `export default {
    id: "qa-hot-reload-shell",
    name: "Hot reload synthetic CLI catalog",
    register(api) {
      api.registerSessionCatalog({
        id: "qa-hot-reload-shell", label: "Synthetic shell CLI", supportsProcessHomeIsolation: true,
        list: async () => [], read: async () => ({ items: [] }),
        startTerminalSession: async ({ cwd }) => ({ kind: "local", argv: ["/bin/sh"], cwd, title: "Synthetic CLI" }),
      });
    },
  };`,
  );
  return directory;
}

async function shellPid(
  connection: HotReloadConnection,
  terminal: TerminalOpenResult,
  label: string,
  write?: (command: string) => Promise<void>,
) {
  const cursor = connection.events.length;
  const marker = `HOT_TERMINAL_${label}`;
  // Separate the marker in stdin so echoed keystrokes cannot prove shell execution.
  const command = `printf '%s%s=%s\\n' 'HOT_TERMINAL_' '${label}' "$$"\n`;
  if (write) {
    await write(command);
  } else {
    const result = await connection.client.request<TerminalAckResult>("terminal.input", {
      sessionId: terminal.sessionId,
      data: command,
    });
    assert.equal(result.ok, true);
  }
  return await waitForHotReloadFact(`${label} shell PID output`, () => {
    const output = connection.events
      .slice(cursor)
      .flatMap((event) => {
        const payload = event.payload as TerminalDataEvent | undefined;
        return event.event === "terminal.data" && payload?.sessionId === terminal.sessionId
          ? [payload.data]
          : [];
      })
      .join("");
    const matched = output.match(new RegExp(`${marker}=(\\d+)`));
    return matched ? Number(matched[1]) : undefined;
  });
}

async function waitForShellExit(pid: number) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  await waitForHotReloadFact(`terminal shell ${pid} exit`, () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    }
  });
}

export async function proveHotReloadTerminalStartup({
  primary,
  rpc,
  patch,
  verifyContinuity,
  proveGroup,
}: TerminalProofParams) {
  await proveGroup("gateway.terminal.enabled.startup", async () => {
    await assert.rejects(
      rpc("terminal.open", { agentId: "qa", cols: 80, rows: 24 }),
      /terminal is disabled/,
    );
    await patch({ gateway: { terminal: { enabled: true } } });
    const terminal = await rpc<TerminalOpenResult>("terminal.open", {
      agentId: "qa",
      cols: 80,
      rows: 24,
    });
    const pid = await shellPid(primary, terminal, "FIRST_ENABLE");
    assert.equal(
      (await rpc<TerminalAckResult>("terminal.close", { sessionId: terminal.sessionId })).ok,
      true,
    );
    await waitForShellExit(pid);
    await verifyContinuity(
      "gateway.terminal.enabled.startup",
      "The Gateway started disabled, rejected terminal.open, then hot enablement opened and executed a real PTY on the original boot",
    );
  });
  await patch({ gateway: { terminal: { enabled: true } } });
}

