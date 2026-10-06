import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  createRemoteShellSandboxBackend,
  createRemoteShellSandboxSession,
  createSshSandboxSessionFromConfigText,
  disposeSshSandboxSession,
  getSandboxBackendWorkdirResolver,
  sanitizeEnvVars,
  type CreateSandboxBackendParams,
  type SandboxBackendRegistration,
} from "openclaw/plugin-sdk/sandbox";
import { DaytonaClient, daytonaConfigLabel } from "./client.js";
import { resolveDaytonaConfig, type DaytonaConfig } from "./config.js";

export function createDaytonaRegistration(config: DaytonaConfig): SandboxBackendRegistration {
  const client = new DaytonaClient(config);
  const remoteParams = (params: CreateSandboxBackendParams) => ({
    ...params,
    cfg: { ...params.cfg, ssh: { ...params.cfg.ssh, workspaceRoot: config.workspaceRoot } },
  });
  return {
    reserveRuntimeId: () => `openclaw-${randomUUID()}`,
    // Reuse SSH's path owner; no second hashing/path mapping algorithm.
    resolveWorkdir: (params) => {
      const resolver = getSandboxBackendWorkdirResolver("ssh");
      if (!resolver) { throw new Error("Daytona requires the built-in SSH workdir resolver."); }
      return resolver(remoteParams(params));
    },
    factory: async (params) => {
      // Refuse unsupported confinement before any potentially billable allocation.
      if ((params.cfg.docker.binds?.length ?? 0) || (params.readOnlyResourceMounts?.length ?? 0)) {
        throw new Error("Daytona does not support host binds or read-only resource mounts.");
      }
      if (params.cfg.browser.enabled) {
        throw new Error("Daytona does not provide OpenClaw's browser sandbox capability.");
      }
      const pinned = await fs.lstat(config.knownHostsFile);
      if (!pinned.isFile() || pinned.isSymbolicLink()) {
        throw new Error("Daytona requires a regular pinned SSH known-hosts file.");
      }
      params.assertRuntimeCurrent();
      await client.ensure(params.runtimeId, params.assertRuntimeCurrent);
      params.assertRuntimeCurrent();
      return createRemoteShellSandboxBackend(remoteParams(params), {
        backendId: "daytona",
        runtimeId: params.runtimeId,
        configLabel: daytonaConfigLabel(config),
        configLabelKind: "Daytona configuration",
        createSession: async () => {
          params.assertRuntimeCurrent();
          const token = await client.createSshAccess(params.runtimeId, params.assertRuntimeCurrent);
          let disposed = false;
          let ssh: Awaited<ReturnType<typeof createSshSandboxSessionFromConfigText>>;
          try {
            ssh = await createSshSandboxSessionFromConfigText({
              host: "openclaw-daytona",
              configText: [
                "Host openclaw-daytona",
                "  HostName ssh.app.daytona.io",
                `  User ${token}`,
                "  Port 22",
                "  BatchMode yes",
                "  StrictHostKeyChecking yes",
                `  UserKnownHostsFile "${config.knownHostsFile.replace(/\\/g, "/")}"`,
                "  GlobalKnownHostsFile none",
                "  IdentitiesOnly yes",
                "  IdentityFile none",
                "  LogLevel ERROR",
                "  ConnectTimeout 30",
                "  ServerAliveInterval 15",
                "  ServerAliveCountMax 2",
                "",
              ].join("\n"),
            });
          } catch (error) {
            await client.revokeSshAccess(params.runtimeId, token);
            throw error;
          }
          const dispose = async () => {
            if (disposed) { return; }
            // Exact token revocation and temp-file disposal are retained cleanup,
            // never a new arbitrary command after the runtime authority closes.
            disposed = true;
            try { await client.revokeSshAccess(params.runtimeId, token); }
            finally { await disposeSshSandboxSession(ssh); }
          };
          try { params.assertRuntimeCurrent(); } catch (error) {
            await dispose();
            throw error;
          }
          return createRemoteShellSandboxSession({
            assertCurrent: () => {
              if (disposed) { throw new Error("Daytona SSH session has closed."); }
              params.assertRuntimeCurrent();
            },
            buildCommand: ({ remoteCommand, tty }) => ({
              argv: [ssh.command, "-F", ssh.configPath, tty ? "-tt" : "-T", ssh.host, remoteCommand],
              env: sanitizeEnvVars(process.env).allowed,
            }),
            formatFailure: (stderr, code) => stderr.split(token).join("[redacted]").trim() || `Daytona SSH exited with code ${code}`,
            dispose,
          });
        },
      });
    },
    manager: {
      async describeRuntime({ entry, config: runtimeConfig }) {
        const current = resolveDaytonaConfig(runtimeConfig.plugins?.entries?.daytona?.config);
        const sandbox = await new DaytonaClient(current).inspect(entry.containerName);
        return {
          running: sandbox?.state === "started",
          actualConfigLabel: daytonaConfigLabel(current),
          configLabelMatch: entry.image === daytonaConfigLabel(current),
        };
      },
      async removeRuntime({ entry, config: runtimeConfig }) {
        const current = resolveDaytonaConfig(runtimeConfig.plugins?.entries?.daytona?.config);
        await new DaytonaClient(current).remove(entry.containerName);
      },
    },
  };
}
