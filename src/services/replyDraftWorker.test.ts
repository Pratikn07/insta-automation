import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const claimOneQueuedDraft = vi.fn();
const loadDraftContext = vi.fn();
const completeGeneration = vi.fn();
const failGeneration = vi.fn();
const expireDueFollowUps = vi.fn();
const generateDmDraft = vi.fn();
const getConnectionStatus = vi.fn();
const logError = vi.fn();

vi.mock("../lib/logger.js", () => ({ logger: { error: logError } }));

vi.mock("./replyDraftService.js", () => ({
  claimOneQueuedDraft,
  loadDraftContext,
  completeGeneration,
  failGeneration,
  expireDueFollowUps,
}));

// The worker uses the env-configured runtime client singleton.
vi.mock("./codexRuntimeClient.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runtimeClient: { generateDmDraft, getConnectionStatus },
  };
});

const aiFlags = { AI_DRAFTS_ENABLED: true };
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(actual.env, {
      get: (t, p) => (p === "AI_DRAFTS_ENABLED" ? aiFlags.AI_DRAFTS_ENABLED : t[p as string]),
    }),
  };
});

const { CodexRuntimeError } = await import("./codexRuntimeClient.js");
const { runReplyDraftTick } = await import("./replyDraftWorker.js");
const { CURRENT_DM_PROMPT_VERSION } = await import("./replyDraftPolicy.js");

const RESET_AT = new Date("2026-08-04T12:00:00.000Z");

const workerDraft = {
  id: "draft-1",
  threadId: "thread-1",
  inboundMessageId: "message-1",
  status: "generating",
  kind: "reply",
  sourceConversationId: null,
  eligibleAt: new Date("2026-08-04T10:00:00.000Z"),
  expiresAt: null,
};

const context = {
  kind: "reply",
  guideDeliveredAt: null,
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "inbound" as const,
      text: "How old before dropping the nap?",
      messageType: "text" as const,
      source: "instagram_user",
      at: "2026-08-04T10:00:00.000Z",
    },
  ],
  guideContext: null,
};

beforeEach(() => {
  for (const fn of [
    claimOneQueuedDraft,
    loadDraftContext,
    completeGeneration,
    failGeneration,
    expireDueFollowUps,
    generateDmDraft,
    getConnectionStatus,
    logError,
  ]) {
    fn.mockReset();
  }
  aiFlags.AI_DRAFTS_ENABLED = true;
  getConnectionStatus.mockResolvedValue({ connected: true, requiresOpenaiAuth: false });
  loadDraftContext.mockResolvedValue(context);
  expireDueFollowUps.mockResolvedValue(0);
  // Two claims then empty, so a tick processing "at most two" terminates.
  claimOneQueuedDraft
    .mockResolvedValueOnce(workerDraft)
    .mockResolvedValueOnce(null);
  generateDmDraft.mockResolvedValue({
    reply: "Most toddlers keep a nap until around 3, Geri 💛",
    rationale: "Answers directly and warmly.",
    confidence: "high",
    warnings: [],
    modelId: "codex-default",
  });
});

describe("runReplyDraftTick", () => {
  it("moves a queued draft through generating to pending approval", async () => {
    await runReplyDraftTick();

    expect(completeGeneration).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        suggestedText: "Most toddlers keep a nap until around 3, Geri 💛",
        workingText: "Most toddlers keep a nap until around 3, Geri 💛",
        rationale: "Answers directly and warmly.",
        confidence: "high",
        warnings: [],
        modelId: "codex-default",
      }),
    );
    expect(failGeneration).not.toHaveBeenCalled();
    expect(generateDmDraft).toHaveBeenCalledWith({
      requestId: expect.any(String),
      kind: "reply",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      guideDeliveredAt: null,
      participant: context.participant,
      messages: context.messages,
      brandVoice: expect.any(String),
      guideContext: null,
    });
  });

  it("sends the exact delivered-guide context for an engagement follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T22:00:00.000Z"));
    const followUpDraft = {
      ...workerDraft,
      kind: "engagement_follow_up",
      sourceConversationId: "conversation-1",
      eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
      expiresAt: new Date("2026-08-06T09:30:00.000Z"),
    };
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(followUpDraft).mockResolvedValueOnce(null);
    loadDraftContext.mockResolvedValue({
      ...context,
      kind: "engagement_follow_up",
      guideDeliveredAt: "2026-08-05T10:00:00.000Z",
      guideContext: {
        keyword: "SLEEP",
        resourceName: "Sleep Guide",
        description: "A practical bedtime guide",
      },
    });

    try {
      await runReplyDraftTick();
    } finally {
      vi.useRealTimers();
    }

    expect(runtimePayload()).toEqual({
      requestId: expect.any(String),
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      guideDeliveredAt: "2026-08-05T10:00:00.000Z",
      participant: context.participant,
      messages: context.messages,
      brandVoice: expect.any(String),
      guideContext: {
        keyword: "SLEEP",
        resourceName: "Sleep Guide",
        description: "A practical bedtime guide",
      },
    });
  });

  it("expires due follow-ups before it claims or requests model work", async () => {
    const order: string[] = [];
    expireDueFollowUps.mockImplementation(async () => {
      order.push("expire");
      return 1;
    });
    getConnectionStatus.mockImplementation(async () => {
      order.push("status");
      return { connected: true, requiresOpenaiAuth: false };
    });
    claimOneQueuedDraft.mockReset().mockImplementation(async () => {
      order.push("claim");
      return null;
    });

    await runReplyDraftTick();

    expect(logError.mock.calls).toEqual([]);
    expect(order).toEqual(["expire", "status", "claim"]);
    expect(generateDmDraft).not.toHaveBeenCalled();
  });

  it("expires a follow-up that elapses after claim without requesting model work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T09:30:00.000Z"));
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce({
      ...workerDraft,
      kind: "engagement_follow_up",
      sourceConversationId: "conversation-1",
      expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    });

    try {
      await runReplyDraftTick();
    } finally {
      vi.useRealTimers();
    }

    expect(expireDueFollowUps).toHaveBeenCalledTimes(2);
    expect(loadDraftContext).not.toHaveBeenCalled();
    expect(generateDmDraft).not.toHaveBeenCalled();
    expect(failGeneration).not.toHaveBeenCalled();
  });

  it("does not request model work when a follow-up expires while context loads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T09:14:00.000Z"));
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce({
      ...workerDraft,
      kind: "engagement_follow_up",
      sourceConversationId: "conversation-1",
      expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    });
    loadDraftContext.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-08-06T09:16:00.000Z"));
      return {
        ...context,
        kind: "engagement_follow_up",
        guideDeliveredAt: "2026-08-05T10:00:00.000Z",
      };
    });

    try {
      await runReplyDraftTick();
    } finally {
      vi.useRealTimers();
    }

    expect(expireDueFollowUps).toHaveBeenCalledTimes(2);
    expect(generateDmDraft).not.toHaveBeenCalled();
    expect(completeGeneration).not.toHaveBeenCalled();
  });

  it("no-ops when AI_DRAFTS_ENABLED is false", async () => {
    aiFlags.AI_DRAFTS_ENABLED = false;
    await runReplyDraftTick();
    expect(claimOneQueuedDraft).not.toHaveBeenCalled();
  });

  it("no-ops when ChatGPT is not connected", async () => {
    getConnectionStatus.mockResolvedValue({ connected: false, requiresOpenaiAuth: true });
    await runReplyDraftTick();
    expect(claimOneQueuedDraft).not.toHaveBeenCalled();
    expect(generateDmDraft).not.toHaveBeenCalled();
  });

  it("records a rate limit without scheduling an automatic retry", async () => {
    generateDmDraft.mockRejectedValue(new CodexRuntimeError("runtime_rate_limited", 429, RESET_AT));
    // Only one due draft this time.
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(workerDraft).mockResolvedValueOnce(null);

    await runReplyDraftTick();

    expect(failGeneration).toHaveBeenCalledWith("draft-1", {
      errorCode: "runtime_rate_limited",
      errorMessage: expect.any(String),
      retryAt: RESET_AT,
    });
    expect(completeGeneration).not.toHaveBeenCalled();
  });

  it("fails generation with a safe category on any runtime error", async () => {
    generateDmDraft.mockRejectedValue(new Error("app-server said token sk-secret is invalid"));
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(workerDraft).mockResolvedValueOnce(null);

    await runReplyDraftTick();

    const [[, payload]] = failGeneration.mock.calls as [[string, { errorMessage: string }]];
    expect(payload.errorMessage).not.toMatch(/sk-secret/);
    expect(completeGeneration).not.toHaveBeenCalled();
  });

  it("processes at most two drafts per tick", async () => {
    claimOneQueuedDraft
      .mockReset()
      .mockResolvedValueOnce({ ...workerDraft, id: "d1" })
      .mockResolvedValueOnce({ ...workerDraft, id: "d2" })
      .mockResolvedValueOnce({ ...workerDraft, id: "d3" });

    await runReplyDraftTick();

    // Stops after two even though a third is available: pacing, not exhaustion.
    expect(claimOneQueuedDraft).toHaveBeenCalledTimes(2);
    expect(generateDmDraft).toHaveBeenCalledTimes(2);
  });

  it("stops early when the queue drains before the cap", async () => {
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(null);
    await runReplyDraftTick();
    expect(generateDmDraft).not.toHaveBeenCalled();
  });

  it("skips a draft whose context vanished (thread deleted mid-flight)", async () => {
    loadDraftContext.mockResolvedValue(null);
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(workerDraft).mockResolvedValueOnce(null);

    await runReplyDraftTick();

    expect(generateDmDraft).not.toHaveBeenCalled();
    expect(failGeneration).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({ errorCode: "context_unavailable" }),
    );
  });

  it("recovers a generating draft when context loading fails without storing private text", async () => {
    loadDraftContext.mockRejectedValue(
      new Error("query failed around DM body: my toddler's private sleep details"),
    );
    claimOneQueuedDraft.mockReset().mockResolvedValueOnce(workerDraft).mockResolvedValueOnce(null);

    await runReplyDraftTick();

    expect(generateDmDraft).not.toHaveBeenCalled();
    expect(failGeneration).toHaveBeenCalledWith("draft-1", {
      errorCode: "context_unavailable",
      errorMessage: "The conversation for this draft is no longer available.",
      retryAt: null,
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain("private sleep details");
  });

  it("never throws, even if claiming fails", async () => {
    claimOneQueuedDraft.mockReset().mockRejectedValue(new Error("database unavailable"));
    await expect(runReplyDraftTick()).resolves.toBeUndefined();
  });
});

function runtimePayload(): unknown {
  return generateDmDraft.mock.calls[0]?.[0];
}
