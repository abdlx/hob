// Gateway protocol compatibility invariants retained for the headless backend.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./version.js";

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

function assertPattern(
  content: string,
  relativePath: string,
  pattern: RegExp,
  message: string,
): void {
  if (!pattern.test(content)) {
    throw new Error(`${relativePath}: ${message}`);
  }
}

describe("Gateway protocol levels", () => {
  it("keeps client compatibility and the node/probe N-1 invariant", () => {
    if (MIN_CLIENT_PROTOCOL_VERSION > PROTOCOL_VERSION) {
      throw new Error(
        `packages/gateway-protocol/src/version.ts: MIN_CLIENT_PROTOCOL_VERSION (${MIN_CLIENT_PROTOCOL_VERSION}) must not exceed PROTOCOL_VERSION (${PROTOCOL_VERSION}).`,
      );
    }
    if (
      MIN_NODE_PROTOCOL_VERSION !== PROTOCOL_VERSION - 1 ||
      MIN_PROBE_PROTOCOL_VERSION !== PROTOCOL_VERSION - 1
    ) {
      throw new Error(
        "packages/gateway-protocol/src/version.ts: node and probe compatibility must remain exactly N-1.",
      );
    }

  });

  it("uses the TypeScript source of truth for dev Gateway smoke scripts", async () => {
    const devScripts = ["scripts/dev/gateway-smoke.ts"];
    for (const relativePath of devScripts) {
      const content = await readRepoFile(relativePath);
      assertPattern(
        content,
        relativePath,
        /MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must import/use MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /PROTOCOL_VERSION/,
        "connect params must import/use PROTOCOL_VERSION as maxProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /minProtocol:\s*MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must advertise MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /maxProtocol:\s*PROTOCOL_VERSION/,
        "connect params must advertise PROTOCOL_VERSION as maxProtocol.",
      );
    }
  });

});
