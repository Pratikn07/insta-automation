import { describe, it, expect, vi, beforeEach } from "vitest";

const listDueRecoveryIds = vi.fn();
const claimRecovery = vi.fn();
const authorizeClaimForSend = vi.fn();
const markRecoverySent = vi.fn();
const markRecoveryRetryable = vi.fn();
const markRecoveryFailed = vi.fn();
const markRecoveryUncertain = vi.fn();
const releaseOrSuppressClaim = vi.fn();
const evaluateRecoveryHealth = vi.fn();
const openRecoveryCircuit = vi.fn();
const replyToComment = vi.fn();
const logEvent = vi.fn();
const updateMany = vi.fn();
const count = vi.fn();

vi.mock("./dmRecoveryRepository.js", () => ({
  listDueRecoveryIds,
  claimRecovery,
  authorizeClaimForSend,
  markRecoverySent,
  markRecoveryRetryable,
  markRecoveryFailed,
  markRecoveryUncertain,
  releaseOrSuppressClaim,
}));

vi.mock("./dmRecoveryHealth.js", () => ({
  evaluateRecoveryHealth,
  openRecoveryCircuit,
}));

vi.mock("../meta/replyToComment.js", () => ({
  replyToComment,
}));

vi.mock("./eventLogger.js", async (importOriginal) => {
  // The worker imports describeGraphError as well. Mocking only logEvent made
  // every error path throw inside the tick, so none of them could be tested.
  const actual = await importOriginal<typeof import("./eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { updateMany, count },
  },
}));

const envMock = {
  LOG_LEVEL: "info",
  DM_RECOVERY_ENABLED: true,
  DM_RECOVERY_BATCH_SIZE: 5,
  DM_RECOVERY_LEASE_MS: 900000,
  DM_RECOVERY_RETRY_BASE_MS: 300000,
  DM_RECOVERY_MAX_ATTEMPTS: 3,
};

vi.mock("../config/env.js", () => ({ env: envMock }));

const { runDmRecoveryTick } = await import("./dmRecoveryWorker.js");

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    igUserId: "ig-1",
    conversationId: "convo-1",
    keywordId: "kw-1",
    keywordSnapshot: "SLEEP",
    templateVersion: "v1",
    publicReplyText: "I sent your guide 💛 Check your DMs/Requests.",
    commentId: "comment-1",
    triggerKind: "no_confirmed_read",
    status: "sending",
    cohort: "treatment",
    attempts: 1,
    eligibleAt: new Date("2026-08-06T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  listDueRecoveryIds.mockReset();
  claimRecovery.mockReset();
  authorizeClaimForSend.mockReset();
  markRecoverySent.mockReset();
  markRecoveryRetryable.mockReset();
  markRecoveryFailed.mockReset();
  markRecoveryUncertain.mockReset();
  releaseOrSuppressClaim.mockReset();
  evaluateRecoveryHealth.mockReset();
  openRecoveryCircuit.mockReset();
  replyToComment.mockReset();
  logEvent.mockReset();
  updateMany.mockReset();
  count.mockReset();

  updateMany.mockResolvedValue({ count: 0 });
  count.mockResolvedValue(0);
  evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: false });
  // Every finalizer reports whether the durable write happened.
  markRecoverySent.mockResolvedValue(true);
  markRecoveryRetryable.mockResolvedValue(true);
  markRecoveryFailed.mockResolvedValue(true);
  markRecoveryUncertain.mockResolvedValue(true);
  releaseOrSuppressClaim.mockResolvedValue(true);
  envMock.DM_RECOVERY_ENABLED = true;
});

// The scheduler refuses to register the timer when recovery is off, and the
// tick refuses independently. Only the scheduler half was covered, so a
// misregistered worker would have sent public comments with the switch off.
describe("the kill switch", () => {
  it("refuses to do any work when recovery is disabled", async () => {
    envMock.DM_RECOVERY_ENABLED = false;

    await expect(runDmRecoveryTick()).resolves.toMatchObject({ skipped: "disabled" });

    expect(evaluateRecoveryHealth).not.toHaveBeenCalled();
    expect(listDueRecoveryIds).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
  });
});

describe("runDmRecoveryTick", () => {
  it("posts exact snapshotted copy and confirms reply ID on success", async () => {
    listDueRecoveryIds.mockResolvedValue(["rec-1"]);
    claimRecovery.mockResolvedValue(claimedRow());
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
    replyToComment.mockResolvedValue({ replyId: "pub-reply-1" });

    const res = await runDmRecoveryTick();

    expect(replyToComment).toHaveBeenCalledWith(
      "comment-1",
      "I sent your guide 💛 Check your DMs/Requests.",
    );
    expect(markRecoverySent).toHaveBeenCalledWith("rec-1", {
      replyId: "pub-reply-1",
      sentAt: expect.any(Date),
    });
    expect(res).toMatchObject({ examined: 1, sent: 1, failed: 0 });
  });

  // Anything that is not an explicit send decision must not reach Meta. The
  // send branch used to be the fall-through, so any decision the worker did not
  // name — a released stale claim, or any kind added later — posted a public
  // comment.
  it.each([
    ["a released stale claim", { kind: "release", reason: "stale_claim" }],
    ["a holdout", { kind: "holdout" }],
    ["a wait", { kind: "wait" }],
    ["a suppression", { kind: "suppress", reason: "seen" }],
  ])("never posts publicly for %s", async (_label, decision) => {
    listDueRecoveryIds.mockResolvedValue(["rec-1"]);
    claimRecovery.mockResolvedValue(claimedRow());
    authorizeClaimForSend.mockResolvedValue(decision);

    await runDmRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markRecoverySent).not.toHaveBeenCalled();
    expect(releaseOrSuppressClaim).toHaveBeenCalledWith("rec-1", decision, expect.any(Date));
  });

  it("stops and returns circuit_open when health check fails", async () => {
    evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: true, reason: "hourly_cap" });

    const res = await runDmRecoveryTick();

    expect(res).toEqual({
      examined: 0,
      sent: 0,
      suppressed: 0,
      deferred: 0,
      failed: 0,
      uncertain: 0,
      skipped: "circuit_open",
    });
    expect(listDueRecoveryIds).not.toHaveBeenCalled();
  });
});

describe("runDmRecoveryTick pacing and reentrancy", () => {
  it("claims at most one batch from a large backlog", async () => {
    listDueRecoveryIds.mockResolvedValue(["r1", "r2", "r3", "r4", "r5"]);
    claimRecovery.mockImplementation(async (id: string) => claimedRow({ id }));
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
    replyToComment.mockResolvedValue({ replyId: "pub" });

    const res = await runDmRecoveryTick();

    expect(listDueRecoveryIds).toHaveBeenCalledWith(expect.any(Date), 5);
    expect(replyToComment).toHaveBeenCalledTimes(5);
    expect(res.sent).toBe(5);
  });

  // listDueRecoveryIds returns headroom above the batch so a suppressed row does
  // not consume a send slot. Without a cap here that headroom becomes extra
  // public comments — a configured batch of 5 posting up to 15.
  it("never sends more than the configured batch, even with due headroom", async () => {
    listDueRecoveryIds.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => `rec-${i}`),
    );
    claimRecovery.mockImplementation(async (id: string) => claimedRow({ id }));
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
    replyToComment.mockResolvedValue({ replyId: "pub" });

    const res = await runDmRecoveryTick();

    expect(replyToComment).toHaveBeenCalledTimes(5);
    expect(res.sent).toBe(5);
  });

  // A finalizer returning false means the durable write did not happen, so
  // counting the outcome would make the metrics disagree with the table.
  it.each([
    ["a permanent failure", () => graphError(400, 100), () => markRecoveryFailed],
    ["an uncertain outcome", () => graphError(500, 2), () => markRecoveryUncertain],
  ])("does not count %s that failed to persist", async (_l, mkErr, getFn) => {
    listDueRecoveryIds.mockResolvedValue(["rec-1"]);
    claimRecovery.mockResolvedValue(claimedRow());
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
    replyToComment.mockRejectedValue(mkErr());
    getFn().mockResolvedValue(false);

    const res = await runDmRecoveryTick();

    expect(res.failed + res.uncertain).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_finalize_failed",
      expect.anything(),
    );
  });

  it("does not run two ticks concurrently", async () => {
    let openGate!: (ids: string[]) => void;
    const gate = new Promise<string[]>((resolve) => {
      openGate = resolve;
    });
    listDueRecoveryIds.mockReturnValue(gate);

    const first = runDmRecoveryTick();
    const second = await runDmRecoveryTick();
    openGate([]);
    await first; // never leave the running flag set for later tests

    expect(second).toMatchObject({ skipped: "already_running" });
  });

  it("keeps processing later records after one fails", async () => {
    listDueRecoveryIds.mockResolvedValue(["r1", "r2"]);
    claimRecovery.mockImplementation(async (id: string) => claimedRow({ id }));
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
    replyToComment
      .mockRejectedValueOnce(graphError(400, 100))
      .mockResolvedValueOnce({ replyId: "pub-2" });

    const res = await runDmRecoveryTick();

    expect(replyToComment).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ sent: 1, failed: 1 });
  });
});

function graphError(status: number, code: number) {
  const err: any = new Error("graph");
  err.isAxiosError = true;
  err.response = {
    status,
    statusText: "",
    headers: {},
    config: {},
    data: { error: { code, fbtrace_id: "t" } },
  };
  return err;
}

describe("runDmRecoveryTick public outcome matrix", () => {
  beforeEach(() => {
    listDueRecoveryIds.mockResolvedValue(["rec-1"]);
    claimRecovery.mockResolvedValue(claimedRow());
    authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
  });

  it("treats a 2xx without an id as uncertain, never as sent", async () => {
    replyToComment.mockResolvedValue({ replyId: null });
    await runDmRecoveryTick();
    expect(markRecoveryUncertain).toHaveBeenCalledOnce();
    expect(markRecoverySent).not.toHaveBeenCalled();
  });

  it.each([
    ["a deleted comment", () => graphError(400, 100), "markRecoveryFailed"],
    ["a rate limit", () => graphError(429, 4), "markRecoveryRetryable"],
  ])("handles %s with exactly one finalizer", async (_l, mkErr, finalizer) => {
    replyToComment.mockRejectedValue(mkErr());
    await runDmRecoveryTick();

    const all = { markRecoveryFailed, markRecoveryRetryable, markRecoveryUncertain };
    for (const [name, fn] of Object.entries(all)) {
      if (name === finalizer) expect(fn).toHaveBeenCalledOnce();
      else expect(fn).not.toHaveBeenCalled();
    }
  });

  it("opens the circuit and stops the batch on an auth failure", async () => {
    listDueRecoveryIds.mockResolvedValue(["rec-1", "rec-2"]);
    claimRecovery.mockImplementation(async (id: string) => claimedRow({ id }));
    replyToComment.mockRejectedValue(graphError(401, 190));

    await runDmRecoveryTick();

    expect(openRecoveryCircuit).toHaveBeenCalledWith("auth_or_permission", expect.any(Date));
    expect(replyToComment).toHaveBeenCalledOnce();
  });

  // authorizeClaimForSend reserves the attempt durably AFTER claimRecovery has
  // already read the row, so the claimed copy is one behind. Using it for the
  // ceiling grants an extra public send, and for the exponent it halves the
  // first backoff.
  it("stops retrying at the configured attempt ceiling", async () => {
    claimRecovery.mockResolvedValue(claimedRow({ attempts: 2 })); // reserved -> 3 = max
    replyToComment.mockRejectedValue(graphError(429, 4));

    await runDmRecoveryTick();

    expect(markRecoveryFailed).toHaveBeenCalledWith("rec-1", {
      category: "rate_limit_exhausted",
    });
    expect(markRecoveryRetryable).not.toHaveBeenCalled();
  });

  it("never schedules a retry sooner than the configured base delay", async () => {
    claimRecovery.mockResolvedValue(claimedRow({ attempts: 0 })); // reserved -> 1
    replyToComment.mockRejectedValue(graphError(429, 4));

    const before = Date.now();
    await runDmRecoveryTick();

    const { nextAttemptAt } = markRecoveryRetryable.mock.calls[0]![1];
    const delay = nextAttemptAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(300000 * 0.8);
  });

  // Meta already posted. Anything that fails afterwards is bookkeeping, and
  // must never be classified as a send outcome or produce a second attempt.
  it("does not retry when persistence fails after Meta accepted", async () => {
    replyToComment.mockResolvedValue({ replyId: "pub-1" });
    markRecoverySent.mockRejectedValue(new Error("database unavailable"));

    await runDmRecoveryTick();

    expect(replyToComment).toHaveBeenCalledOnce();
    expect(markRecoveryRetryable).not.toHaveBeenCalled();
    expect(markRecoveryFailed).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_finalize_failed",
      expect.objectContaining({ id: "rec-1" }),
    );
  });

  it("does not report a send when the durable write did not happen", async () => {
    replyToComment.mockResolvedValue({ replyId: "pub-1" });
    markRecoverySent.mockResolvedValue(false);

    const res = await runDmRecoveryTick();

    expect(res.sent).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_finalize_failed",
      expect.objectContaining({ stage: "mark_sent" }),
    );
    expect(logEvent).not.toHaveBeenCalledWith("dm_recovery_sent", expect.anything());
  });

  it("emits a suppression event and counts a deferral separately", async () => {
    authorizeClaimForSend.mockResolvedValue({ kind: "suppress", reason: "seen" });
    const suppressed = await runDmRecoveryTick();
    expect(suppressed).toMatchObject({ suppressed: 1, deferred: 0 });
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_suppressed",
      expect.objectContaining({ reason: "seen" }),
    );

    logEvent.mockClear();
    authorizeClaimForSend.mockResolvedValue({ kind: "release", reason: "stale_claim" });
    const deferred = await runDmRecoveryTick();
    expect(deferred).toMatchObject({ suppressed: 0, deferred: 1 });
    expect(logEvent).not.toHaveBeenCalledWith("dm_recovery_suppressed", expect.anything());
  });

  // A reminder posted days late is not the intervention the experiment
  // measures, so the lag has to be visible.
  it("marks a badly delayed send as late", async () => {
    claimRecovery.mockResolvedValue(
      claimedRow({ eligibleAt: new Date(Date.now() - 29 * 60 * 60 * 1000) }),
    );
    replyToComment.mockResolvedValue({ replyId: "pub-1" });

    await runDmRecoveryTick();

    expect(logEvent).toHaveBeenCalledWith("dm_recovery_sent", expect.anything());
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_sent_late",
      expect.objectContaining({ id: "rec-1" }),
    );
  });
});
