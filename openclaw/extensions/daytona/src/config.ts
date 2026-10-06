import path from "node:path";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export type DaytonaConfig = {
  apiKey: string;
  snapshot: string;
  knownHostsFile: string;
  workspaceRoot: string;
  timeoutMs: number;
};

/** SecretRefs are hydrated by the host's manifest-owned secret contract. */
export function resolveDaytonaConfig(value: unknown): DaytonaConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Daytona requires apiKey, snapshot and a pinned knownHostsFile.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["apiKey", "snapshot", "knownHostsFile", "workspaceRoot", "timeoutSeconds"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Unknown Daytona configuration field.");
  }
  const apiKey = normalizeResolvedSecretInputString({
    value: record.apiKey,
    path: "plugins.entries.daytona.config.apiKey",
  });
  const stringField = (name: string) => {
    const field = record[name];
    if (typeof field !== "string" || !field.trim() || /[\0\r\n"]/.test(field)) {
      throw new Error(`Daytona ${name} must be a nonempty single-line string.`);
    }
    return field.trim();
  };
  if (!apiKey || /[\r\n\0]/.test(apiKey)) {
    throw new Error("Daytona apiKey must be resolved before sandbox admission.");
  }
  const snapshot = stringField("snapshot");
  const knownHostsFile = stringField("knownHostsFile");
  if (!path.isAbsolute(knownHostsFile)) {
    throw new Error("Daytona knownHostsFile must be an absolute path to pinned SSH host keys.");
  }
  const workspaceRoot = record.workspaceRoot === undefined
    ? "/home/daytona/.openclaw"
    : stringField("workspaceRoot");
  if (!workspaceRoot.startsWith("/") || workspaceRoot === "/" ||
      path.posix.normalize(workspaceRoot) !== workspaceRoot || workspaceRoot.endsWith("/")) {
    throw new Error("Daytona workspaceRoot must be a normalized absolute non-root path.");
  }
  const seconds = record.timeoutSeconds ?? 120;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error("Daytona timeoutSeconds must be an integer between 1 and 900.");
  }
  return { apiKey, snapshot, knownHostsFile, workspaceRoot, timeoutMs: seconds * 1000 };
}
