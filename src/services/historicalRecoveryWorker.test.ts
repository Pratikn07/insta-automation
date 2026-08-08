import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const listDueCandidateIds = vi.fn();
const claimCandidate = vi.fn();
const reconcileExpiredCandidateLeases = vi.fn();
const releaseCandidateClaim = vi.fn();
const markCandidateSent = vi.fn();
const markCandidateSuppressed = vi.fn();
const markCandidateFailed = vi.fn();
const markCandidateUncertain = vi.fn();
const countCandidatesSentSince = vi.fn();
const replyToComment = vi.fn();
const fetchComment = vi.fn();
const evaluateRecoveryHealth = vi.fn();
const openRecoveryCircuit = vi.fn();
const logEvent = vi.fn();
const SAFE_UNKNOWN = { category: "unknown_error", httpStatus: null, graphCode: null, graphSubcode: null, traceId: null };
const describeGraphError = vi.fn(() => SAFE_UNKNOWN);
const classifyPublicReplyFailure = vi.fn();
const campaignFindUnique = vi.fn();
const igUserFindUnique = vi.fn();
const dmMessageCount = vi.fn();
const conversationCount = vi.fn();
const reminderCount = vi.fn();

vi.mock("./historicalRecoveryRepository.js", () => ({
  listDueCandidateIds,
  claimCandidate,
  reconcileExpiredCandidateLeases,
  releaseCandidateClaim,
  markCandidateSent,
  markCandidateSuppressed,
  markCandidateFailed,
  markCandidateUncertain,
  countCandidatesSentSince,
}));
vi.mock("../meta/replyToComment.js", () => ({ replyToComment }));
vi.mock("../meta/fetchComment.js", () => ({ fetchComment }));
vi.mock("./dmRecoveryHealth.js", () => ({ evaluateRecoveryHealth, openRecoveryCircuit }));
vi.mock("./eventLogger.js", () => ({ logEvent, describeGraphError }));
vi.mock("./graphErrorClassifier.js", () => ({ classifyPublicReplyFailure }));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCampaign: { findUnique: campaignFindUnique },
    igUser: { findUnique: igUserFindUnique },
    dmMessage: { count: dmMessageCount },
    conversation: { count: conversationCount },
    dmRecoveryReminder: { count: reminderCount },
  },
}));

const flags = { DM_RECOVERY_ENABLED: true, DM_RECOVERY_WESTERN_ONLY: true };
vi.mock("../config/env.js", () => ({
  env: new Proxy(
    {
      DM_RECOVERY_BATCH_SIZE: 2,
      DM_RECOVERY_LEASE_MS: 60_000,
    } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop === "DM_RECOVERY_ENABLED") return flags.DM_RECOVERY_ENABLED;
        if (prop === "DM_RECOVERY_WESTERN_ONLY") return flags.DM_RECOVERY_WESTERN_ONLY;
        return target[prop as string];
      },
    },
  ),
}));

const { runHistoricalRecoveryTick } = await import("./historicalRecoveryWorker.js");

const CANDIDATE = {
  id: "cand-1",
  campaignId: "camp-1",
  igUserId: "person-1",
  commentId: "18111572197955347",
  publicReplyText: "I don't think my DM reached you",
  keywordSnapshot: "SLEEP",
  evidence: "gate_sent_no_read",
  arm: "treatment",
  audienceOrigin: "us_western",
};

beforeEach(() => {
  for (const fn of [
    listDueCandidateIds, claimCandidate, reconcileExpiredCandidateLeases,
    releaseCandidateClaim, markCandidateSent, markCandidateSuppressed,
    markCandidateFailed, markCandidateUncertain, countCandidatesSentSince,
    replyToComment, fetchComment, evaluateRecoveryHealth, openRecoveryCircuit,
    logEvent, describeGraphError, classifyPublicReplyFailure,
    campaignFindUnique, igUserFindUnique, dmMessageCount, conversationCount, reminderCount,
  ]) {
    fn.mockReset();
  }
  flags.DM_RECOVERY_ENABLED = true;
  flags.DM_RECOVERY_WESTERN_ONLY = true;
  describeGraphError.mockReturnValue(SAFE_UNKNOWN);
  reconcileExpiredCandidateLeases.mockResolvedValue(0);
  evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: false });
  listDueCandidateIds.mockResolvedValue(["cand-1"]);
  claimCandidate.mockResolvedValue(CANDIDATE);
  campaignFindUnique.mockResolvedValue({ state: "running", hourlyCap: 3 });
  igUserFindUnique.mockResolvedValue({ inferredOrigin: "us_western" });
  dmMessageCount.mockResolvedValue(0);
  conversationCount.mockResolvedValue(0);
  reminderCount.mockResolvedValue(0);
  countCandidatesSentSince.mockResolvedValue(0);
  fetchComment.mockResolvedValue({ id: CANDIDATE.commentId, hidden: false, timestamp: null });
  replyToComment.mockResolvedValue({ replyId: "17900000000000000" });
  markCandidateSent.mockResolvedValue(true);
  markCandidateSuppressed.mockResolvedValue(true);
  markCandidateFailed.mockResolvedValue(true);
  markCandidateUncertain.mockResolvedValue(true);
  logEvent.mockResolvedValue(undefined);
});

describe("runHistoricalRecoveryTick — the send path", () => {
  it("posts the frozen copy and records Meta's reply id", async () => {
    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).toHaveBeenCalledWith(CANDIDATE.commentId, CANDIDATE.publicReplyText);
    expect(markCandidateSent).toHaveBeenCalledWith("cand-1", {
      publicReplyId: "17900000000000000",
      sentAt: expect.any(Date),
    });
    expect(result.sent).toBe(1);
  });
});

describe("runHistoricalRecoveryTick — the stop switches", () => {
  // One flag stops ALL public sending. This is the rollback the plan depends on.
  it("sends nothing when DM_RECOVERY_ENABLED is false", async () => {
    flags.DM_RECOVERY_ENABLED = false;

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("disabled");
    expect(claimCandidate).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
  });

  // Shared with the prospective path: an auth failure or webhook gap must stop both.
  it("sends nothing while the circuit is open", async () => {
    evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: true });

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("circuit_open");
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("stops the batch when the campaign is paused", async () => {
    campaignFindUnique.mockResolvedValue({ state: "paused", hourlyCap: 3 });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1");
    expect(result.skipped).toBe("campaign_not_running");
  });
});

describe("runHistoricalRecoveryTick — pre-send recheck", () => {
  // Measured: 1 of 3 sampled 44-day-old comments was already deleted.
  it("suppresses rather than posting when the comment is gone", async () => {
    fetchComment.mockRejectedValue(new Error("Unsupported get request"));

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "source_comment_deleted");
    expect(result.suppressed).toBe(1);
  });

  // Worse than deletion: a reply to a hidden comment SUCCEEDS, so it would count as
  // a send while nobody ever saw it.
  it("suppresses a hidden comment", async () => {
    fetchComment.mockResolvedValue({ id: CANDIDATE.commentId, hidden: true, timestamp: null });

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "source_comment_hidden");
  });

  it("suppresses when the person replied after selection", async () => {
    dmMessageCount.mockResolvedValue(1);

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "replied_since_selection");
  });

  it("suppresses when another recovery already reached them", async () => {
    reminderCount.mockResolvedValue(1);

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "contacted_since_selection");
  });

  // The verdict is read LIVE, not from the snapshot: it is retired when the name it
  // came from changes, so an in-market selection can read out-of-market now.
  it("suppresses on the live origin verdict, not the snapshot", async () => {
    igUserFindUnique.mockResolvedValue({ inferredOrigin: "south_asian" });

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "audience_out_of_market");
  });

  it("defers rather than burning the row at the hourly cap", async () => {
    countCandidatesSentSince.mockResolvedValue(3);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1");
    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });
});

describe("runHistoricalRecoveryTick — failure handling", () => {
  it("opens the circuit and stops on an auth failure", async () => {
    replyToComment.mockRejectedValue(new Error("bad token"));
    classifyPublicReplyFailure.mockReturnValue("open_circuit");

    const result = await runHistoricalRecoveryTick();

    expect(openRecoveryCircuit).toHaveBeenCalled();
    expect(markCandidateFailed).toHaveBeenCalledWith("cand-1", "auth_or_permission");
    expect(result.failed).toBe(1);
  });

  it("records a permanent rejection with its graph code", async () => {
    replyToComment.mockRejectedValue(new Error("nope"));
    describeGraphError.mockReturnValue({ ...SAFE_UNKNOWN, graphCode: 190 });
    classifyPublicReplyFailure.mockReturnValue("permanent");

    const result = await runHistoricalRecoveryTick();

    expect(markCandidateFailed).toHaveBeenCalledWith("cand-1", "code_190");
    expect(result.failed).toBe(1);
  });

  // The comment may have posted. Retrying would risk a SECOND public comment, so an
  // uncertain send is parked for a human and never retried.
  it("parks an ambiguous transport failure as uncertain", async () => {
    replyToComment.mockRejectedValue(new Error("socket hang up"));
    classifyPublicReplyFailure.mockReturnValue("unknown");

    const result = await runHistoricalRecoveryTick();

    expect(markCandidateUncertain).toHaveBeenCalledWith("cand-1", "unknown_error");
    expect(markCandidateFailed).not.toHaveBeenCalled();
    expect(result.uncertain).toBe(1);
  });

  it("releases a retryable failure for a later tick", async () => {
    replyToComment.mockRejectedValue(new Error("rate limited"));
    classifyPublicReplyFailure.mockReturnValue("safe_retry");

    const result = await runHistoricalRecoveryTick();

    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1");
    expect(markCandidateFailed).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });

  // Meta accepted the post but returned no id, so there is no evidence it landed —
  // and the sent-requires-reply-id constraint would reject it anyway.
  it("treats a missing reply id as uncertain, not sent", async () => {
    replyToComment.mockResolvedValue({ replyId: null });

    const result = await runHistoricalRecoveryTick();

    expect(markCandidateSent).not.toHaveBeenCalled();
    expect(markCandidateUncertain).toHaveBeenCalledWith("cand-1", "missing_reply_id");
    expect(result.uncertain).toBe(1);
  });

  it("never lets a tick failure escape", async () => {
    listDueCandidateIds.mockRejectedValue(new Error("database down"));

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("tick_failed");
    expect(result.sent).toBe(0);
  });
});

describe("runHistoricalRecoveryTick — claims and leases", () => {
  it("parks leases that expired mid-send", async () => {
    reconcileExpiredCandidateLeases.mockResolvedValue(2);

    await runHistoricalRecoveryTick();

    const kinds = logEvent.mock.calls.map(([kind]) => kind);
    expect(kinds).toContain("historical_recovery_stale_leases");
  });

  it("skips a candidate another worker claimed first", async () => {
    claimCandidate.mockResolvedValue(null);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.examined).toBe(1);
  });

  // The over-fetch exists so a suppressed row does not consume a send slot; the cap
  // has to be applied in the loop or that headroom becomes extra public comments.
  it("stops at the batch size even when more rows are due", async () => {
    listDueCandidateIds.mockResolvedValue(["a", "b", "c", "d", "e", "f"]);
    claimCandidate.mockImplementation(async (id: string) => ({ ...CANDIDATE, id }));

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(2);
    expect(replyToComment).toHaveBeenCalledTimes(2);
  });

  it("records the arm and evidence on a confirmed send", async () => {
    await runHistoricalRecoveryTick();

    const sent = logEvent.mock.calls.find(([kind]) => kind === "historical_recovery_sent");
    expect(sent?.[1]).toMatchObject({
      arm: "treatment",
      evidence: "gate_sent_no_read",
      publicReplyId: "17900000000000000",
    });
  });
});
