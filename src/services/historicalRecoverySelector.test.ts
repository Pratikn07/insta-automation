import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const campaignCreate = vi.fn();
const candidateCreateMany = vi.fn();
const candidateSourceCreateMany = vi.fn();
const exclusionCreateMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      recoveryCampaign: { create: campaignCreate },
      recoveryCandidate: { createMany: candidateCreateMany },
      recoveryCandidateSource: { createMany: candidateSourceCreateMany },
      recoverySelectionExclusion: { createMany: exclusionCreateMany },
    }),
  },
}));

const { selectHistoricalCandidates } = await import("./historicalRecoverySelector.js");

const NOW = new Date("2026-08-12T00:00:00.000Z");
const CANONICAL_GROUP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function eligibleRow() {
  return {
    intentId: "11111111-1111-4111-8111-111111111111",
    igUserId: "person-1",
    keywordId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    commentId: "comment-1",
    mediaId: null,
    triggerKind: "comment",
    commentAt: new Date("2026-08-01T00:00:00.000Z"),
    keywordSnapshot: "SLEEP",
    publicReplyText: "Please DM SLEEP",
    keywordActive: true,
    gateAccepted: true,
    gateExhausted: false,
    recipientUnreachable: false,
    ambiguousPriorSend: false,
    hasEngagementEvidence: false,
    completedSameKeyword: false,
    priorPublicRecovery: false,
    supersededByNewerJourney: false,
    audienceOrigin: "other",
    audienceOriginConfidence: "high",
    audienceOriginMethod: "llm_v3",
    audienceSegment: "other" as const,
    sources: [{
      commentId: "comment-1",
      mediaId: null,
      receivedAt: new Date("2026-08-01T00:00:00.000Z"),
    }],
  };
}

function select(rolloutGroupId: string) {
  return selectHistoricalCandidates({
    phase: "unknown_read_pilot",
    selectionVersion: "uuid-normalization-test",
    copyVersion: "recovery-v2",
    westernOnly: false,
    holdoutPercent: 0,
    eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
    audienceSegment: "other",
    rolloutGroupId,
    rolloutGroupHourlyCap: 2,
    persist: true,
    now: NOW,
  });
}

beforeEach(() => {
  for (const fn of [
    queryRaw,
    campaignCreate,
    candidateCreateMany,
    candidateSourceCreateMany,
    exclusionCreateMany,
  ]) fn.mockReset();
  queryRaw.mockResolvedValue([eligibleRow()]);
  campaignCreate.mockResolvedValue({});
  candidateCreateMany.mockResolvedValue({ count: 1 });
  candidateSourceCreateMany.mockResolvedValue({ count: 1 });
  exclusionCreateMany.mockResolvedValue({ count: 0 });
});

describe("expanded rollout-group selection", () => {
  it("hashes and persists equivalent UUID spellings as one canonical representation", async () => {
    const fingerprints: string[] = [];
    const decisionHashes: string[] = [];

    for (const representation of [
      CANONICAL_GROUP_ID,
      CANONICAL_GROUP_ID.toUpperCase(),
      `{${CANONICAL_GROUP_ID.toUpperCase()}}`,
      CANONICAL_GROUP_ID.replaceAll("-", "").toUpperCase(),
    ]) {
      const report = await select(representation);
      fingerprints.push(report.selectionFingerprint);
      decisionHashes.push(report.decisionHash);
      expect(campaignCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ rolloutGroupId: CANONICAL_GROUP_ID }),
      }));
    }

    expect(new Set(fingerprints)).toEqual(new Set([fingerprints[0]]));
    expect(new Set(decisionHashes)).toEqual(new Set([decisionHashes[0]]));
  });

  it("rejects an invalid rollout UUID before reading or writing the database", async () => {
    await expect(select("not-a-uuid")).rejects.toThrow("invalid_rollout_group_id");
    expect(queryRaw).not.toHaveBeenCalled();
    expect(campaignCreate).not.toHaveBeenCalled();
  });
});
