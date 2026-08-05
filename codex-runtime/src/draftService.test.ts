import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppServerClient } from "./appServerClient.js";
import { createDraftService } from "./draftService.js";
import type { DmDraftRequest } from "./schemas.js";

const draftRequest: DmDraftRequest = {
  requestId: "11111111-1111-1111-1111-111111111111",
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "inbound",
      text: "How old should my toddler be before dropping the nap?",
      messageType: "text",
      source: "instagram_user",
      at: "2026-08-04T10:00:00.000Z",
    },
  ],
  brandVoice: "Warm, practical, concise.",
  guideContext: null,
};

const VALID_OUTPUT = JSON.stringify({
  reply: "Most toddlers hold onto a nap until around 3, Geri 💛",
  rationale: "Answers the age question directly and stays warm.",
  confidence: "high",
  warnings: [],
});

/**
 * A fake app-server that plays the happy path: thread/start returns an id,
 * turn/start returns a turn id and then (asynchronously) fires a `turn/completed`
 * notification carrying one agentMessage item. Individual tests override pieces.
 */
function makeAppServer(overrides: {
  agentText?: string;
  turnStatus?: string;
  onTurnStart?: () => void;
  failMethod?: { method: string; error: Error };
} = {}): { client: AppServerClient; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Map<string, (params: unknown) => void>();

  const client: AppServerClient = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (overrides.failMethod?.method === method) throw overrides.failMethod.error;
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        // Fire completion on the next tick, after generate() has registered its
        // notification listener.
        queueMicrotask(() => {
          overrides.onTurnStart?.();
          // Nested under `turn`, matching the real app-server notification
          // pinned in appServerContract.test.ts.
          notificationHandlers.get("turn/completed")?.({
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: overrides.turnStatus ?? "completed",
              items: [{ type: "agentMessage", text: overrides.agentText ?? VALID_OUTPUT }],
            },
          });
        });
        return { turn: { id: "turn-1" } };
      }
      if (method === "thread/delete") return null;
      return null;
    }),
    notify: vi.fn(),
    onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
      notificationHandlers.set(method, handler);
      return () => notificationHandlers.delete(method);
    }),
    onRequest: vi.fn(() => () => undefined),
    stop: vi.fn(async () => undefined),
  };
  return { client, calls };
}

let appServer: ReturnType<typeof makeAppServer>;

beforeEach(() => {
  appServer = makeAppServer();
});

describe("createDraftService", () => {
  it("starts an ephemeral thread with no tools or writable workspace", async () => {
    const service = createDraftService(appServer.client);
    await service.generate(draftRequest);

    expect(appServer.client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        runtimeWorkspaceRoots: [],
        environments: [],
        dynamicTools: null,
      }),
      30_000,
    );
  });

  it("marks the DM transcript as untrusted additional context", async () => {
    const service = createDraftService(appServer.client);
    await service.generate(draftRequest);

    expect(appServer.client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        additionalContext: expect.objectContaining({
          dm_transcript: { kind: "untrusted", value: expect.any(String) },
          brand_context: { kind: "application", value: expect.any(String) },
        }),
      }),
      90_000,
    );
  });

  it("never registers an item/tool/call handler for the draft thread", async () => {
    const service = createDraftService(appServer.client);
    await service.generate(draftRequest);
    expect(appServer.client.onRequest).not.toHaveBeenCalled();
  });

  it("returns the validated suggestion on a completed turn", async () => {
    const service = createDraftService(appServer.client);
    await expect(service.generate(draftRequest)).resolves.toMatchObject({
      reply: "Most toddlers hold onto a nap until around 3, Geri 💛",
      confidence: "high",
      warnings: [],
    });
  });

  it("carries the participant's DM text into the transcript", async () => {
    const service = createDraftService(appServer.client);
    await service.generate(draftRequest);

    const turn = appServer.calls.find((c) => c.method === "turn/start");
    const transcript = (turn?.params as { additionalContext: { dm_transcript: { value: string } } })
      .additionalContext.dm_transcript.value;
    expect(transcript).toContain("How old should my toddler be before dropping the nap?");
    expect(transcript).toContain("THEM:");
  });

  it("deletes the ephemeral thread after a successful generation", async () => {
    const service = createDraftService(appServer.client);
    await service.generate(draftRequest);
    expect(appServer.client.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "thread-1" },
      30_000,
    );
  });

  it("deletes the ephemeral thread after malformed output", async () => {
    appServer = makeAppServer({ agentText: "not json" });
    const service = createDraftService(appServer.client);

    await expect(service.generate(draftRequest)).rejects.toThrow("invalid_draft_output");
    expect(appServer.client.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "thread-1" },
      30_000,
    );
  });

  it("rejects output that fails schema validation (reply too long)", async () => {
    const tooLong = JSON.stringify({
      reply: "x".repeat(1001),
      rationale: "r",
      confidence: "high",
      warnings: [],
    });
    appServer = makeAppServer({ agentText: tooLong });
    const service = createDraftService(appServer.client);

    await expect(service.generate(draftRequest)).rejects.toThrow("invalid_draft_output");
  });

  it("rejects a turn that did not complete", async () => {
    appServer = makeAppServer({ turnStatus: "failed" });
    const service = createDraftService(appServer.client);

    await expect(service.generate(draftRequest)).rejects.toThrow("turn_incomplete");
    // The thread is still torn down even on a bad turn.
    expect(appServer.client.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "thread-1" },
      30_000,
    );
  });

  it("deletes the thread even when the turn itself throws", async () => {
    appServer = makeAppServer({
      failMethod: { method: "turn/start", error: new Error("app-server usage limit reached") },
    });
    const service = createDraftService(appServer.client);

    await expect(service.generate(draftRequest)).rejects.toThrow();
    expect(appServer.client.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "thread-1" },
      30_000,
    );
  });
});
