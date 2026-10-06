import { createHash } from "node:crypto";
import type { DaytonaConfig } from "./config.js";

const API_URL = "https://app.daytona.io/api";
const OWNER_LABEL = "openclaw.runtime";
const CONFIG_LABEL = "openclaw.config";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type DaytonaSandbox = {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
};

export function daytonaConfigLabel(config: DaytonaConfig): string {
  // Credentials rotate without changing the owned filesystem identity.
  return createHash("sha256").update(JSON.stringify({
    snapshot: config.snapshot,
    workspaceRoot: config.workspaceRoot,
    knownHostsFile: config.knownHostsFile,
  })).digest("hex");
}

export class DaytonaClient {
  constructor(private readonly config: DaytonaConfig, private readonly fetchApi: typeof fetch = fetch) {}

  private async request(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchApi(`${API_URL}${route}`, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
        : AbortSignal.timeout(this.config.timeoutMs),
    }).catch(() => {
      // The URL for exact-token revocation is itself sensitive. Do not retain
      // transport errors or their causes, which can include that request URL.
      throw new Error("Daytona transport failed; inspect the reserved runtime before retrying.");
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      // Never echo vendor bodies: they can include credentials or untrusted commands.
      throw new Error(`Daytona ${method} failed (HTTP ${response.status}).`);
    }
    if (response.status === 204) {
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) { break; }
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Daytona response exceeded its size limit.");
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (!bytes) { return undefined; }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async inspect(runtimeId: string): Promise<DaytonaSandbox | undefined> {
    assertRuntimeId(runtimeId);
    const value = await this.request("GET", `/sandbox/${encodeURIComponent(runtimeId)}`);
    if (value === undefined) { return undefined; }
    return this.admit(value, runtimeId);
  }

  private admit(value: unknown, runtimeId: string): DaytonaSandbox {
    if (!value || typeof value !== "object") { throw new Error("Invalid Daytona sandbox response."); }
    const item = value as Record<string, unknown>;
    const labels = item.labels;
    if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.id) ||
        item.name !== runtimeId || typeof item.state !== "string" ||
        !labels || typeof labels !== "object" || Array.isArray(labels) ||
        (labels as Record<string, unknown>)[OWNER_LABEL] !== runtimeId ||
        (labels as Record<string, unknown>)[CONFIG_LABEL] !== daytonaConfigLabel(this.config)) {
      throw new Error("Daytona sandbox identity/configuration differs from its reserved generation.");
    }
    return { id: item.id, name: runtimeId, state: item.state, labels: labels as Record<string, string> };
  }

  async ensure(runtimeId: string, assertCurrent: () => void): Promise<DaytonaSandbox> {
    assertCurrent();
    const existing = await this.inspect(runtimeId);
    assertCurrent();
    if (existing) {
      if (existing.state !== "started") {
        throw new Error(`Daytona sandbox is ${existing.state}; resume it explicitly before use.`);
      }
      return existing;
    }
    // Core reserves this name durably before POST. An uncertain reply leaves the
    // same reservation retryable; a later GET reconciles it, never a new allocation.
    assertCurrent();
    const created = await this.request("POST", "/sandbox", {
      name: runtimeId,
      snapshot: this.config.snapshot,
      labels: { [OWNER_LABEL]: runtimeId, [CONFIG_LABEL]: daytonaConfigLabel(this.config) },
      public: false,
      autoStopInterval: 15,
      autoDeleteInterval: -1,
    });
    assertCurrent();
    this.admit(created, runtimeId);
    return this.waitFor(runtimeId, (sandbox) => sandbox?.state === "started", assertCurrent)
      .then((sandbox) => {
        if (!sandbox) { throw new Error("Daytona allocation disappeared before readiness."); }
        return sandbox;
      });
  }

  async createSshAccess(runtimeId: string, assertCurrent: () => void): Promise<string> {
    const sandbox = await this.inspect(runtimeId);
    assertCurrent();
    if (!sandbox || sandbox.state !== "started") { throw new Error("Daytona sandbox is unavailable."); }
    const value = await this.request("POST", `/sandbox/${sandbox.id}/ssh-access?expiresInMinutes=60`);
    const token = value && typeof value === "object" ? (value as Record<string, unknown>).token : undefined;
    if (typeof token !== "string" || !/^[a-zA-Z0-9._-]+$/.test(token)) {
      throw new Error("Invalid Daytona SSH access response.");
    }
    try { assertCurrent(); } catch (error) {
      await this.revokeSshAccess(runtimeId, token);
      throw error;
    }
    return token;
  }

  async revokeSshAccess(runtimeId: string, token: string): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.request("DELETE", `/sandbox/${encodeURIComponent(runtimeId)}/ssh-access?token=${encodeURIComponent(token)}`);
  }

  async remove(runtimeId: string): Promise<void> {
    const existing = await this.inspect(runtimeId);
    if (!existing) { return; }
    await this.request("DELETE", `/sandbox/${existing.id}`);
    // Acceptance is not destruction. Unknown outcomes keep core's registry row.
    await this.waitFor(runtimeId, (sandbox) => !sandbox || sandbox.state === "destroyed");
  }

  private async waitFor(runtimeId: string, ready: (sandbox: DaytonaSandbox | undefined) => boolean,
    assertCurrent?: () => void): Promise<DaytonaSandbox | undefined> {
    const deadline = Date.now() + this.config.timeoutMs;
    for (;;) {
      assertCurrent?.();
      const sandbox = await this.inspect(runtimeId);
      assertCurrent?.();
      if (ready(sandbox)) { return sandbox; }
      if (Date.now() >= deadline) { throw new Error("Daytona lifecycle outcome is indeterminate; retry inspection."); }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

function assertRuntimeId(runtimeId: string): void {
  if (!/^openclaw-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runtimeId)) {
    throw new Error("Daytona runtime is not an OpenClaw reserved generation.");
  }
}
