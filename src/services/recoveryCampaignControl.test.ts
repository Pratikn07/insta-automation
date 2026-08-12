import { describe, it, expect, vi, beforeEach } from "vitest";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";

const campaignUpdateMany = vi.fn();
const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const campaignUpdate = vi.fn();
const candidateUpdateMany = vi.fn();
const candidateFindMany = vi.fn();
const candidateCount = vi.fn();
const exclusionFindMany = vi.fn();
const controlUpsert = vi.fn();
const dispatchFindMany = vi.fn();
const dispatchUpdateMany = vi.fn();
const dispatchCount = vi.fn();
const queryRaw = vi.fn();
const logEvent = vi.fn();
const verifyStoredSelectionSnapshot = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCampaign: {
      updateMany: campaignUpdateMany,
      findUnique: campaignFindUnique,
      findMany: campaignFindMany,
      update: campaignUpdate,
    },
    recoveryCandidate: {
      updateMany: candidateUpdateMany,
      findMany: candidateFindMany,
      count: candidateCount,
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        recoveryCampaign: {
          updateMany: campaignUpdateMany,
          update: campaignUpdate,
          findUnique: campaignFindUnique,
          findMany: campaignFindMany,
        },
        recoveryCandidate: {
          updateMany: candidateUpdateMany,
          findMany: candidateFindMany,
          count: candidateCount,
        },
        recoverySelectionExclusion: { findMany: exclusionFindMany },
        dmRecoveryControl: { upsert: controlUpsert },
        publicRecoveryDispatch: {
          findMany: dispatchFindMany,
          updateMany: dispatchUpdateMany,
          count: dispatchCount,
        },
        $queryRaw: queryRaw,
      }),
  },
}));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("./historicalRecoverySnapshot.js", () => ({ verifyStoredSelectionSnapshot }));

const {
  approveCampaign,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  cancelCampaign,
  completeCampaignIfDrained,
  advanceCampaignStage,
  PENDING_LAUNCH_PAUSE_REASON,
} = await import("./recoveryCampaignControl.js");

beforeEach(() => {
  for (const fn of [
    campaignUpdateMany, campaignFindUnique, campaignFindMany, campaignUpdate,
    candidateUpdateMany, candidateFindMany, candidateCount, controlUpsert,
    dispatchFindMany, dispatchUpdateMany, dispatchCount, exclusionFindMany,
    queryRaw, logEvent, verifyStoredSelectionSnapshot,
  ]) {
    fn.mockReset();
  }
  logEvent.mockResolvedValue(undefined);
  queryRaw.mockResolvedValue([]);
  controlUpsert.mockResolvedValue({ id: 1 });
  candidateFindMany.mockResolvedValue([]);
  exclusionFindMany.mockResolvedValue([]);
  verifyStoredSelectionSnapshot.mockReturnValue({ ok: true });
  dispatchFindMany.mockResolvedValue([]);
  dispatchUpdateMany.mockResolvedValue({ count: 0 });
  dispatchCount.mockResolvedValue(0);
  candidateCount.mockResolvedValue(1);
  campaignFindMany.mockResolvedValue([]);
  campaignFindUnique.mockResolvedValue({
    state: "draft",
    candidateCount: 1,
    decisionHash: "contract-hash",
  });
  campaignUpdate.mockResolvedValue({});
});

describe("approveCampaign", () => {
  // Approval is the moment public comments become possible, so it must record who
  // and when — chk_campaign_approval_complete requires both together.
  it("records the approver and starts the campaign running", async () => {
    // Approval now settles the holdout arm terminally (QA-12), so this is consulted.
    candidateUpdateMany.mockResolvedValue({ count: 0 });

    const result = await approveCampaign("camp-1", "pratik");

    expect(result).toEqual({ ok: true, state: "running" });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: {
        state: "running",
        approvedBy: "pratik",
        approvedAt: expect.any(Date),
        startedAt: expect.any(Date),
        endedAt: null,
      },
    });
  });

  it("can approve directly into a scheduler-inert pending-launch pause", async () => {
    const now = new Date("2026-08-09T20:00:00.000Z");
    candidateUpdateMany.mockResolvedValue({ count: 0 });

    const result = await approveCampaign("camp-1", "pratik", now, { startPaused: true });

    expect(result).toEqual({ ok: true, state: "paused" });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: {
        state: "paused",
        approvedBy: "pratik",
        approvedAt: now,
        startedAt: null,
        pausedAt: now,
        pauseReason: "approved_pending_launch",
        endedAt: null,
      },
    });
  });

  // An unattributable approval is not an audit trail.
  it("refuses an empty approver", async () => {
    const result = await approveCampaign("camp-1", "   ");

    expect(result).toEqual({ ok: false, reason: "approver_required" });
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  // Re-approving would reset state on a campaign whose candidates may already have
  // been sent, so the transition is conditional and reports what blocked it.
  it("refuses to re-approve a running campaign", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue({ state: "running" });

    const result = await approveCampaign("camp-1", "pratik");

    expect(result).toEqual({ ok: false, reason: "not_approvable_from_running" });
  });

  it("reports a missing campaign distinctly", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue(null);

    expect(await approveCampaign("nope", "pratik")).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([
    "snapshot_incomplete",
    "snapshot_fingerprint_mismatch",
    "snapshot_hash_mismatch",
  ])("refuses approval when verification reports %s", async (reason) => {
    verifyStoredSelectionSnapshot.mockReturnValue({ ok: false, reason });

    await expect(approveCampaign("camp-1", "pratik")).resolves.toEqual({
      ok: false,
      reason,
    });
    expect(candidateUpdateMany).not.toHaveBeenCalled();
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("reconstructs the stored candidate origin method for snapshot verification", async () => {
    candidateUpdateMany.mockResolvedValue({ count: 0 });
    candidateFindMany.mockResolvedValue([{
      selectionPosition: 0,
      intentId: "intent-1",
      igUserId: "person-1",
      conversationId: "conversation-1",
      keywordId: "keyword-1",
      commentId: "comment-1",
      mediaId: null,
      commentAt: new Date("2026-08-09T00:00:00.000Z"),
      keywordSnapshot: "SLEEP",
      publicReplyText: "Please DM SLEEP",
      evidence: "gate_sent_no_read",
      audienceOrigin: "us_western",
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
      audienceOriginConfidence: "high",
      arm: "treatment",
      sourceChoiceReason: "newest_eligible_comment",
      sources: [{
        position: 0,
        commentId: "comment-1",
        mediaId: null,
        receivedAt: new Date("2026-08-09T00:00:00.000Z"),
        choiceReason: "newest_eligible_comment",
      }],
    }]);

    await expect(approveCampaign("camp-1", "pratik")).resolves.toEqual({
      ok: true,
      state: "running",
    });

    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      inclusions: [expect.objectContaining({ audienceOriginMethod: CURRENT_ORIGIN_METHOD })],
    }));
  });

  it("reconstructs exact expanded-audience metadata for approval verification", async () => {
    candidateUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue({
      state: "draft",
      candidateCount: 1,
      decisionHash: "contract-hash",
      phase: "unknown_read_pilot",
      selectionVersion: "selection-v4",
      sourceDataCutoff: new Date("2026-08-09T00:00:00.000Z"),
      commentFrom: null,
      commentTo: null,
      selectionLimit: 1,
      holdoutPercent: 0,
      copyVersion: "copy-v1",
      selectionFingerprint: "fingerprint",
      eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
      westernOnly: true,
      inboundWindowHours: 24,
      completionWindowHours: 48,
      excludedCount: 0,
      audienceSegment: "other",
      rolloutGroupId: "11111111-1111-4111-8111-111111111111",
      rolloutGroupHourlyCap: 2,
    });
    candidateFindMany.mockResolvedValue([{
      selectionPosition: 0,
      intentId: "intent-1",
      igUserId: "person-1",
      conversationId: "conversation-1",
      keywordId: "keyword-1",
      commentId: "comment-1",
      mediaId: null,
      commentAt: new Date("2026-08-09T00:00:00.000Z"),
      keywordSnapshot: "SLEEP",
      publicReplyText: "Please DM SLEEP",
      evidence: "gate_sent_no_read",
      audienceOrigin: "other",
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
      audienceOriginConfidence: "high",
      audienceSegment: "other",
      arm: "treatment",
      sourceChoiceReason: "newest_eligible_comment",
      sources: [{
        position: 0,
        commentId: "comment-1",
        mediaId: null,
        receivedAt: new Date("2026-08-09T00:00:00.000Z"),
        choiceReason: "newest_eligible_comment",
      }],
    }]);

    await approveCampaign("camp-1", "pratik");

    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        audienceSegment: "other",
        rolloutGroupId: "11111111-1111-4111-8111-111111111111",
        rolloutGroupHourlyCap: 2,
      }),
      inclusions: [expect.objectContaining({ audienceSegment: "other" })],
    }));
  });

  it("logs the approval for the audit trail", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "draft",
      candidateCount: 4,
      decisionHash: "contract-hash",
    });
    candidateCount.mockResolvedValue(4);
    candidateUpdateMany.mockResolvedValue({ count: 4 });

    await approveCampaign("camp-1", "pratik");

    // holdoutWithheld is part of the trail (QA-12): it records that withholding from
    // those people was a deliberate assignment, not rows nobody got round to sending.
    expect(logEvent).toHaveBeenCalledWith("historical_campaign_approved", {
      campaignId: "camp-1",
      approvedBy: "pratik",
      holdoutWithheld: 4,
    });
  });

  // The arm is settled terminally at approval, so the completion check can ignore it and
  // the worker can never claim it.
  it("settles the holdout arm at approval", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "draft",
      candidateCount: 2,
      decisionHash: "contract-hash",
    });
    candidateCount.mockResolvedValue(2);
    candidateUpdateMany.mockResolvedValue({ count: 2 });

    await approveCampaign("camp-1", "pratik");

    expect(candidateUpdateMany).toHaveBeenCalledWith({
      where: { campaignId: "camp-1", arm: "holdout", outcome: "pending" },
      data: { outcome: "holdout_withheld", suppressionReason: "holdout_arm" },
    });
  });
});

describe("pauseCampaign", () => {
  // The emergency stop. Pending candidates are untouched so it can resume without
  // re-selecting — a re-selection would change the approved list.
  it("pauses a running campaign with its reason", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await pauseCampaign("camp-1", "complaint received");

    expect(result).toEqual({ ok: true, state: "paused" });
    expect(candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to pause a campaign that is not running", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue({ state: "draft" });

    expect(await pauseCampaign("camp-1", "x")).toEqual({
      ok: false,
      reason: "not_pausable_from_draft",
    });
  });
});

describe("pauseCampaignGroup", () => {
  const rolloutGroupId = "11111111-1111-4111-8111-111111111111";

  it("locks control before group campaigns in stable ID order and pauses only running members", async () => {
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "11111111-1111-4111-8111-111111111112", state: "running" },
        { id: "22222222-2222-4222-8222-222222222222", state: "completed" },
        { id: "33333333-3333-4333-8333-333333333333", state: "paused" },
      ]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      pauseCampaignGroup(rolloutGroupId, " owner emergency stop "),
    ).resolves.toEqual({
      rolloutGroupId,
      pausedCampaignIds: ["11111111-1111-4111-8111-111111111112"],
      skipped: [
        { campaignId: "22222222-2222-4222-8222-222222222222", state: "completed" },
        { campaignId: "33333333-3333-4333-8333-333333333333", state: "paused" },
      ],
    });

    expect(controlUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      queryRaw.mock.invocationCallOrder[0]!,
    );
    const controlLockSql = (queryRaw.mock.calls[0]?.[0] as readonly string[]).join(" ");
    const groupLockSql = (queryRaw.mock.calls[1]?.[0] as readonly string[]).join(" ");
    expect(controlLockSql).toContain('FROM "dm_recovery_control"');
    expect(groupLockSql).toContain('WHERE "rollout_group_id" =');
    expect(groupLockSql).toContain('ORDER BY "id"');
    expect(queryRaw.mock.calls[1]?.[1]).toBe(rolloutGroupId);
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["11111111-1111-4111-8111-111111111112"] },
        state: "running",
      },
      data: {
        state: "paused",
        pausedAt: expect.any(Date),
        pauseReason: "owner emergency stop",
      },
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith("historical_campaign_group_paused", {
      rolloutGroupId,
      reason: "owner emergency stop",
      pausedCampaignIds: ["11111111-1111-4111-8111-111111111112"],
      skipped: [
        { campaignId: "22222222-2222-4222-8222-222222222222", state: "completed" },
        { campaignId: "33333333-3333-4333-8333-333333333333", state: "paused" },
      ],
    });
  });

  it("is idempotent when every group member is already non-running", async () => {
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "11111111-1111-4111-8111-111111111112", state: "paused" },
        { id: "22222222-2222-4222-8222-222222222222", state: "cancelled" },
      ]);

    await expect(pauseCampaignGroup(rolloutGroupId, "already stopped")).resolves.toEqual({
      rolloutGroupId,
      pausedCampaignIds: [],
      skipped: [
        { campaignId: "11111111-1111-4111-8111-111111111112", state: "paused" },
        { campaignId: "22222222-2222-4222-8222-222222222222", state: "cancelled" },
      ],
    });
    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   ", "x".repeat(201)])(
    "rejects the invalid service reason %p before locking",
    async (reason) => {
      await expect(pauseCampaignGroup(rolloutGroupId, reason)).rejects.toThrow(
        "invalid_campaign_pause_reason",
      );
      expect(controlUpsert).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );
});

describe("resumeCampaign", () => {
  const reviewedPause = (pauseReason: string, startedAt: Date | null = new Date("2026-08-09T00:00:00.000Z")) => ({
    state: "paused",
    pauseReason,
    startedAt,
    phase: "unknown_read_pilot",
    selectionVersion: "selection-v1",
    sourceDataCutoff: new Date("2026-08-09T00:00:00.000Z"),
    commentFrom: null,
    commentTo: null,
    selectionLimit: null,
    holdoutPercent: 0,
    copyVersion: "copy-v1",
    selectionFingerprint: "fingerprint",
    decisionHash: "decision",
    eligibilityPolicyVersion: "eligibility-v3",
    westernOnly: true,
    inboundWindowHours: 48,
    completionWindowHours: 48,
    candidateCount: 1,
    excludedCount: 0,
  });
  const storedCandidate = (audienceOriginMethod: string | null) => ({
    selectionPosition: 0,
    intentId: "intent-1",
    igUserId: "person-1",
    conversationId: "conversation-1",
    keywordId: "keyword-1",
    commentId: "comment-1",
    mediaId: null,
    commentAt: new Date("2026-08-09T00:00:00.000Z"),
    keywordSnapshot: "SLEEP",
    publicReplyText: "Please DM SLEEP",
    evidence: "gate_sent_no_read",
    audienceOrigin: "us_western",
    audienceOriginMethod,
    audienceOriginConfidence: "high",
    arm: "treatment",
    sourceChoiceReason: "newest_eligible_comment",
    sources: [{
      position: 0,
      commentId: "comment-1",
      mediaId: null,
      receivedAt: new Date("2026-08-09T00:00:00.000Z"),
      choiceReason: "newest_eligible_comment",
    }],
  });
  // Approval is already on the row, so resuming does not re-ask for it — but the
  // query still requires approvedAt, making that invariant explicit.
  it("resumes only a paused, already-approved campaign with a current-method snapshot", async () => {
    campaignFindUnique.mockResolvedValue(reviewedPause("lunch"));
    candidateFindMany.mockResolvedValue([storedCandidate(CURRENT_ORIGIN_METHOD)]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await resumeCampaign("camp-1");

    expect(result).toEqual({ ok: true, state: "running" });
    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      inclusions: [expect.objectContaining({ audienceOriginMethod: CURRENT_ORIGIN_METHOD })],
    }));
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "camp-1",
        state: "paused",
        approvedAt: { not: null },
        selectionFingerprint: { not: null },
        decisionHash: { not: null },
        eligibilityPolicyVersion: { not: null },
        westernOnly: { not: null },
      },
      data: { state: "running", pausedAt: null, pauseReason: null },
    });
  });

  it("sets startedAt only when launching an approved pending-launch campaign", async () => {
    const launchAt = new Date("2026-08-09T21:00:00.000Z");
    campaignFindUnique.mockResolvedValue(reviewedPause(PENDING_LAUNCH_PAUSE_REASON, null));
    candidateFindMany.mockResolvedValue([storedCandidate(CURRENT_ORIGIN_METHOD)]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await expect(resumeCampaign("camp-1", {}, launchAt)).resolves.toEqual({
      ok: true,
      state: "running",
    });
    expect(campaignUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        state: "running",
        startedAt: launchAt,
        pausedAt: null,
        pauseReason: null,
      },
    }));
  });

  it("refuses a complete-looking paused campaign whose stored candidate method is missing", async () => {
    campaignFindUnique.mockResolvedValue(reviewedPause("lunch"));
    candidateFindMany.mockResolvedValue([storedCandidate(null)]);
    verifyStoredSelectionSnapshot.mockReturnValue({ ok: false, reason: "snapshot_incomplete" });
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await expect(resumeCampaign("camp-1")).resolves.toEqual({
      ok: false,
      reason: "snapshot_incomplete",
    });
    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      inclusions: [expect.objectContaining({ audienceOriginMethod: null })],
    }));
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  // An automatic stop that any resume could undo is a suggestion, not a stop.
  it("refuses to resume an automatic pause without an acknowledgement", async () => {
    campaignFindUnique.mockResolvedValue(reviewedPause("auto:public_failure_rate"));

    const result = await resumeCampaign("camp-1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("auto_pause_requires_review");
    // Nothing written: the campaign stays stopped.
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("resumes an automatic pause once acknowledged", async () => {
    campaignFindUnique.mockResolvedValue(reviewedPause("auto:uncertain_rate"));
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await resumeCampaign("camp-1", { acknowledgeAutoPause: "reviewed" });

    expect(result).toEqual({ ok: true, state: "running" });
  });

  it("refuses to resume a cancelled campaign", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue({ state: "cancelled" });

    expect(await resumeCampaign("camp-1")).toEqual({
      ok: false,
      reason: "not_resumable_from_cancelled",
    });
  });

  it("refuses to resume a migrated legacy campaign without a reviewed manifest", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused",
      pauseReason: "migration:legacy_unverified_snapshot",
      selectionFingerprint: null,
      decisionHash: null,
      eligibilityPolicyVersion: null,
      westernOnly: null,
    });
    verifyStoredSelectionSnapshot.mockReturnValue({ ok: false, reason: "snapshot_incomplete" });

    await expect(resumeCampaign("camp-1")).resolves.toEqual({
      ok: false,
      reason: "snapshot_incomplete",
    });
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });
});

describe("cancelCampaign", () => {
  it("cancels the campaign and abandons pending candidates together", async () => {
    campaignFindUnique.mockResolvedValue({ state: "running" });
    candidateFindMany.mockResolvedValue(
      Array.from({ length: 42 }, (_, index) => ({
        id: `candidate-${index}`,
        dispatchStartedAt: null,
      })),
    );
    candidateUpdateMany.mockResolvedValue({ count: 42 });

    const result = await cancelCampaign("camp-1", "owner stopped it");

    expect(result).toEqual({
      ok: true,
      state: "cancelled",
      cancelledCandidates: 42,
      inFlightCandidates: 0,
    });
    expect(candidateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outcome: "pending", dispatchStartedAt: null }),
        data: expect.objectContaining({
          outcome: "cancelled",
          suppressionReason: "owner stopped it",
        }),
      }),
    );
  });

  // Those comments are live on Instagram. Rewriting them to cancelled would make the
  // record false.
  it("touches only pending candidates, never sent ones", async () => {
    campaignFindUnique.mockResolvedValue({ state: "running" });
    candidateFindMany.mockResolvedValue([{ id: "pending-1", dispatchStartedAt: null }]);
    candidateUpdateMany.mockResolvedValue({ count: 0 });

    await cancelCampaign("camp-1", "stop");

    const where = candidateUpdateMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ outcome: "pending" });
  });

  it("reports how many candidates were abandoned", async () => {
    campaignFindUnique.mockResolvedValue({ state: "running" });
    candidateFindMany.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => ({
        id: `candidate-${index}`,
        dispatchStartedAt: null,
      })),
    );
    candidateUpdateMany.mockResolvedValue({ count: 7 });

    await cancelCampaign("camp-1", "stop");

    expect(logEvent).toHaveBeenCalledWith("historical_campaign_cancelled", {
      campaignId: "camp-1",
      reason: "stop",
      cancelledCandidates: 7,
      inFlightCandidates: 0,
    });
  });

  it("refuses to cancel an already-completed campaign", async () => {
    campaignFindUnique.mockResolvedValue({ state: "completed" });

    expect(await cancelCampaign("camp-1", "x")).toEqual({
      ok: false,
      reason: "not_cancellable_from_completed",
    });
  });
});

describe("completeCampaignIfDrained", () => {
  // `completed` means it finished its work; `cancelled` means it was stopped.
  // Conflating them would make the outcome data unreadable later.
  it("completes a campaign with nothing pending", async () => {
    campaignFindUnique.mockResolvedValue({ state: "running" });
    candidateCount.mockResolvedValue(0);
    dispatchCount.mockResolvedValue(0);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    expect(await completeCampaignIfDrained("camp-1")).toBe(true);
  });

  it("leaves a campaign alone while candidates remain", async () => {
    campaignFindUnique.mockResolvedValue({ state: "running" });
    candidateCount.mockResolvedValue(5);

    expect(await completeCampaignIfDrained("camp-1")).toBe(false);
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });
});

describe("advanceCampaignStage", () => {
  // Stages exist because this copy has never been seen in the wild: 3 → 25 → 100 →
  // remainder, each gated on the previous stage being clean.
  it("raises the caps on a running campaign", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "running", batchSize: 1, hourlyCap: 3, dailyCap: 10,
    });

    const result = await advanceCampaignStage("camp-1", {
      batchSize: 5, hourlyCap: 10, dailyCap: 25,
    });

    expect(result).toEqual({ ok: true, state: "running" });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { batchSize: 5, hourlyCap: 10, dailyCap: 25 },
    });
  });

  // Lowering a cap would strand candidates the owner already approved without
  // making that visible anywhere.
  it("refuses to lower any cap", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "running", batchSize: 5, hourlyCap: 10, dailyCap: 25,
    });

    const result = await advanceCampaignStage("camp-1", {
      batchSize: 5, hourlyCap: 3, dailyCap: 25,
    });

    expect(result).toEqual({ ok: false, reason: "caps_must_not_decrease" });
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("allows staging a paused campaign so caps are ready on resume", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused", batchSize: 1, hourlyCap: 3, dailyCap: 10,
    });

    const result = await advanceCampaignStage("camp-1", {
      batchSize: 2, hourlyCap: 5, dailyCap: 15,
    });

    expect(result).toEqual({ ok: true, state: "paused" });
  });

  it("allows safe initial caps to replace defaults before the first launch", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused",
      batchSize: 1,
      hourlyCap: 3,
      dailyCap: 10,
      approvedAt: new Date("2026-08-09T20:00:00.000Z"),
      startedAt: null,
      pauseReason: PENDING_LAUNCH_PAUSE_REASON,
    });

    const result = await advanceCampaignStage("camp-1", {
      batchSize: 1,
      hourlyCap: 1,
      dailyCap: 1000,
    });

    expect(result).toEqual({ ok: true, state: "paused" });
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { batchSize: 1, hourlyCap: 1, dailyCap: 1000 },
    });
  });

  it("still refuses lower caps after a paused campaign has launched before", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused",
      batchSize: 2,
      hourlyCap: 5,
      dailyCap: 1000,
      approvedAt: new Date("2026-08-09T20:00:00.000Z"),
      startedAt: new Date("2026-08-09T21:00:00.000Z"),
      pauseReason: "owner_pause",
    });

    await expect(advanceCampaignStage("camp-1", {
      batchSize: 1,
      hourlyCap: 1,
      dailyCap: 1000,
    })).resolves.toEqual({ ok: false, reason: "caps_must_not_decrease" });
  });

  it("refuses to stage a draft that was never approved", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "draft", batchSize: 1, hourlyCap: 3, dailyCap: 10,
    });

    expect(
      await advanceCampaignStage("camp-1", { batchSize: 2, hourlyCap: 5, dailyCap: 15 }),
    ).toEqual({ ok: false, reason: "not_stageable_from_draft" });
  });
});
