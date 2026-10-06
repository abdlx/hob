import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import { getReplyFromConfig } from "../../auto-reply/reply/get-reply.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { settleWorkspaceRuns } from "../server.sessions.create.projects.test-support.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import type { GatewayClient } from "./types.js";

const fixedNow = vi.hoisted(() => 1_800_000_000_000);

vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  // The same-version claim regression needs one clock across the host and real workers.
  const preload = `Date.now = () => ${fixedNow};`;
  return {
    ...actual,
    createCpuTrackedWorker(...args: Parameters<typeof actual.createCpuTrackedWorker>) {
      const [filename, options] = args;
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
      });
    },
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const client: GatewayClient = {
  connId: "created-thinking-proof",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  },
};

test.each(["later-read", "delivered-event", "rpc-patch"])(
  "uses the real initial thinking directive after its created claim at the same timestamp (%s)",
  async (mode) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { model: { primary: "openai/gpt-5.5" } };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", reasoning: true },
    ];
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const subscribers = new Set<string>();
    const deliveredEvents: Array<{ event: string; payload: unknown }> = [];
    const context = createDirectChatContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => subscribers,
      broadcastToConnIds: (event, payload) => {
        deliveredEvents.push({ event, payload });
      },
    });
    const replyEntered = createDeferred();
    const releaseReply = createDeferred();
    const replyFinished = createDeferred();
    const releaseFirstList = createDeferred();
    const firstListRead = createDeferred();
    const failures: unknown[] = [];
    const order: string[] = [];
    const key = "agent:main:dashboard:created-thinking-proof";
    const scope = { agentId: "main", sessionKey: key, storePath };
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const runModel = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockRejectedValue(new Error("pure thinking directive must not invoke a model"));
    dispatchInboundMessageMock.mockReset();
    gatewayReplyMock.mockImplementation(async (...args) => {
      replyEntered.resolve(undefined);
      await releaseReply.promise;
      try {
        const result = await getReplyFromConfig(...args);
        order.push("directive-complete");
        return result;
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        replyFinished.resolve(undefined);
      }
    });
    let listCalls = 0;
    let creationReturned = false;
    type SessionRow = { key: string; sessionId: string; thinkingLevel: string; updatedAt: number };
    type SessionsList = { sessions: SessionRow[] };
    type Created = { key: string; initialRun: { status: string }; entry: SessionRow };
    const request = async <T>(
      method: "sessions.create" | "sessions.list" | "sessions.patch",
      params: Record<string, unknown>,
    ): Promise<T> => {
      const response = await directSessionReq<T>(method, params, {
        context: { ...context },
        client,
        isWebchatConnect: () => true,
      });
      if (!response.ok) {
        throw new Error(response.error?.message ?? `${method} failed`);
      }
      if (method === "sessions.create") {
        order.push("create-ack");
        creationReturned = true;
      }
      if (method === "sessions.list" && creationReturned) {
        listCalls += 1;
        order.push(`list-${listCalls}-read`);
        if (listCalls === 1) {
          firstListRead.resolve(undefined);
          await releaseFirstList.promise;
        }
      }
      return response.payload as T;
    };
    try {
      await initializeSessionReadContext(context);
      const initial = await request<SessionsList>("sessions.list", {});
      expect(initial.sessions.some((row) => row.key === key)).toBe(false);
      const created = await withTimeout(
        request<Created>("sessions.create", {
          key,
          agentId: "main",
          model: "openai/gpt-5.5",
          thinkingLevel: "high",
          message: "/think low",
        }),
        15_000,
        "created-claim create response",
      );
      expect(created).toMatchObject({
        key,
        initialRun: { status: "started" },
        entry: { thinkingLevel: "high", updatedAt: Date.now() },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        thinkingLevel: "high",
        updatedAt: Date.now(),
      });
      const staleList = request<SessionsList>("sessions.list", {});
      await withTimeout(replyEntered.promise, 15_000, "created-claim reply admission");
      await withTimeout(firstListRead.promise, 15_000, "created-claim first list");
      releaseReply.resolve(undefined);
      await withTimeout(replyFinished.promise, 15_000, "created-claim directive completion");
      await settleWorkspaceRuns(context, storePath, key);
      expect(failures).toEqual([]);
      expect(runModel).not.toHaveBeenCalled();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: created?.entry?.sessionId,
        thinkingLevel: "low",
        updatedAt: created?.entry?.updatedAt,
      });
      expect(deliveredEvents.filter(({ event }) => event === "sessions.changed")).toEqual([]);
      if (mode === "delivered-event") {
        subscribers.add("created-thinking-proof");
        const changed = await directSessionReq(
          "sessions.patch",
          { key, agentId: "main", thinkingLevel: "low" },
          { context: { ...context }, client, isWebchatConnect: () => true },
        );
        expect(changed.ok).toBe(true);
        await flushPendingSessionsChangedEvents();
        expect(deliveredEvents).toContainEqual({
          event: "sessions.changed",
          payload: expect.objectContaining({
            sessionKey: key,
            sessionId: created?.entry?.sessionId,
            agentId: "main",
            thinkingLevel: "low",
            updatedAt: created?.entry?.updatedAt,
          }),
        });
      } else if (mode === "rpc-patch") {
        await request("sessions.patch", { key, agentId: "main", thinkingLevel: "low" });
      }
      releaseFirstList.resolve(undefined);
      expect((await staleList).sessions.find((row) => row.key === key)?.thinkingLevel).toBe("high");
      const latest = await request<SessionsList>("sessions.list", {});
      const row = latest.sessions.find((entry) => entry.key === key);
      expect(row).toMatchObject({
        sessionId: created?.entry?.sessionId,
        thinkingLevel: "low",
        updatedAt: created?.entry?.updatedAt,
      });
      expect(order).toEqual(["create-ack", "list-1-read", "directive-complete", "list-2-read"]);
    } finally {
      releaseReply.resolve(undefined);
      releaseFirstList.resolve(undefined);
      try {
        await settleWorkspaceRuns(context, storePath, key, true);
      } finally {
        gatewayReplyMock.mockReset();
        runModel.mockRestore();
        clock.mockRestore();
      }
    }
  },
);
