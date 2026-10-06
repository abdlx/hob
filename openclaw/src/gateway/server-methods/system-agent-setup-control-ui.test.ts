import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWizardMetadata } from "../../commands/onboard-helpers.js";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { initializeNativeSessionCatalogPreferences } from "../../plugins/native-session-catalog-config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { SetupInferenceDetection } from "../../system-agent/setup-inference-core.js";
import { systemAgentHandlers } from "./system-agent.js";

const braveManifestResult = loadPluginManifest(path.resolve("extensions/brave"));
if (!braveManifestResult.ok) {
  throw new Error(braveManifestResult.error);
}
const braveManifest = braveManifestResult.manifest;

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  exists: false,
  additionalCatalog: false,
  providerCapabilities: false,
  requestedAgentId: undefined as string | undefined,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: createConfigFileSnapshot({
      path: "/tmp/synthetic-onboarding/openclaw.json",
      exists: fixture.exists,
      valid: true,
      raw: null,
      parsed: fixture.config,
      sourceConfig: fixture.config,
      runtimeConfig: fixture.config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    }),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: fixture.providerCapabilities
        ? [
            {
              id: braveManifest.id,
              setup: braveManifest.setup,
              contracts: braveManifest.contracts,
            },
            {
              id: "legacy-model",
              setup: { providers: [{ id: "legacy-model", authMethods: ["api-key"] }] },
            },
            {
              id: "mixed",
              providers: ["mixed-model"],
              setup: {
                providers: [
                  { id: "mixed-model", authMethods: ["api-key"] },
                  { id: "mixed-search", envVars: ["MIXED_SEARCH_API_KEY"] },
                ],
              },
              contracts: { webSearchProviders: ["mixed-search"] },
            },
          ]
        : fixture.additionalCatalog
          ? [
              {
                id: "fixture-catalog",
                setup: {
                  nativeSessionCatalog: { label: "Fixture archive", legacyDefaultEnabled: true },
                },
              },
            ]
          : [],
    }),
  }),
}));
vi.mock("../../plugins/provider-install-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-install-catalog.js")>()),
  resolveProviderInstallCatalogEntries: () => [],
}));
vi.mock("../../system-agent/setup-inference.js", () => ({
  // Replace worker/process discovery only. Actual handler parameters, authored
  // config interpretation and consent decision compose through the public RPC handler.
  detectSetupInference: async (_deps: unknown, agentId?: string) => {
    fixture.requestedAgentId = agentId;
    const { detectSetupInference } = await import("../../system-agent/setup-inference-detect.js");
    return detectSetupInference(
      {
        detectInferenceBackends: async () => [],
      },
      agentId,
    );
  },
}));

describe("selected-agent Gateway detection and native catalog consent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "unwritten",
    "initialized",
    "doctor",
    "onboard",
    "upgrade",
    "authored",
    "additional-catalog",
    "provider-capabilities",
  ] as const)(
    "uses server-owned first-install evidence for %s selected-agent setup",
    async (state) => {
      const authored: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      };
      fixture.exists = state !== "unwritten";
      fixture.additionalCatalog = state === "additional-catalog";
      fixture.providerCapabilities = state === "provider-capabilities";
      fixture.config =
        state === "unwritten"
          ? {}
          : state === "upgrade"
            ? authored
            : initializeNativeSessionCatalogPreferences(authored);
      if (state === "doctor" || state === "onboard") {
        fixture.config = applyWizardMetadata(fixture.config, { command: state, mode: "local" });
      }
      if (state === "authored") {
        fixture.config.plugins!.entries!.codex!.config = { sessionCatalog: { enabled: true } };
      }
      const agentId = state === "unwritten" ? "main" : "research";
      const handler = systemAgentHandlers["openclaw.setup.detect"]!;
      const respond = vi.fn();
      await handler({ params: { agentId }, respond } as Parameters<typeof handler>[0]);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      const detection = respond.mock.calls[0]![1] as SetupInferenceDetection;
      expect(fixture.requestedAgentId).toBe(agentId);
      expect(detection.nativeSessionCatalogPreferenceRequired).toBe(
        state !== "upgrade" && state !== "authored",
      );
      expect(detection.authOptions).toContainEqual(expect.objectContaining({ id: "custom-api-key" }));
      if (fixture.additionalCatalog) {
        expect(detection.nativeSessionCatalogs).toContainEqual(
          expect.objectContaining({ pluginId: "fixture-catalog", label: "Fixture archive" }),
        );
      }
      if (fixture.providerCapabilities) {
        const ids = detection.manualProviders.map((provider) => provider.id);
        expect(ids).toContain("mixed-model-api-key");
        expect(ids).toContain("legacy-model-api-key");
        expect(ids).not.toContain("brave-api-key");
        expect(ids).not.toContain("mixed-search-api-key");
      }
    },
  );
});
