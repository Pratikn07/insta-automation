import { describe, expect, it, vi } from "vitest";
import {
  authorizeGuideAudienceTimeoutRecovery,
  buildGuideAudienceTimeoutRecoveryPlan,
  executeGuideAudienceTimeoutRecovery,
  type AudienceTimeoutRecoveryCandidate,
  type RecoveryAuthorization,
} from "./guideAudienceTimeoutRecovery.js";

const NOW = new Date("2026-09-24T04:00:00.000Z");
const RECEIVED_AT = new Date("2026-09-24T03:00:00.000Z");

function candidate(
  overrides: Partial<AudienceTimeoutRecoveryCandidate> = {},
): AudienceTimeoutRecoveryCandidate {
  return {
    decisionId: "decision-1",
    commentId: "comment-1",
    igUserId: "ig-user-1",
    mediaId: "media-1",
    text: "SLEEP",
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function enforcedAllow(origin: "unknown" | "other" | "us_western" = "unknown"): RecoveryAuthorization {
  return {
    kind: "allow",
    enforced: true,
    classification: {
      id: "classification-1",
      igUserId: "ig-user-1",
      identityHash: "a".repeat(64),
      origin,
      confidence: "low",
      evidence: "generic handle, no cue",
      provider: "nvidia",
      modelId: "test-model",
      method: "nvidia_guide_audience_v1",
      classifiedAt: NOW,
    },
  };
}

async function planFor(
  candidates: AudienceTimeoutRecoveryCandidate[] = [candidate()],
  overrides: Parameters<typeof buildGuideAudienceTimeoutRecoveryPlan>[1] = {},
) {
  return buildGuideAudienceTimeoutRecoveryPlan(candidates, {
    now: () => NOW,
    resolveKeyword: vi.fn().mockResolvedValue({
      keywordId: "keyword-1",
      resourceId: "resource-1",
      mediaId: "media-1",
      mode: "post_strict",
    }),
    hasOpenJourney: vi.fn().mockResolvedValue(false),
    ...overrides,
  });
}

describe("guide audience timeout recovery planning", () => {
  it("selects only a live, exact post-scoped match and never falls back to another post", async () => {
    const resolveKeyword = vi.fn()
      .mockResolvedValueOnce({
        keywordId: "keyword-1",
        resourceId: "resource-1",
        mediaId: "media-1",
        mode: "post_strict",
      })
      .mockResolvedValueOnce({
        keywordId: "keyword-global",
        resourceId: "resource-global",
        mediaId: null,
        mode: "global_fallback",
      });

    const plan = await planFor([
      candidate(),
      candidate({ decisionId: "decision-2", commentId: "comment-2", mediaId: "media-2" }),
      candidate({
        decisionId: "decision-3",
        commentId: "comment-3",
        receivedAt: new Date("2026-09-23T03:00:00.000Z"),
      }),
    ], { resolveKeyword });

    expect(plan.candidates).toEqual([
      expect.objectContaining({
        decisionId: "decision-1",
        commentId: "comment-1",
        keywordId: "keyword-1",
        resourceId: "resource-1",
      }),
    ]);
    expect(plan.excluded).toEqual({
      comment_window_closed: 1,
      not_exact_post_scoped_match: 1,
    });
    expect(plan.cohortHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("removes a person with an already-open journey for the same guide before classification", async () => {
    const authorize = vi.fn();
    const plan = await planFor([candidate()], {
      hasOpenJourney: vi.fn().mockResolvedValue(true),
    });

    const authorized = await authorizeGuideAudienceTimeoutRecovery(plan, { authorize });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.excluded).toEqual({ active_same_guide_journey: 1 });
    expect(authorized.candidates).toHaveLength(0);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("guide audience timeout recovery authorization", () => {
  it.each([
    ["high", "block"],
    ["low", "block"],
    ["deferred", "defer"],
  ] as const)("does not select a %s safety outcome for a gated DM", async (_label, outcome) => {
    const plan = await planFor();
    const authorize = vi.fn().mockResolvedValue(
      outcome === "block"
        ? {
            kind: "block",
            auditId: "audit-1",
            classification: { ...enforcedAllow().classification, origin: "south_asian" },
          }
        : { kind: "defer", auditId: "audit-1", reason: "provider_timeout" },
    );

    const authorized = await authorizeGuideAudienceTimeoutRecovery(plan, { authorize });

    expect(authorized.candidates).toHaveLength(0);
    expect(authorized.excluded).toEqual(
      outcome === "block" ? { audience_blocked: 1 } : { audience_deferred_provider_timeout: 1 },
    );
    expect(authorize).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      source: "redelivery",
      commentId: "comment-1",
      resourceId: "resource-1",
    });
  });

  it("refuses to proceed if recovery authorization was accidentally disabled", async () => {
    const plan = await planFor();

    await expect(
      authorizeGuideAudienceTimeoutRecovery(plan, {
        authorize: vi.fn().mockResolvedValue({ kind: "allow", enforced: false }),
      }),
    ).rejects.toThrow("recovery audience authorization was not enforced");
  });
});

describe("guide audience timeout recovery execution", () => {
  it("sends only the original comment's gated DM, paired with its original guide", async () => {
    const plan = await planFor();
    const authorized = await authorizeGuideAudienceTimeoutRecovery(plan, {
      authorize: vi.fn().mockResolvedValue(enforcedAllow()),
    });
    const openJourney = vi.fn().mockResolvedValue({
      disposition: "new_journey",
      conversationId: "conversation-1",
      maySendGate: true,
    });
    const sendGatedDm = vi.fn().mockResolvedValue({ outcome: "guide_opening_sent" });
    const recordOutcome = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeGuideAudienceTimeoutRecovery(authorized, {
        expectedCohortHash: authorized.cohortHash,
        openJourney,
        sendGatedDm,
        recordOutcome,
      }),
    ).resolves.toEqual({ sent: 1, skipped: 0 });

    expect(openJourney).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      keywordId: "keyword-1",
      commentId: "comment-1",
      mediaId: "media-1",
      receivedAt: RECEIVED_AT,
      triggerKind: "guide_audience_timeout_recovery",
    });
    expect(sendGatedDm).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      igUserId: "ig-user-1",
      resourceId: "resource-1",
      commentId: "comment-1",
      observedAt: RECEIVED_AT,
    });
    expect(recordOutcome).toHaveBeenCalledWith({
      decisionId: "decision-1",
      outcome: "guide_opening_sent",
    });
  });

  it("checks the approved cohort hash before opening a journey or contacting Instagram", async () => {
    const plan = await planFor();
    const authorized = await authorizeGuideAudienceTimeoutRecovery(plan, {
      authorize: vi.fn().mockResolvedValue(enforcedAllow()),
    });
    const openJourney = vi.fn();
    const sendGatedDm = vi.fn();

    await expect(
      executeGuideAudienceTimeoutRecovery(authorized, {
        expectedCohortHash: "f".repeat(64),
        openJourney,
        sendGatedDm,
        recordOutcome: vi.fn(),
      }),
    ).rejects.toThrow("recovery cohort drift");

    expect(openJourney).not.toHaveBeenCalled();
    expect(sendGatedDm).not.toHaveBeenCalled();
  });

  it("stops the batch after an uncertain opening outcome", async () => {
    const plan = await planFor([
      candidate(),
      candidate({ decisionId: "decision-2", commentId: "comment-2" }),
    ]);
    const authorized = await authorizeGuideAudienceTimeoutRecovery(plan, {
      authorize: vi.fn().mockResolvedValue(enforcedAllow()),
    });
    const openJourney = vi.fn().mockResolvedValue({
      disposition: "new_journey",
      conversationId: "conversation-1",
      maySendGate: true,
    });
    const sendGatedDm = vi.fn().mockResolvedValue({ outcome: "access_attempt_needs_review" });

    await expect(
      executeGuideAudienceTimeoutRecovery(authorized, {
        expectedCohortHash: authorized.cohortHash,
        openJourney,
        sendGatedDm,
        recordOutcome: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("guide recovery stopped after access_attempt_needs_review");

    expect(sendGatedDm).toHaveBeenCalledOnce();
  });
});
