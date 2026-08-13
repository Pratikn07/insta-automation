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
const igUserFindMany = vi.fn();
const controlUpsert = vi.fn();
const dispatchFindMany = vi.fn();
const dispatchUpdateMany = vi.fn();
const dispatchCount = vi.fn();
const queryRaw = vi.fn();
const eventLogCreate = vi.fn();
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
        igUser: { findMany: igUserFindMany },
        dmRecoveryControl: { upsert: controlUpsert },
        publicRecoveryDispatch: {
          findMany: dispatchFindMany,
          updateMany: dispatchUpdateMany,
          count: dispatchCount,
        },
        eventLog: { create: eventLogCreate },
        $queryRaw: queryRaw,
      }),
  },
}));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("./historicalRecoverySnapshot.js", () => ({ verifyStoredSelectionSnapshot }));

const {
  approveCampaign,
  approveCampaignGroup,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  resumeCampaignGroup,
  cancelCampaign,
  completeCampaignIfDrained,
  advanceCampaignStage,
  PENDING_LAUNCH_PAUSE_REASON,
} = await import("./recoveryCampaignControl.js");

beforeEach(() => {
  for (const fn of [
    campaignUpdateMany, campaignFindUnique, campaignFindMany, campaignUpdate,
    candidateUpdateMany, candidateFindMany, candidateCount, controlUpsert,
    dispatchFindMany, dispatchUpdateMany, dispatchCount, exclusionFindMany, igUserFindMany,
    queryRaw, eventLogCreate, logEvent, verifyStoredSelectionSnapshot,
  ]) {
    fn.mockReset();
  }
  logEvent.mockResolvedValue(undefined);
  eventLogCreate.mockResolvedValue({ id: "event-1" });
  queryRaw.mockResolvedValue([]);
  controlUpsert.mockResolvedValue({ id: 1 });
  candidateFindMany.mockResolvedValue([]);
  exclusionFindMany.mockResolvedValue([]);
  igUserFindMany.mockResolvedValue([]);
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

describe("atomic expanded rollout group transitions", () => {
  const rolloutGroupId = "11111111-1111-4111-8111-111111111111";
  const campaigns = [
    { id: "22222222-2222-4222-8222-222222222221", segment: "other" as const, decisionHash: "d".repeat(64) },
    { id: "22222222-2222-4222-8222-222222222222", segment: "unknown_cue" as const, decisionHash: "d".repeat(64) },
  ];
  const stored = (
    segment: "other" | "unknown_cue",
    state = "draft",
    startedAt: Date | null = null,
  ) => ({
    state,
    approvedBy: state === "paused" ? "owner@example.test" : null,
    approvedAt: state === "paused" ? new Date("2026-08-12T00:00:00.000Z") : null,
    pauseReason: state === "paused" ? PENDING_LAUNCH_PAUSE_REASON : null,
    startedAt,
    candidateCount: 1,
    excludedCount: 0,
    decisionHash: "d".repeat(64),
    phase: "unknown_read_pilot",
    selectionVersion: "v1-canonical-intents-expanded-audience",
    sourceDataCutoff: new Date("2026-08-01T00:00:00.000Z"),
    commentFrom: null,
    commentTo: new Date("2026-08-04T00:00:00.000Z"),
    selectionLimit: null,
    holdoutPercent: 0,
    copyVersion: "recovery-v2",
    batchSize: 1,
    hourlyCap: 10,
    dailyCap: 1000,
    selectionFingerprint: "f".repeat(64),
    eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
    westernOnly: false,
    inboundWindowHours: 24,
    completionWindowHours: 48,
    audienceSegment: segment,
    rolloutGroupId,
    rolloutGroupHourlyCap: 10,
  });
  const candidate = (index: number, segment: "other" | "unknown_cue") => ({
    selectionPosition: 0,
    intentId: `intent-${index}`,
    igUserId: `person-${index}`,
    conversationId: null,
    keywordId: `keyword-${index}`,
    commentId: `comment-${index}`,
    mediaId: null,
    commentAt: new Date("2026-08-01T00:00:00.000Z"),
    keywordSnapshot: "SLEEP",
    publicReplyText: "DM @tinysoho SLEEP",
    evidence: "gate_sent_no_read",
    audienceOrigin: segment === "other" ? "other" : "unknown",
    audienceOriginMethod: CURRENT_ORIGIN_METHOD,
    audienceOriginConfidence: "low",
    audienceSegment: segment,
    arm: "treatment",
    sourceChoiceReason: "newest_eligible_comment",
    sources: [{
      position: 0,
      commentId: `comment-${index}`,
      mediaId: null,
      receivedAt: new Date("2026-08-01T00:00:00.000Z"),
      choiceReason: "newest_eligible_comment",
    }],
  });

  function arrangeGroup(state = "draft") {
    candidateUpdateMany.mockResolvedValue({ count: 0 });
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(campaigns.map(({ id }) => ({ id, state })));
    campaignFindUnique
      .mockResolvedValueOnce(stored("other", state))
      .mockResolvedValueOnce(stored("unknown_cue", state));
    candidateFindMany
      .mockResolvedValueOnce([candidate(1, "other")])
      .mockResolvedValueOnce([candidate(2, "unknown_cue")]);
    igUserFindMany.mockResolvedValue([
      { id: "person-1", username: "alex", name: "Alex", audienceSegment: "other", inferredOrigin: "other", originMethod: CURRENT_ORIGIN_METHOD, originConfidence: "low" },
      { id: "person-2", username: "sam", name: "Sam", audienceSegment: "unknown_cue", inferredOrigin: "unknown", originMethod: CURRENT_ORIGIN_METHOD, originConfidence: "low" },
    ]);
  }

  it("verifies every campaign before making the single atomic group approval write", async () => {
    arrangeGroup();
    verifyStoredSelectionSnapshot
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, reason: "snapshot_hash_mismatch" });

    await expect(approveCampaignGroup({
      rolloutGroupId,
      campaigns,
      selectorPhase: "unknown_read_pilot",
      approvedBy: "owner@example.test",
    })).resolves.toEqual({ ok: false, reason: "snapshot_hash_mismatch" });

    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledTimes(2);
    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("binds atomic approval to the selector's exact saved decision hashes", async () => {
    arrangeGroup();

    await expect(approveCampaignGroup({
      rolloutGroupId,
      campaigns: campaigns.map((campaign, index) => index === 1
        ? { ...campaign, decisionHash: "e".repeat(64) }
        : campaign),
      selectorPhase: "unknown_read_pilot",
      approvedBy: "owner@example.test",
    })).resolves.toEqual({ ok: false, reason: "expanded_group_audit_failed" });

    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("approves all exact members together after the complete group passes", async () => {
    arrangeGroup();
    campaignUpdateMany.mockResolvedValue({ count: 2 });

    await expect(approveCampaignGroup({
      rolloutGroupId,
      campaigns,
      selectorPhase: "unknown_read_pilot",
      approvedBy: "owner@example.test",
    }, new Date("2026-08-12T01:00:00.000Z"))).resolves.toEqual({
      ok: true,
      state: "paused",
      campaignIds: campaigns.map(({ id }) => id),
    });
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: campaigns.map(({ id }) => id) }, state: { in: ["draft", "awaiting_approval"] } },
      data: {
        state: "paused",
        approvedBy: "owner@example.test",
        approvedAt: new Date("2026-08-12T01:00:00.000Z"),
        startedAt: null,
        pausedAt: new Date("2026-08-12T01:00:00.000Z"),
        pauseReason: PENDING_LAUNCH_PAUSE_REASON,
        endedAt: null,
      },
    });
  });

  it("resumes the exact approved group atomically after re-verifying every snapshot", async () => {
    arrangeGroup("paused");
    campaignUpdateMany.mockResolvedValue({ count: 2 });

    await expect(resumeCampaignGroup({
      rolloutGroupId,
      campaigns,
      selectorPhase: "unknown_read_pilot",
    }, new Date("2026-08-12T02:00:00.000Z"))).resolves.toEqual({
      ok: true,
      state: "running",
      campaignIds: campaigns.map(({ id }) => id),
    });
    expect(verifyStoredSelectionSnapshot).toHaveBeenCalledTimes(2);
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing launch timestamp when atomically resuming a mixed paused group", async () => {
    const originalStart = new Date("2026-08-11T23:00:00.000Z");
    const resumedAt = new Date("2026-08-12T02:00:00.000Z");
    candidateUpdateMany.mockResolvedValue({ count: 0 });
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(campaigns.map(({ id }) => ({ id, state: "paused" })));
    campaignFindUnique
      .mockResolvedValueOnce(stored("other", "paused", null))
      .mockResolvedValueOnce(stored("unknown_cue", "paused", originalStart));
    candidateFindMany
      .mockResolvedValueOnce([candidate(1, "other")])
      .mockResolvedValueOnce([candidate(2, "unknown_cue")]);
    igUserFindMany.mockResolvedValue([
      { id: "person-1", username: "alex", name: "Alex", audienceSegment: "other", inferredOrigin: "other", originMethod: CURRENT_ORIGIN_METHOD, originConfidence: "low" },
      { id: "person-2", username: "sam", name: "Sam", audienceSegment: "unknown_cue", inferredOrigin: "unknown", originMethod: CURRENT_ORIGIN_METHOD, originConfidence: "low" },
    ]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await expect(resumeCampaignGroup({
      rolloutGroupId,
      campaigns,
      selectorPhase: "unknown_read_pilot",
    }, resumedAt)).resolves.toMatchObject({ ok: true, state: "running" });

    expect(campaignUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: [campaigns[0]!.id] },
        state: "paused",
        approvedAt: { not: null },
        startedAt: null,
      },
      data: { state: "running", startedAt: resumedAt, pausedAt: null, pauseReason: null },
    });
    expect(campaignUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: [campaigns[1]!.id] },
        state: "paused",
        approvedAt: { not: null },
        startedAt: { not: null },
      },
      data: { state: "running", pausedAt: null, pauseReason: null },
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
    expect(eventLogCreate).toHaveBeenCalledTimes(1);
    expect(eventLogCreate).toHaveBeenCalledWith({
      data: {
        kind: "historical_campaign_group_paused",
        payload: {
          rolloutGroupId,
          reason: "owner emergency stop",
          pausedCampaignIds: ["11111111-1111-4111-8111-111111111112"],
          skipped: [
            { campaignId: "22222222-2222-4222-8222-222222222222", state: "completed" },
            { campaignId: "33333333-3333-4333-8333-333333333333", state: "paused" },
          ],
        },
      },
    });
    expect(logEvent).not.toHaveBeenCalledWith(
      "historical_campaign_group_paused",
      expect.anything(),
    );
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
    expect(eventLogCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown valid group before updating or auditing", async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(pauseCampaignGroup(rolloutGroupId, "stop")).rejects.toMatchObject({
      code: "campaign_group_not_found",
    });

    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(eventLogCreate).not.toHaveBeenCalled();
  });

  it("propagates an audit failure so the transaction rolls back the pause", async () => {
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "11111111-1111-4111-8111-111111111112", state: "running" },
      ]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });
    eventLogCreate.mockRejectedValue(new Error("audit unavailable"));

    await expect(pauseCampaignGroup(rolloutGroupId, "stop")).rejects.toThrow(
      "audit unavailable",
    );
    expect(campaignUpdateMany).toHaveBeenCalledOnce();
    expect(eventLogCreate).toHaveBeenCalledOnce();
    expect(logEvent).not.toHaveBeenCalledWith(
      "historical_campaign_group_paused",
      expect.anything(),
    );
  });

  it("rejects a pause-count mismatch before writing the audit", async () => {
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "11111111-1111-4111-8111-111111111112", state: "running" },
      ]);
    campaignUpdateMany.mockResolvedValue({ count: 0 });

    await expect(pauseCampaignGroup(rolloutGroupId, "stop")).rejects.toThrow(
      "campaign_group_pause_count_mismatch",
    );
    expect(eventLogCreate).not.toHaveBeenCalled();
  });

  it("writes one durable audit for each successful owner retry", async () => {
    const campaignId = "11111111-1111-4111-8111-111111111112";
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: campaignId, state: "running" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: campaignId, state: "paused" }]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await pauseCampaignGroup(rolloutGroupId, "stop");
    await pauseCampaignGroup(rolloutGroupId, "stop");

    expect(eventLogCreate).toHaveBeenCalledTimes(2);
    expect(eventLogCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { payload: { pausedCampaignIds: [campaignId], skipped: [] } },
    });
    expect(eventLogCreate.mock.calls[1]?.[0]).toMatchObject({
      data: {
        payload: {
          pausedCampaignIds: [],
          skipped: [{ campaignId, state: "paused" }],
        },
      },
    });
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
