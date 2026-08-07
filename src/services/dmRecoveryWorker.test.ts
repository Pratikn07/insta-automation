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

vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { updateMany, count },
  },
}));

vi.mock("../config/env.js", () => ({
  env: {
    LOG_LEVEL: "info",
    DM_RECOVERY_ENABLED: true,
    DM_RECOVERY_BATCH_SIZE: 5,
    DM_RECOVERY_LEASE_MS: 900000,
    DM_RECOVERY_RETRY_BASE_MS: 300000,
    DM_RECOVERY_MAX_ATTEMPTS: 3,
  },
}));

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

  it("stops and returns circuit_open when health check fails", async () => {
    evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: true, reason: "hourly_cap" });

    const res = await runDmRecoveryTick();

    expect(res).toEqual({
      examined: 0,
      sent: 0,
      suppressed: 0,
      failed: 0,
      uncertain: 0,
      skipped: "circuit_open",
    });
    expect(listDueRecoveryIds).not.toHaveBeenCalled();
  });
});
