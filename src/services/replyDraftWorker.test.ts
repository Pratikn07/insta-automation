import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const claimOneQueuedDraft = vi.fn();
const loadDraftContext = vi.fn();
const completeGeneration = vi.fn();
const failGeneration = vi.fn();
const generateDmDraft = vi.fn();
const getConnectionStatus = vi.fn();

vi.mock("./replyDraftService.js", () => ({
  claimOneQueuedDraft,
  loadDraftContext,
  completeGeneration,
  failGeneration,
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

const RESET_AT = new Date("2026-08-04T12:00:00.000Z");

const workerDraft = {
  id: "draft-1",
  threadId: "thread-1",
  inboundMessageId: "message-1",
  status: "generating",
};

const context = {
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
    generateDmDraft,
    getConnectionStatus,
  ]) {
    fn.mockReset();
  }
  aiFlags.AI_DRAFTS_ENABLED = true;
  getConnectionStatus.mockResolvedValue({ connected: true, requiresOpenaiAuth: false });
  loadDraftContext.mockResolvedValue(context);
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

  it("never throws, even if claiming fails", async () => {
    claimOneQueuedDraft.mockReset().mockRejectedValue(new Error("database unavailable"));
    await expect(runReplyDraftTick()).resolves.toBeUndefined();
  });
});
