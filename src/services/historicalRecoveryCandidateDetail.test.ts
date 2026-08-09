import { beforeEach, describe, expect, it, vi } from "vitest";

const candidateFindUnique = vi.fn();
const reelFindUnique = vi.fn();
const feedFindUnique = vi.fn();
const eventFindMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCandidate: { findUnique: candidateFindUnique },
    reelMeta: { findUnique: reelFindUnique },
    feedPostMeta: { findUnique: feedFindUnique },
    eventLog: { findMany: eventFindMany },
  },
}));

const { historicalCandidateDetail } = await import("./historicalRecoveryCandidateDetail.js");

const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const CANONICAL_CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ALIAS_ID = "44444444-4444-4444-8444-444444444444";

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
    campaignId: "11111111-1111-4111-8111-111111111111",
    campaignPhase: "unknown_read_pilot",
    intentId: "55555555-5555-4555-8555-555555555555",
    igUserId: "ig-1",
    conversationId: CANONICAL_CONVERSATION_ID,
    keywordId: "66666666-6666-4666-8666-666666666666",
    commentId: "comment-1",
    mediaId: "media-1",
    commentAt: new Date("2026-06-25T10:00:00.000Z"),
    keywordSnapshot: "SLEEP",
    publicReplyText: "I sent your guide.",
    evidence: "gate_sent_no_read",
    audienceOrigin: "us_western",
    audienceOriginConfidence: "high",
    arm: "treatment",
    outcome: "send_uncertain",
    attempts: 1,
    lastAttemptAt: new Date("2026-08-08T18:00:00.000Z"),
    sentAt: null,
    publicReplyId: null,
    suppressionReason: "missing_reply_id",
    reviewedAt: null,
    laterInboundAt: null,
    laterCompletedAt: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-08T18:00:00.000Z"),
    campaign: {
      id: "11111111-1111-4111-8111-111111111111",
      phase: "unknown_read_pilot",
      state: "running",
      selectionVersion: "selection-v2",
      copyVersion: "recovery-v2",
      sourceDataCutoff: new Date("2026-08-01T00:00:00.000Z"),
    },
    keyword: {
      id: "66666666-6666-4666-8666-666666666666",
      keyword: "SLEEP",
      mediaPermalink: "https://www.instagram.com/p/keyword-source/",
    },
    intent: {
      id: "55555555-5555-4555-8555-555555555555",
      igUserId: "ig-1",
      windowStartedAt: new Date("2026-06-25T10:00:00.000Z"),
      lastTriggerAt: new Date("2026-06-25T10:05:00.000Z"),
      windowExpiresAt: new Date("2026-06-27T10:05:00.000Z"),
      reconciledState: "canonical",
      completedAt: null,
      keyword: { id: "66666666-6666-4666-8666-666666666666", keyword: "SLEEP" },
      canonicalConversation: {
        id: CANONICAL_CONVERSATION_ID,
        state: "expired",
        createdAt: new Date("2026-06-25T10:00:00.000Z"),
        reconciliationReason: "oldest_valid_owner",
      },
      aliasConversations: [
        {
          id: ALIAS_ID,
          state: "expired",
          createdAt: new Date("2026-06-25T10:03:00.000Z"),
          reconciliationReason: "duplicate_inside_window",
        },
      ],
      triggers: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          conversationId: CANONICAL_CONVERSATION_ID,
          receivedAt: new Date("2026-06-25T10:00:00.000Z"),
          triggerKind: "comment",
          disposition: "new_journey",
          sourceEvent: { commentId: "comment-1", mediaId: "media-1" },
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [candidateFindUnique, reelFindUnique, feedFindUnique, eventFindMany]) {
    fn.mockReset();
  }
  candidateFindUnique.mockResolvedValue(candidateRow());
  reelFindUnique.mockResolvedValue({
    permalink: "https://www.instagram.com/reel/verified-source/",
  });
  feedFindUnique.mockResolvedValue({ permalink: "https://www.instagram.com/p/feed-source/" });
  eventFindMany.mockResolvedValue([
    {
      id: "88888888-8888-4888-8888-888888888888",
      kind: "historical_recovery_reviewed",
      payload: {
        candidateId: CANDIDATE_ID,
        actor: "owner@example.com",
        action: "mark_reviewed",
        access_token: "must-not-leak",
        providerRaw: { secret: "must-not-leak" },
      },
      createdAt: new Date("2026-08-08T19:00:00.000Z"),
    },
  ]);
});

describe("historicalCandidateDetail", () => {
  it("returns canonical lineage and allow-listed audit evidence", async () => {
    const detail = await historicalCandidateDetail(CANDIDATE_ID);

    expect(detail?.intent.canonicalConversation?.id).toBe(CANONICAL_CONVERSATION_ID);
    expect(detail?.intent.aliasConversations.map((row) => row.id)).toEqual([ALIAS_ID]);
    expect(detail?.intent.triggers.map((row) => row.commentId)).toEqual(["comment-1"]);
    expect(detail?.auditEvents[0]).toEqual({
      id: "88888888-8888-4888-8888-888888888888",
      kind: "historical_recovery_reviewed",
      actor: "owner@example.com",
      action: "mark_reviewed",
      reason: null,
      category: null,
      createdAt: "2026-08-08T19:00:00.000Z",
    });
    expect(JSON.stringify(detail)).not.toMatch(/access_token|providerRaw|must-not-leak/i);
  });

  it("prefers a stored Reel permalink", async () => {
    const detail = await historicalCandidateDetail(CANDIDATE_ID);
    expect(detail?.mediaPermalink).toBe("https://www.instagram.com/reel/verified-source/");
  });

  it("falls back from Reel to Feed to Keyword permalinks", async () => {
    reelFindUnique.mockResolvedValue(null);
    expect((await historicalCandidateDetail(CANDIDATE_ID))?.mediaPermalink).toBe(
      "https://www.instagram.com/p/feed-source/",
    );

    feedFindUnique.mockResolvedValue(null);
    expect((await historicalCandidateDetail(CANDIDATE_ID))?.mediaPermalink).toBe(
      "https://www.instagram.com/p/keyword-source/",
    );
  });

  it("returns null rather than fabricating a source URL", async () => {
    candidateFindUnique.mockResolvedValue(
      candidateRow({
        keyword: {
          id: "66666666-6666-4666-8666-666666666666",
          keyword: "SLEEP",
          mediaPermalink: null,
        },
      }),
    );
    reelFindUnique.mockResolvedValue(null);
    feedFindUnique.mockResolvedValue(null);

    expect((await historicalCandidateDetail(CANDIDATE_ID))?.mediaPermalink).toBeNull();
  });

  it("returns null for an unknown candidate", async () => {
    candidateFindUnique.mockResolvedValue(null);
    expect(await historicalCandidateDetail(CANDIDATE_ID)).toBeNull();
  });
});
