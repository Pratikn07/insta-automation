import { describe, it, expect, vi, beforeEach } from "vitest";

const campaignUpdateMany = vi.fn();
const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const campaignUpdate = vi.fn();
const candidateUpdateMany = vi.fn();
const candidateFindMany = vi.fn();
const candidateCount = vi.fn();
const controlUpsert = vi.fn();
const dispatchFindMany = vi.fn();
const dispatchUpdateMany = vi.fn();
const dispatchCount = vi.fn();
const queryRaw = vi.fn();
const logEvent = vi.fn();

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

const {
  approveCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  completeCampaignIfDrained,
  advanceCampaignStage,
} = await import("./recoveryCampaignControl.js");

beforeEach(() => {
  for (const fn of [
    campaignUpdateMany, campaignFindUnique, campaignFindMany, campaignUpdate,
    candidateUpdateMany, candidateFindMany, candidateCount, controlUpsert,
    dispatchFindMany, dispatchUpdateMany, dispatchCount, queryRaw, logEvent,
  ]) {
    fn.mockReset();
  }
  logEvent.mockResolvedValue(undefined);
  queryRaw.mockResolvedValue([]);
  controlUpsert.mockResolvedValue({ id: 1 });
  candidateFindMany.mockResolvedValue([]);
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

describe("resumeCampaign", () => {
  // Approval is already on the row, so resuming does not re-ask for it — but the
  // query still requires approvedAt, making that invariant explicit.
  it("resumes only a paused, already-approved campaign", async () => {
    // Resume now reads the row first, to tell an automatic pause from an owner's (QA-13).
    campaignFindUnique.mockResolvedValue({ state: "paused", pauseReason: "lunch" });
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await resumeCampaign("camp-1");

    expect(result).toEqual({ ok: true, state: "running" });
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: "camp-1", state: "paused", approvedAt: { not: null } },
      data: { state: "running", pausedAt: null, pauseReason: null },
    });
  });

  // An automatic stop that any resume could undo is a suggestion, not a stop.
  it("refuses to resume an automatic pause without an acknowledgement", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused",
      pauseReason: "auto:public_failure_rate",
    });

    const result = await resumeCampaign("camp-1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("auto_pause_requires_review");
    // Nothing written: the campaign stays stopped.
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("resumes an automatic pause once acknowledged", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "paused",
      pauseReason: "auto:uncertain_rate",
    });
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

  it("refuses to stage a draft that was never approved", async () => {
    campaignFindUnique.mockResolvedValue({
      state: "draft", batchSize: 1, hourlyCap: 3, dailyCap: 10,
    });

    expect(
      await advanceCampaignStage("camp-1", { batchSize: 2, hourlyCap: 5, dailyCap: 15 }),
    ).toEqual({ ok: false, reason: "not_stageable_from_draft" });
  });
});
