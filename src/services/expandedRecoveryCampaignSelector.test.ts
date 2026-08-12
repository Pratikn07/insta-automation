import { beforeEach, describe, expect, it, vi } from "vitest";

const selectHistoricalCandidates = vi.fn();
const candidateFindMany = vi.fn();
const transactionClient = {
  recoveryCandidate: { findMany: candidateFindMany },
};
const $transaction = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { $transaction },
}));

vi.mock("./historicalRecoverySelector.js", () => ({
  selectHistoricalCandidates,
}));

const { selectExpandedRecoveryCampaigns } = await import("./expandedRecoveryCampaignSelector.js");

const NOW = new Date("2026-08-12T00:00:00.000Z");
const COMMENT_TO = new Date("2026-08-05T00:00:00.000Z");

function selectionReport(segment: string, candidateCount = 2) {
  return {
    campaignId: candidateCount === 0 ? null : `campaign-${segment}`,
    selectionFingerprint: `fingerprint-${segment}`,
    decisionHash: `decision-${segment}`,
    sourceDataCutoff: NOW,
    rawIntents: candidateCount + 3,
    eligible: candidateCount,
    eligiblePeople: candidateCount,
    excludedPeople: 3,
    byEvidence: {},
    originBreakdown: {},
    excludedByReason: { audience_segment_mismatch: 3 },
  };
}

beforeEach(() => {
  selectHistoricalCandidates.mockReset();
  candidateFindMany.mockReset();
  $transaction.mockReset();
  $transaction.mockImplementation(async (callback: (tx: typeof transactionClient) => unknown) =>
    callback(transactionClient));
  candidateFindMany.mockResolvedValue([]);
  selectHistoricalCandidates.mockImplementation(async (input: { audienceSegment: string }) =>
    selectionReport(input.audienceSegment));
});

describe("selectExpandedRecoveryCampaigns", () => {
  it("creates four segment drafts with one cutoff and rollout group", async () => {
    const result = await selectExpandedRecoveryCampaigns({
      phase: "unknown_read_pilot",
      selectionVersion: "expanded-v1",
      copyVersion: "recovery-v2",
      westernOnly: true,
      commentTo: COMMENT_TO,
      now: NOW,
    });

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 60_000,
    });
    expect(selectHistoricalCandidates).toHaveBeenCalledTimes(4);

    const calls = selectHistoricalCandidates.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.audienceSegment)).toEqual([
      "other",
      "unknown_cue",
      "unknown_generic",
      "unknown_no_name",
    ]);
    expect(calls.map((input) => input.rolloutGroupId)).toEqual([
      result.rolloutGroupId,
      result.rolloutGroupId,
      result.rolloutGroupId,
      result.rolloutGroupId,
    ]);
    expect(result.rolloutGroupId).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    );
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        now: NOW,
        commentTo: COMMENT_TO,
        persist: true,
        holdoutPercent: 0,
        dailyCap: 1000,
        eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
        rolloutGroupHourlyCap: 10,
        transaction: transactionClient,
      }),
    ]));
    expect(candidateFindMany).toHaveBeenCalledWith({
      where: { campaign: { rolloutGroupId: result.rolloutGroupId } },
      select: { igUserId: true },
    });
    expect(result).toMatchObject({
      campaigns: [
        { segment: "other", campaignId: "campaign-other", candidateCount: 2 },
        { segment: "unknown_cue", campaignId: "campaign-unknown_cue", candidateCount: 2 },
        { segment: "unknown_generic", campaignId: "campaign-unknown_generic", candidateCount: 2 },
        { segment: "unknown_no_name", campaignId: "campaign-unknown_no_name", candidateCount: 2 },
      ],
      excludedPeople: 12,
    });
  });

  it("reports empty segments without creating an empty campaign", async () => {
    selectHistoricalCandidates.mockImplementation(async (input: { audienceSegment: string }) =>
      selectionReport(input.audienceSegment, input.audienceSegment === "unknown_generic" ? 0 : 2));

    const result = await selectExpandedRecoveryCampaigns({
      phase: "unknown_read_pilot",
      selectionVersion: "expanded-v1",
      copyVersion: "recovery-v2",
      westernOnly: true,
      commentTo: COMMENT_TO,
      now: NOW,
    });

    expect(result.campaigns.find((campaign) => campaign.segment === "unknown_generic")).toMatchObject({
      segment: "unknown_generic",
      campaignId: null,
      candidateCount: 0,
      decisionHash: "decision-unknown_generic",
      excludedPeople: 3,
    });
  });

  it("aborts the draft transaction when a person is persisted in more than one campaign", async () => {
    candidateFindMany.mockResolvedValue([
      { igUserId: "ig-duplicate" },
      { igUserId: "ig-duplicate" },
    ]);

    await expect(selectExpandedRecoveryCampaigns({
      phase: "unknown_read_pilot",
      selectionVersion: "expanded-v1",
      copyVersion: "recovery-v2",
      westernOnly: true,
      commentTo: COMMENT_TO,
      now: NOW,
    })).rejects.toThrow("expanded_recovery_rollout_group_duplicate_ig_user_id: ig-duplicate");

    expect(selectHistoricalCandidates).toHaveBeenCalledTimes(4);
  });
});
