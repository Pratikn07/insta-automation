import { describe, it, expect, vi, beforeEach } from "vitest";

const campaignUpdateMany = vi.fn();
const campaignFindUnique = vi.fn();
const campaignUpdate = vi.fn();
const candidateUpdateMany = vi.fn();
const candidateCount = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCampaign: {
      updateMany: campaignUpdateMany,
      findUnique: campaignFindUnique,
      update: campaignUpdate,
    },
    recoveryCandidate: { updateMany: candidateUpdateMany, count: candidateCount },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        recoveryCampaign: { updateMany: campaignUpdateMany },
        recoveryCandidate: { updateMany: candidateUpdateMany },
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
    campaignUpdateMany, campaignFindUnique, campaignUpdate,
    candidateUpdateMany, candidateCount, logEvent,
  ]) {
    fn.mockReset();
  }
  logEvent.mockResolvedValue(undefined);
});

describe("approveCampaign", () => {
  // Approval is the moment public comments become possible, so it must record who
  // and when — chk_campaign_approval_complete requires both together.
  it("records the approver and starts the campaign running", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await approveCampaign("camp-1", "pratik");

    expect(result).toEqual({ ok: true, state: "running" });
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: "camp-1", state: { in: ["draft", "awaiting_approval"] } },
      data: {
        state: "running",
        approvedBy: "pratik",
        approvedAt: expect.any(Date),
        startedAt: expect.any(Date),
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
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await approveCampaign("camp-1", "pratik");

    expect(logEvent).toHaveBeenCalledWith("historical_campaign_approved", {
      campaignId: "camp-1",
      approvedBy: "pratik",
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
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    const result = await resumeCampaign("camp-1");

    expect(result).toEqual({ ok: true, state: "running" });
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: "camp-1", state: "paused", approvedAt: { not: null } },
      data: { state: "running", pausedAt: null, pauseReason: null },
    });
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
    campaignUpdateMany.mockResolvedValue({ count: 1 });
    candidateUpdateMany.mockResolvedValue({ count: 42 });

    const result = await cancelCampaign("camp-1", "owner stopped it");

    expect(result).toEqual({ ok: true, state: "cancelled" });
    expect(candidateUpdateMany).toHaveBeenCalledWith({
      where: { campaignId: "camp-1", outcome: "pending" },
      data: { outcome: "cancelled", suppressionReason: "owner stopped it" },
    });
  });

  // Those comments are live on Instagram. Rewriting them to cancelled would make the
  // record false.
  it("touches only pending candidates, never sent ones", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 1 });
    candidateUpdateMany.mockResolvedValue({ count: 0 });

    await cancelCampaign("camp-1", "stop");

    const where = candidateUpdateMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ outcome: "pending" });
  });

  it("reports how many candidates were abandoned", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 1 });
    candidateUpdateMany.mockResolvedValue({ count: 7 });

    await cancelCampaign("camp-1", "stop");

    expect(logEvent).toHaveBeenCalledWith("historical_campaign_cancelled", {
      campaignId: "camp-1",
      reason: "stop",
      cancelledCandidates: 7,
    });
  });

  it("refuses to cancel an already-completed campaign", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
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
    candidateCount.mockResolvedValue(0);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    expect(await completeCampaignIfDrained("camp-1")).toBe(true);
  });

  it("leaves a campaign alone while candidates remain", async () => {
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
