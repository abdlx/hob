import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionModelSelectionInternal as applySessionModelSelection } from "../model-picker/apply-session-model-selection.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

it("publishes a persisted profile-only selection through the Gateway lifecycle broadcaster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    // The picker supplies prepared capabilities; omission would start unrelated catalog discovery.
    const model = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Model",
      reasoning: false,
    };
    const sessionKey = "agent:main:profile";
    const otherKey = "agent:main:other";
    const entry = {
      sessionId: "profile-session",
      updatedAt: 1,
      providerOverride: model.provider,
      modelOverride: model.id,
      modelOverrideSource: "user" as const,
      modelOverrideRouteResolution: "resolved" as const,
      authProfileOverride: "anthropic:missing",
      authProfileOverrideSource: "user" as const,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: otherKey },
      { ...entry, sessionId: "other-session" },
    );
    const rowProjection = await createSessionRowProjection({ cfg: getRuntimeConfig() });
    const publications: Promise<void>[] = [];
    const broadcast = vi.fn();
    const publishLifecycle = createLifecycleEventBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      sessionEventSubscribers: { getAll: () => new Set(["reader"]) },
      chatAbortControllers: new Map(),
      broadcastToConnIds: broadcast,
    });
    const unsubscribe = onSessionLifecycleEvent((event) => {
      publications.push(publishLifecycle(event));
    });
    try {
      await expect(
        applySessionModelSelection({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          currentProvider: model.provider,
          currentModel: model.id,
          defaultProvider: model.provider,
          defaultModel: model.id,
          modelCatalog: [model],
          canPersistStickyModelSelection: false,
          markLiveSwitchPending: true,
          request: {
            provider: model.provider,
            model: model.id,
            isDefault: false,
            profileOverride: "anthropic:restored",
            runtime: { kind: "unchanged" },
          },
        }),
      ).resolves.toMatchObject({ status: "applied", changed: true });
      await Promise.all(publications);
      expect(loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" }).entry).toMatchObject({
        authProfileOverride: "anthropic:restored",
      });
      expect(loadGatewaySessionEntryReadOnly(otherKey, { agentId: "main" }).entry).toMatchObject({
        authProfileOverride: "anthropic:missing",
      });
      expect(broadcast).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey, agentId: "main" }),
        new Set(["reader"]),
        expect.anything(),
      );
      expect(broadcast.mock.calls.every(([, payload]) => payload.sessionKey === sessionKey)).toBe(true);
    } finally {
      unsubscribe();
      try {
        await Promise.all(publications);
      } finally {
        rowProjection.dispose();
      }
    }
  });
});
