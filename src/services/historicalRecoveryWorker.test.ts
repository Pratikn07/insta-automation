import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const listDueCandidateIds = vi.fn();
const claimCandidate = vi.fn();
const reconcileExpiredCandidateLeases = vi.fn();
const releaseCandidateClaim = vi.fn();
const markCandidateSuppressed = vi.fn();
const markCandidateFailed = vi.fn();
const reserveHistoricalDispatch = vi.fn();
const startHistoricalDispatch = vi.fn();
const releaseHistoricalReservation = vi.fn();
const finalizeHistoricalDispatch = vi.fn();
const countCandidatesSentSince = vi.fn();
const acquireHistoricalTick = vi.fn();
const openCampaignBatch = vi.fn();
const finishHistoricalTick = vi.fn();
const replyToComment = vi.fn();
const fetchComment = vi.fn();
const evaluateRecoveryHealth = vi.fn();
const openRecoveryCircuit = vi.fn();
const logEvent = vi.fn();
const SAFE_UNKNOWN = { category: "unknown_error", httpStatus: null, graphCode: null, graphSubcode: null, traceId: null };
const describeGraphError = vi.fn(() => SAFE_UNKNOWN);
const classifyPublicReplyFailure = vi.fn();
const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
// QA-12: completeCampaignIfDrained had no production caller, so a campaign that had sent
// everything stayed `running` forever.
const completeCampaignIfDrained = vi.fn();
const reconcileDrainedCampaigns = vi.fn();
// QA-13: campaign-level stop conditions, which the shared circuit cannot express.
const evaluateCampaignHealth = vi.fn();
const reconcilePendingInboundCampaignHealthSignals = vi.fn();
const reconcileHistoricalRecoveryAttributionSafely = vi.fn();
const igUserFindUnique = vi.fn();
const dmMessageCount = vi.fn();
const conversationCount = vi.fn();
// QA-11: the shared ledger contains BOTH recovery systems' public contacts.
const dispatchCount = vi.fn();

vi.mock("./historicalRecoveryRepository.js", () => ({
  listDueCandidateIds,
  claimCandidate,
  reconcileExpiredCandidateLeases,
  releaseCandidateClaim,
  markCandidateSuppressed,
  markCandidateFailed,
  reserveHistoricalDispatch,
  startHistoricalDispatch,
  releaseHistoricalReservation,
  finalizeHistoricalDispatch,
  countCandidatesSentSince,
}));
vi.mock("./historicalRecoveryTickRepository.js", () => ({
  acquireHistoricalTick,
  openCampaignBatch,
  finishHistoricalTick,
}));
vi.mock("../meta/replyToComment.js", () => ({ replyToComment }));
vi.mock("../meta/fetchComment.js", () => ({ fetchComment }));
vi.mock("./dmRecoveryHealth.js", () => ({ evaluateRecoveryHealth, openRecoveryCircuit }));
vi.mock("./recoveryCampaignControl.js", () => ({
  completeCampaignIfDrained,
  reconcileDrainedCampaigns,
}));
vi.mock("./historicalRecoveryHealth.js", () => ({ evaluateCampaignHealth }));
vi.mock("./campaignHealthObservation.js", () => ({
  reconcilePendingInboundCampaignHealthSignals,
}));
vi.mock("./historicalRecoveryAttribution.js", () => ({
  reconcileHistoricalRecoveryAttributionSafely,
}));
vi.mock("./eventLogger.js", () => ({ logEvent, describeGraphError }));
// classifySourceReadFailure is deliberately NOT mocked: QA-09's defect was
// misclassification, so a stub here would prove nothing. Only the send-path classifier
// is faked, because those tests drive it by category on purpose.
vi.mock("./graphErrorClassifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graphErrorClassifier.js")>()),
  classifyPublicReplyFailure,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCampaign: { findUnique: campaignFindUnique, findMany: campaignFindMany },
    igUser: { findUnique: igUserFindUnique },
    dmMessage: { count: dmMessageCount },
    conversation: { count: conversationCount },
    publicRecoveryDispatch: { count: dispatchCount },
  },
}));

const flags = {
  DM_RECOVERY_ENABLED: true,
  DM_RECOVERY_HISTORICAL_ENABLED: true,
  DM_RECOVERY_WESTERN_ONLY: true,
};
vi.mock("../config/env.js", () => ({
  env: new Proxy(
    {
      DM_RECOVERY_BATCH_SIZE: 2,
      DM_RECOVERY_LEASE_MS: 60_000,
      DM_RECOVERY_GLOBAL_DAILY_CAP: 100,
    } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop === "DM_RECOVERY_ENABLED") return flags.DM_RECOVERY_ENABLED;
        if (prop === "DM_RECOVERY_HISTORICAL_ENABLED") return flags.DM_RECOVERY_HISTORICAL_ENABLED;
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
  keywordId: "kw-1",
  // Every finalise and release must present this, so a stale claimant cannot
  // overwrite the winner's outcome (QA-02).
  claimToken: "token-1",
  attempts: 1,
  // The moment evidence was frozen. The recheck asks "changed SINCE this", not "ever".
  selectedAt: new Date("2026-08-01T00:00:00Z"),
  commentId: "18111572197955347",
  sources: [{ position: 0, commentId: "18111572197955347" }],
  publicReplyText: "I don't think my DM reached you",
  keywordSnapshot: "SLEEP",
  evidence: "gate_sent_no_read",
  arm: "treatment",
  audienceOrigin: "us_western",
};

beforeEach(() => {
  for (const fn of [
    listDueCandidateIds, claimCandidate, reconcileExpiredCandidateLeases,
    releaseCandidateClaim, markCandidateSuppressed, markCandidateFailed,
    reserveHistoricalDispatch, startHistoricalDispatch, releaseHistoricalReservation,
    finalizeHistoricalDispatch,
    countCandidatesSentSince,
    replyToComment, fetchComment, evaluateRecoveryHealth, openRecoveryCircuit,
    logEvent, describeGraphError, classifyPublicReplyFailure,
    campaignFindUnique, campaignFindMany, completeCampaignIfDrained,
    reconcileDrainedCampaigns, evaluateCampaignHealth,
    reconcilePendingInboundCampaignHealthSignals,
    reconcileHistoricalRecoveryAttributionSafely,
    igUserFindUnique, dmMessageCount, conversationCount, dispatchCount,
    acquireHistoricalTick, openCampaignBatch, finishHistoricalTick,
  ]) {
    fn.mockReset();
  }
  flags.DM_RECOVERY_ENABLED = true;
  flags.DM_RECOVERY_HISTORICAL_ENABLED = true;
  flags.DM_RECOVERY_WESTERN_ONLY = true;
  describeGraphError.mockReturnValue(SAFE_UNKNOWN);
  reconcileExpiredCandidateLeases.mockResolvedValue({ uncertain: 0, released: 0 });
  evaluateRecoveryHealth.mockResolvedValue({ circuitOpen: false });
  acquireHistoricalTick.mockResolvedValue({
    token: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  });
  openCampaignBatch.mockResolvedValue({ id: "batch-1", allowance: 2 });
  finishHistoricalTick.mockResolvedValue(true);
  campaignFindMany.mockResolvedValue([{ id: "camp-1" }]);
  listDueCandidateIds.mockResolvedValue(["cand-1"]);
  claimCandidate.mockResolvedValue(CANDIDATE);
  campaignFindUnique.mockResolvedValue({ state: "running", hourlyCap: 3, dailyCap: 10 });
  // Capacity available by default; cases that test the cap return a refusal reason.
  reserveHistoricalDispatch.mockResolvedValue({
    kind: "reserved",
    dispatchId: "dispatch-1",
    reservationToken: "reservation-1",
  });
  startHistoricalDispatch.mockResolvedValue({ kind: "started" });
  releaseHistoricalReservation.mockResolvedValue(true);
  finalizeHistoricalDispatch.mockResolvedValue(true);
  completeCampaignIfDrained.mockResolvedValue(false);
  reconcileDrainedCampaigns.mockResolvedValue([]);
  // Healthy by default, so existing cases test what they were written for.
  evaluateCampaignHealth.mockResolvedValue({ stopReason: null });
  reconcilePendingInboundCampaignHealthSignals.mockResolvedValue({
    processed: 0,
    failed: 0,
    remaining: false,
  });
  reconcileHistoricalRecoveryAttributionSafely.mockResolvedValue({ inbound: 0, completed: 0 });
  igUserFindUnique.mockResolvedValue({ inferredOrigin: "us_western" });
  dmMessageCount.mockResolvedValue(0);
  conversationCount.mockResolvedValue(0);
  dispatchCount.mockResolvedValue(0);
  countCandidatesSentSince.mockResolvedValue(0);
  fetchComment.mockResolvedValue({ id: CANDIDATE.commentId, hidden: false, timestamp: null });
  replyToComment.mockResolvedValue({ replyId: "17900000000000000" });
  markCandidateSuppressed.mockResolvedValue(true);
  markCandidateFailed.mockResolvedValue(true);
  logEvent.mockResolvedValue(undefined);
});

describe("runHistoricalRecoveryTick — the send path", () => {
  it("posts the frozen copy and records Meta's reply id", async () => {
    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).toHaveBeenCalledWith(CANDIDATE.commentId, CANDIDATE.publicReplyText);
    expect(startHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "cand-1", claimToken: "token-1" }),
    );
    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "cand-1",
        outcome: expect.objectContaining({
          kind: "sent",
          providerReplyId: "17900000000000000",
        }),
      }),
    );
    expect(result.sent).toBe(1);
  });

  it("replays durable attribution before and after dispatch finalization", async () => {
    await runHistoricalRecoveryTick();

    expect(reconcileHistoricalRecoveryAttributionSafely).toHaveBeenCalledTimes(2);
    expect(reconcileHistoricalRecoveryAttributionSafely.mock.invocationCallOrder[0])
      .toBeLessThan(finalizeHistoricalDispatch.mock.invocationCallOrder[0]!);
    expect(reconcileHistoricalRecoveryAttributionSafely.mock.invocationCallOrder[1])
      .toBeGreaterThan(finalizeHistoricalDispatch.mock.invocationCallOrder[0]!);
  });

  it("does not call Meta when final dispatch authorization is blocked", async () => {
    startHistoricalDispatch.mockResolvedValue({
      kind: "blocked",
      reason: "campaign_not_running",
    });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseHistoricalReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "cand-1",
        reason: "dispatch_start_rejected:campaign_not_running",
      }),
    );
    expect(result.deferred).toBe(1);
  });

  it("records a final locked eligibility suppression without calling Meta", async () => {
    startHistoricalDispatch.mockResolvedValue({
      kind: "suppressed",
      reason: "keyword_inactive",
    });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseHistoricalReservation).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(1);
  });

  it("stops the tick when final authorization sees pending inbound health capture", async () => {
    startHistoricalDispatch.mockResolvedValue({
      kind: "blocked",
      reason: "campaign_health_capture_pending",
    });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseHistoricalReservation).toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_health_capture_pending");
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

  // Its own switch, separate from the master: the prospective feature can run
  // without historical campaigns, which contact people about weeks-old requests.
  it("sends nothing when DM_RECOVERY_HISTORICAL_ENABLED is false", async () => {
    flags.DM_RECOVERY_HISTORICAL_ENABLED = false;

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("historical_disabled");
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
    campaignFindUnique.mockResolvedValue({ state: "paused", hourlyCap: 3, dailyCap: 10 });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1", "token-1");
    expect(result.skipped).toBe("campaign_not_running");
  });
});

describe("runHistoricalRecoveryTick — pre-send recheck", () => {
  /**
   * Make the source read fail with a specific Graph signature.
   *
   * `describeGraphError` is mocked in this file, so the metadata is set directly rather
   * than parsed from a synthetic axios error — the real parser is covered by its own
   * suite. `classifySourceReadFailure` is NOT mocked, so what runs here is the shipped
   * classification.
   *
   * The test this replaces rejected with a bare `Error("Unsupported get request")` and
   * asserted `source_comment_deleted`. It passed for the wrong reason: the worker caught
   * EVERY failure and called it a deletion, so the assertion held no matter what the
   * error was — exactly the defect QA-09 named.
   */
  function failSourceRead(metadata: Partial<typeof SAFE_UNKNOWN>) {
    fetchComment.mockRejectedValue(new Error("source read failed"));
    describeGraphError.mockReturnValue({ ...SAFE_UNKNOWN, category: "graph_response", ...metadata });
  }

  // Measured: 1 of 3 sampled 44-day-old comments was already deleted.
  it("suppresses when every approved source is gone", async () => {
    failSourceRead({ graphCode: 803 });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "token-1", "source_set_exhausted");
    expect(result.suppressed).toBe(1);
  });

  it("falls back to the next approved source after a definitive missing result", async () => {
    claimCandidate.mockResolvedValue({
      ...CANDIDATE,
      sources: [
        { position: 0, commentId: CANDIDATE.commentId },
        { position: 1, commentId: "18111572197950000" },
      ],
    });
    describeGraphError.mockReturnValue({
      ...SAFE_UNKNOWN,
      category: "graph_response",
      graphCode: 803,
    });
    fetchComment
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ id: "18111572197950000", hidden: false, timestamp: null });

    const result = await runHistoricalRecoveryTick();

    expect(startHistoricalDispatch).toHaveBeenCalledWith(expect.objectContaining({
      commentId: "18111572197950000",
    }));
    expect(replyToComment).toHaveBeenCalledWith(
      "18111572197950000",
      CANDIDATE.publicReplyText,
    );
    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(result.sent).toBe(1);
  });

  // QA-09's core case. A timeout says nothing about whether the comment exists, and
  // suppressing on it burns a valid candidate permanently.
  it("defers instead of suppressing when the read merely failed", async () => {
    failSourceRead({ category: "graph_transport", transportCode: "ETIMEDOUT" });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(0);
    expect(result.deferred).toBe(1);
  });

  // A rate limit is the same story with a different cause.
  it("defers on a rate-limited read", async () => {
    failSourceRead({ httpStatus: 429 });

    const result = await runHistoricalRecoveryTick();

    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });

  // A deferred read must come back later, not on the very next tick: otherwise one
  // stubbornly failing comment is re-read forever and starves the queue.
  it("backs off a deferred read rather than releasing it immediately", async () => {
    failSourceRead({ httpStatus: 503 });

    await runHistoricalRecoveryTick();

    const [, , nextAttemptAt] = releaseCandidateClaim.mock.calls.at(-1)!;
    expect(nextAttemptAt).toBeInstanceOf(Date);
    expect((nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  // An expired token would fail every remaining row identically, so it stops the tick
  // through the shared circuit instead of churning the whole pool one row at a time.
  it("opens the shared circuit on an auth failure and stops the tick", async () => {
    failSourceRead({ httpStatus: 401, graphCode: 190 });

    const result = await runHistoricalRecoveryTick();

    expect(openRecoveryCircuit).toHaveBeenCalledWith("auth_or_permission", expect.any(Date));
    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(result.skipped).toBe("source_read_auth_failed");
  });

  // Worse than deletion: a reply to a hidden comment SUCCEEDS, so it would count as
  // a send while nobody ever saw it.
  it("suppresses when the approved set is exhausted by a hidden comment", async () => {
    fetchComment.mockResolvedValue({ id: CANDIDATE.commentId, hidden: true, timestamp: null });

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "token-1", "source_set_exhausted");
  });

  it("suppresses when the person replied after selection", async () => {
    dmMessageCount.mockResolvedValue(1);

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "token-1", "replied_since_selection");
  });

  it("suppresses when another recovery already reached them", async () => {
    dispatchCount.mockResolvedValue(1);

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "token-1", "contacted_since_selection");
  });

  // The verdict is read LIVE, not from the snapshot: it is retired when the name it
  // came from changes, so an in-market selection can read out-of-market now.
  it("suppresses on the live origin verdict, not the snapshot", async () => {
    igUserFindUnique.mockResolvedValue({ inferredOrigin: "south_asian" });

    await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith("cand-1", "token-1", "audience_out_of_market");
  });

  it("defers rather than burning the row at the hourly cap", async () => {
    countCandidatesSentSince.mockResolvedValue(3);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1", "token-1");
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
    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: "failed", reason: "auth_or_permission" }) }),
    );
    expect(result.failed).toBe(1);
  });

  it("records a permanent rejection with its graph code", async () => {
    replyToComment.mockRejectedValue(new Error("nope"));
    describeGraphError.mockReturnValue({ ...SAFE_UNKNOWN, graphCode: 190 });
    classifyPublicReplyFailure.mockReturnValue("permanent");

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: "failed", reason: "code_190" }) }),
    );
    expect(result.failed).toBe(1);
  });

  // The comment may have posted. Retrying would risk a SECOND public comment, so an
  // uncertain send is parked for a human and never retried.
  it("parks an ambiguous transport failure as uncertain", async () => {
    replyToComment.mockRejectedValue(new Error("socket hang up"));
    classifyPublicReplyFailure.mockReturnValue("unknown");

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "uncertain", reason: "unknown_error" } }),
    );
    expect(result.uncertain).toBe(1);
  });

  // A retryable failure now carries a DURABLE backoff. Releasing with no record meant
  // a rate-limited row was retried on every tick indefinitely (QA-10).
  it("releases a retryable failure with a future retry time", async () => {
    replyToComment.mockRejectedValue(new Error("rate limited"));
    classifyPublicReplyFailure.mockReturnValue("safe_retry");

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: "released",
          reason: "rate_limit",
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
    expect(result.deferred).toBe(1);

    const retryAt = finalizeHistoricalDispatch.mock.calls[0]?.[0].outcome.nextAttemptAt as Date;
    expect(retryAt.getTime()).toBeGreaterThan(Date.now());
  });

  // The backoff needs a ceiling, or a permanently rate-limited row retries forever.
  it("fails a candidate that exhausted its attempts", async () => {
    claimCandidate.mockResolvedValue({ ...CANDIDATE, attempts: 5 });
    replyToComment.mockRejectedValue(new Error("rate limited"));
    classifyPublicReplyFailure.mockReturnValue("safe_retry");

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: "failed", reason: "rate_limit_exhausted" }) }),
    );
    expect(result.failed).toBe(1);
  });

  // Meta accepted the post but returned no id, so there is no evidence it landed —
  // and the sent-requires-reply-id constraint would reject it anyway.
  it("treats a missing reply id as uncertain, not sent", async () => {
    replyToComment.mockResolvedValue({ replyId: null });

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "uncertain", reason: "missing_reply_id" } }),
    );
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
  // QA-10 split this: only leases whose DISPATCH had started become uncertain. A worker
  // that died while still preparing never called Meta, so its row is released.
  it("reports both parked and released expired leases", async () => {
    reconcileExpiredCandidateLeases.mockResolvedValue({ uncertain: 2, released: 3 });

    await runHistoricalRecoveryTick();

    const entry = logEvent.mock.calls.find(([kind]) => kind === "historical_recovery_stale_leases");
    expect(entry).toBeDefined();
    expect(entry![1]).toEqual({ uncertain: 2, released: 3 });
  });

  it("logs nothing when no lease expired", async () => {
    reconcileExpiredCandidateLeases.mockResolvedValue({ uncertain: 0, released: 0 });

    await runHistoricalRecoveryTick();

    const kinds = logEvent.mock.calls.map(([kind]) => kind);
    expect(kinds).not.toContain("historical_recovery_stale_leases");
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

// QA-08. `batch_size` was stored on the campaign, staged by the dashboard and the API,
// and then ignored: the worker read only DM_RECOVERY_BATCH_SIZE. Verified in production —
// two campaigns carried batch_size 1 and 5 while the worker sent 5 regardless. The
// staged rollout the plan depends on was writing a number nothing consulted.
describe("runHistoricalRecoveryTick — campaign pacing", () => {
  it("uses the campaign's batch size instead of the env value", async () => {
    openCampaignBatch.mockResolvedValue({ id: "batch-1", allowance: 1 });
    listDueCandidateIds.mockResolvedValue(["cand-1", "cand-2"]);

    const result = await runHistoricalRecoveryTick();

    // env batch is 2, campaign batch is 1: one send, and the loop stops.
    expect(result.sent).toBe(1);
    expect(replyToComment).toHaveBeenCalledTimes(1);
  });

  it("gives simultaneous campaigns independent batch allowances", async () => {
    campaignFindMany.mockResolvedValue([{ id: "camp-1" }, { id: "camp-2" }]);
    openCampaignBatch.mockImplementation(async (_tick, campaignId: string) => ({
      id: `batch-${campaignId}`,
      allowance: campaignId === "camp-1" ? 1 : 5,
    }));
    listDueCandidateIds.mockImplementation(async (_now, _limit, campaignId: string) =>
      campaignId === "camp-1"
        ? ["camp-1-cand-1"]
        : Array.from({ length: 5 }, (_, index) => `camp-2-cand-${index + 1}`),
    );
    claimCandidate.mockImplementation(async (id: string) => ({
      ...CANDIDATE,
      id,
      campaignId: id.startsWith("camp-1") ? "camp-1" : "camp-2",
    }));

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(6);
    expect(startHistoricalDispatch.mock.calls.filter(
      ([input]) => input.batchRunId === "batch-camp-1",
    )).toHaveLength(1);
    expect(startHistoricalDispatch.mock.calls.filter(
      ([input]) => input.batchRunId === "batch-camp-2",
    )).toHaveLength(5);
  });

  it("skips when another process owns the distributed tick lease", async () => {
    acquireHistoricalTick.mockResolvedValue(null);

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("tick_already_running");
    expect(campaignFindMany).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("finishes the distributed tick even when campaign enumeration fails", async () => {
    campaignFindMany.mockRejectedValue(new Error("db gone"));

    const result = await runHistoricalRecoveryTick();

    expect(result.skipped).toBe("tick_failed");
    expect(finishHistoricalTick).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.any(Date),
    );
  });

  // The reservation replaced a read-then-post pair with nothing holding the gap.
  it("posts nothing when the reservation refuses a slot", async () => {
    reserveHistoricalDispatch.mockResolvedValue({
      kind: "blocked",
      reason: "global_hourly_cap_reached",
    });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(releaseCandidateClaim).toHaveBeenCalledWith("cand-1", "token-1");
    expect(result.skipped).toBe("global_hourly_cap_reached");
    expect(result.deferred).toBe(1);
  });

  it("stops the tick when the shared rolling-day capacity is full", async () => {
    reserveHistoricalDispatch.mockResolvedValue({
      kind: "blocked",
      reason: "global_daily_cap_reached",
    });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.skipped).toBe("global_daily_cap_reached");
    expect(result.deferred).toBe(1);
  });

  // The reservation must happen BEFORE Meta is contacted, or it reserves nothing.
  it("reserves capacity before dispatching", async () => {
    const order: string[] = [];
    reserveHistoricalDispatch.mockImplementation(async () => {
      order.push("reserve");
      return {
        kind: "reserved",
        dispatchId: "dispatch-1",
        reservationToken: "reservation-1",
      };
    });
    replyToComment.mockImplementation(async () => {
      order.push("dispatch");
      return { replyId: "17900000000000000" };
    });

    await runHistoricalRecoveryTick();

    expect(order).toEqual(["reserve", "dispatch"]);
  });
});

// QA-10. The pre-send reads ran bare in the loop, so a database failure after claiming
// escaped to the tick's outer catch with the lease still held. Lease reconciliation then
// marked the row `send_uncertain` — terminal, never retried — even though Meta had never
// been contacted. One momentary database blip permanently burned a candidate and recorded
// it as "we may have posted".
describe("runHistoricalRecoveryTick — a failure before dispatch is not uncertainty", () => {
  it("returns the candidate for retry when a pre-dispatch read fails", async () => {
    campaignFindUnique.mockRejectedValue(new Error("connection terminated"));

    const result = await runHistoricalRecoveryTick();

    expect(finalizeHistoricalDispatch).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.uncertain).toBe(0);
    expect(result.deferred).toBe(1);
  });

  it("releases the claim so a later tick can pick it up", async () => {
    conversationCount.mockRejectedValue(new Error("connection terminated"));

    await runHistoricalRecoveryTick();

    const [id, token, nextAttemptAt] = releaseCandidateClaim.mock.calls.at(-1)!;
    expect([id, token]).toEqual(["cand-1", "token-1"]);
    // Backoff, because whatever broke is likely still broken next tick.
    expect(nextAttemptAt).toBeInstanceOf(Date);
  });

  // A failure DURING dispatch is different and must stay uncertain: the comment may
  // have posted. Pinned so the containment above cannot be widened onto the send path.
  it("still parks a dispatch-time failure as uncertain", async () => {
    replyToComment.mockRejectedValue(new Error("socket hang up"));
    classifyPublicReplyFailure.mockReturnValue("uncertain");

    const result = await runHistoricalRecoveryTick();

    expect(result.uncertain).toBe(1);
    expect(finalizeHistoricalDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: "uncertain" }) }),
    );
  });
});

// QA-11. All three "since selection" checks asked "has this EVER happened" instead,
// and completion was not scoped to the candidate's own keyword.
//
// Measured against production: 64 of 2,413 candidates would have been silently
// suppressed at the final gate for completing an UNRELATED guide, and 4 for an inbound
// that predated the request they were being excluded from.
describe("runHistoricalRecoveryTick — evidence is scoped to since-selection", () => {
  /** The queries the recheck issued, so scope can be asserted rather than assumed. */
  function whereOf(mock: typeof dmMessageCount) {
    return mock.mock.calls.at(-1)?.[0]?.where ?? {};
  }

  it("counts only inbound messages received after selection", async () => {
    await runHistoricalRecoveryTick();

    // An unbounded count is what made a months-old DM suppress this candidate.
    expect(whereOf(dmMessageCount).createdAt).toEqual({ gte: CANDIDATE.selectedAt });
  });

  // THE 64-candidate defect. The reminder names one guide; completing a different one
  // does not make it untrue.
  it("counts completions only for this keyword, after selection", async () => {
    await runHistoricalRecoveryTick();

    const where = whereOf(conversationCount);
    expect(where.keywordId).toBe(CANDIDATE.keywordId);
    expect(where.completedAt).toEqual({ gte: CANDIDATE.selectedAt });
  });

  it("asks the shared ledger about either system's prior public contact", async () => {
    await runHistoricalRecoveryTick();

    expect(dispatchCount).toHaveBeenCalled();
    const where = whereOf(dispatchCount);
    expect(where.igUserId).toBe(CANDIDATE.igUserId);
    expect(where.state).toEqual({ in: ["sent", "uncertain"] });
    expect(where.dispatchStartedAt).toEqual({ gte: CANDIDATE.selectedAt });
  });

  // A send from either feature is a reason to stay silent; source tables are not read.
  it("suppresses when the ledger shows a prior send", async () => {
    dispatchCount.mockResolvedValue(1);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith(
      "cand-1",
      "token-1",
      "contacted_since_selection",
    );
    expect(result.suppressed).toBe(1);
  });

  // The control: evidence that DOES fall after selection must still suppress, or these
  // scoping changes would have disabled the checks rather than corrected them.
  it("still suppresses on a reply that landed after selection", async () => {
    dmMessageCount.mockResolvedValue(1);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(1);
  });

  it("still suppresses on a same-keyword completion after selection", async () => {
    conversationCount.mockResolvedValue(1);

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).not.toHaveBeenCalled();
    expect(markCandidateSuppressed).toHaveBeenCalledWith(
      "cand-1",
      "token-1",
      "completed_since_selection",
    );
  });
});

// QA-12. `completeCampaignIfDrained` existed with NO production caller, so a campaign
// that had sent every candidate sat `running` forever: the dashboard showed active work
// that would never move, and nothing recorded that the campaign had done its job.
describe("runHistoricalRecoveryTick — closes a drained campaign", () => {
  it("reconciles all drained campaigns even when this process changed no row", async () => {
    listDueCandidateIds.mockResolvedValue([]);

    await runHistoricalRecoveryTick();

    expect(reconcileDrainedCampaigns).toHaveBeenCalledWith(expect.any(Date));
  });

  it("attempts completion for every campaign the tick touched", async () => {
    await runHistoricalRecoveryTick();

    expect(completeCampaignIfDrained).toHaveBeenCalledWith("camp-1", expect.any(Date));
  });

  // Health is checked after each outcome so a stop from row one fences row two.
  it("checks campaign health after each terminal outcome", async () => {
    listDueCandidateIds.mockResolvedValue(["cand-1", "cand-2"]);

    await runHistoricalRecoveryTick();

    expect(evaluateCampaignHealth).toHaveBeenCalledTimes(3);
    expect(completeCampaignIfDrained).toHaveBeenCalledTimes(1);
  });

  // Nothing claimed means nothing changed, so there is nothing to close.
  it("does not check when no candidate was claimed", async () => {
    claimCandidate.mockResolvedValue(null);

    await runHistoricalRecoveryTick();

    expect(completeCampaignIfDrained).not.toHaveBeenCalled();
  });

  // A tick that posted successfully must not report failure because the bookkeeping
  // afterwards broke.
  it("still reports the send when completion bookkeeping fails", async () => {
    completeCampaignIfDrained.mockRejectedValue(new Error("db gone"));

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(1);
    expect(result.skipped).toBeUndefined();
  });
});

// QA-13. `evaluateRecoveryHealth` reads only dm_recovery_reminder, so a historical
// campaign could be failing on real people's public comments while the shared circuit
// stayed closed because the prospective feature was healthy.
describe("runHistoricalRecoveryTick — campaign stop conditions", () => {
  it("does not open a campaign batch while durable inbound health capture is pending", async () => {
    reconcilePendingInboundCampaignHealthSignals.mockResolvedValue({
      processed: 100,
      failed: 0,
      remaining: true,
    });

    const result = await runHistoricalRecoveryTick();

    expect(openCampaignBatch).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_health_capture_pending");
  });

  it("fails closed when a durable inbound health capture cannot be reconciled", async () => {
    reconcilePendingInboundCampaignHealthSignals.mockResolvedValue({
      processed: 0,
      failed: 1,
      remaining: false,
    });

    const result = await runHistoricalRecoveryTick();

    expect(openCampaignBatch).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_health_capture_failed");
  });

  it("stops the campaign mid-batch before reserving a second candidate", async () => {
    listDueCandidateIds.mockResolvedValue(["cand-1", "cand-2"]);
    claimCandidate.mockImplementation(async (id: string) => ({ ...CANDIDATE, id }));
    evaluateCampaignHealth
      .mockResolvedValueOnce({ stopReason: null })
      .mockResolvedValue({ stopReason: "complaint" });

    const result = await runHistoricalRecoveryTick();

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(reserveHistoricalDispatch).toHaveBeenCalledTimes(1);
    expect(claimCandidate).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe("campaign_auto_paused:complaint");
  });

  it("honors a durable stop observation before the first dispatch", async () => {
    evaluateCampaignHealth.mockResolvedValue({ stopReason: "opt_out" });

    const result = await runHistoricalRecoveryTick();

    expect(openCampaignBatch).not.toHaveBeenCalled();
    expect(claimCandidate).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_auto_paused:opt_out");
  });

  it("evaluates campaign health after the tick", async () => {
    await runHistoricalRecoveryTick();

    expect(evaluateCampaignHealth).toHaveBeenCalledWith("camp-1", expect.any(Date));
  });

  // A campaign that has just tripped a stop must read as paused, not completed:
  // completing it would hide the fault behind a state that looks like success.
  it("does not complete a campaign that just auto-paused", async () => {
    evaluateCampaignHealth.mockResolvedValue({ stopReason: "public_failure_rate" });

    const result = await runHistoricalRecoveryTick();

    expect(completeCampaignIfDrained).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_auto_paused:public_failure_rate");
  });

  it("completes a drained campaign that is healthy", async () => {
    await runHistoricalRecoveryTick();

    expect(completeCampaignIfDrained).toHaveBeenCalledWith("camp-1", expect.any(Date));
  });

  it("fails closed before dispatch when initial health evaluation fails", async () => {
    evaluateCampaignHealth.mockRejectedValue(new Error("db gone"));

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(0);
    expect(openCampaignBatch).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_health_check_failed");
  });

  it("stops before the next candidate when post-outcome health evaluation fails", async () => {
    listDueCandidateIds.mockResolvedValue(["cand-1", "cand-2"]);
    claimCandidate.mockImplementation(async (id: string) => ({ ...CANDIDATE, id }));
    evaluateCampaignHealth
      .mockResolvedValueOnce({ stopReason: null })
      .mockRejectedValue(new Error("db gone"));

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(1);
    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(claimCandidate).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe("campaign_health_check_failed");
  });

  // Every case above drives a tick where the send SUCCEEDS, and that was the whole gap:
  // the campaign was only registered for evaluation after a successful post, so the stop
  // conditions could not fire in the failure modes they exist for. These two assert that
  // the health check is REACHABLE from a tick that posts nothing at all.
  it("evaluates campaign health when every send failed", async () => {
    replyToComment.mockRejectedValue(new Error("meta rejected"));
    classifyPublicReplyFailure.mockReturnValue("permanent");

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(evaluateCampaignHealth).toHaveBeenCalledWith("camp-1", expect.any(Date));
  });

  // The condition this protects is `source_unavailable_rate`, which chooseStopReason
  // deliberately evaluates at settled == 0 — a cohort whose comments have all been
  // deleted sends nothing. That branch is unreachable if a send is required first.
  it("evaluates campaign health when every candidate was suppressed", async () => {
    fetchComment.mockResolvedValue({ id: CANDIDATE.commentId, hidden: true, timestamp: null });

    const result = await runHistoricalRecoveryTick();

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(evaluateCampaignHealth).toHaveBeenCalledWith("camp-1", expect.any(Date));
  });

  // An auto-pause must win over completion on a failing tick too. Otherwise a campaign
  // that tripped a stop while posting nothing would be closed as `completed`, which reads
  // as success and hides the fault.
  it("does not complete an auto-paused campaign whose sends all failed", async () => {
    replyToComment.mockRejectedValue(new Error("meta rejected"));
    classifyPublicReplyFailure.mockReturnValue("permanent");
    evaluateCampaignHealth.mockResolvedValue({ stopReason: "public_failure_rate" });

    const result = await runHistoricalRecoveryTick();

    expect(completeCampaignIfDrained).not.toHaveBeenCalled();
    expect(result.skipped).toBe("campaign_auto_paused:public_failure_rate");
  });
});

describe("runHistoricalRecoveryTick — rolling reservation timestamps", () => {
  it("does not backdate a later candidate to tick start", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-08-08T20:00:00.000Z");
      vi.setSystemTime(startedAt);
      listDueCandidateIds.mockResolvedValue(["cand-1", "cand-2"]);
      claimCandidate.mockImplementation(async (id: string) => ({ ...CANDIDATE, id }));
      replyToComment.mockImplementation(async () => {
        if (replyToComment.mock.calls.length === 1) {
          vi.setSystemTime(new Date(startedAt.getTime() + 5 * 60_000));
        }
        return { replyId: `provider-${replyToComment.mock.calls.length}` };
      });

      await runHistoricalRecoveryTick();

      expect(reserveHistoricalDispatch).toHaveBeenCalledTimes(2);
      const first = reserveHistoricalDispatch.mock.calls[0]![0].now as Date;
      const second = reserveHistoricalDispatch.mock.calls[1]![0].now as Date;
      expect(first.getTime()).toBe(startedAt.getTime());
      expect(second.getTime()).toBe(startedAt.getTime() + 5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
