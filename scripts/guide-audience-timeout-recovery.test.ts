import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizedGuideAudienceTimeoutRecoveryPlan,
  GuideAudienceTimeoutRecoveryPlan,
} from "../src/services/guideAudienceTimeoutRecovery.js";
import {
  executeGuideAudienceTimeoutRecoveryCommand,
  hasOpenGuideAudienceTimeoutRecoveryJourney,
  parseGuideAudienceTimeoutRecoveryArgs,
  safeGuideAudienceTimeoutRecoveryFailure,
  type GuideAudienceTimeoutRecoveryCommandDependencies,
} from "./guide-audience-timeout-recovery-core.js";

const PREVIEW_HASH = "a".repeat(64);
const SEND_HASH = "b".repeat(64);

const previewPlan: GuideAudienceTimeoutRecoveryPlan = {
  candidates: [{
    decisionId: "decision-private",
    commentId: "comment-private",
    igUserId: "ig-user-private",
    mediaId: "media-private",
    text: "SLEEP",
    receivedAt: new Date("2026-09-24T03:00:00.000Z"),
    keywordId: "keyword-private",
    resourceId: "resource-private",
  }],
  excluded: { not_exact_post_scoped_match: 2 },
  cohortHash: PREVIEW_HASH,
};

const authorizedPlan: AuthorizedGuideAudienceTimeoutRecoveryPlan = {
  candidates: [{
    ...previewPlan.candidates[0]!,
    classificationId: "classification-private",
    classificationOrigin: "unknown",
  }],
  excluded: { ...previewPlan.excluded, audience_blocked: 1 },
  cohortHash: SEND_HASH,
};

function dependencies(): GuideAudienceTimeoutRecoveryCommandDependencies & {
  loadPlan: ReturnType<typeof vi.fn>;
  authorize: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  recordRun: ReturnType<typeof vi.fn>;
} {
  return {
    loadPlan: vi.fn().mockResolvedValue(previewPlan),
    authorize: vi.fn().mockResolvedValue(authorizedPlan),
    send: vi.fn().mockResolvedValue({ sent: 1, skipped: 0 }),
    recordRun: vi.fn().mockResolvedValue(undefined),
  };
}

describe("guide audience timeout recovery CLI safety", () => {
  it("never echoes a provider or database error with account data to command output", () => {
    expect(
      safeGuideAudienceTimeoutRecoveryFailure(
        new Error("provider failed for ig-user-private with comment-private"),
      ),
    ).toBe("guide audience timeout recovery failed; inspect service logs");
    expect(
      safeGuideAudienceTimeoutRecoveryFailure(
        new Error("preview cohort drift: rerun the read-only preview"),
      ),
    ).toBe("preview cohort drift: rerun the read-only preview");
  });

  it("treats an unassigned active journey as a duplicate during reconciliation", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "intent-private" });

    await expect(
      hasOpenGuideAudienceTimeoutRecoveryJourney(
        { journeyIntent: { findFirst } } as never,
        { igUserId: "ig-user-private", keywordId: "keyword-private" },
        new Date("2026-09-24T04:00:00.000Z"),
      ),
    ).resolves.toBe(true);

    const query = findFirst.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      where: {
        igUserId: "ig-user-private",
        keywordId: "keyword-private",
        windowExpiresAt: { gt: new Date("2026-09-24T04:00:00.000Z") },
      },
      select: { id: true },
    });
    expect(query.where).not.toHaveProperty("canonicalConversationId");
  });

  it("defaults to a read-only preview that does not classify, write, or send", async () => {
    const deps = dependencies();

    const output = await executeGuideAudienceTimeoutRecoveryCommand(
      parseGuideAudienceTimeoutRecoveryArgs([]),
      deps,
    );

    expect(output).toContain("Mode: preview");
    expect(output).toContain(`Candidate cohort hash: ${PREVIEW_HASH}`);
    expect(output).not.toContain("ig-user-private");
    expect(output).not.toContain("comment-private");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.recordRun).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("requires the preview hash and an accountable actor before provider classification", () => {
    expect(() => parseGuideAudienceTimeoutRecoveryArgs(["--mode", "classify"])).toThrow(
      "--cohort-hash",
    );
    expect(() => parseGuideAudienceTimeoutRecoveryArgs([
      "--mode", "classify", "--cohort-hash", PREVIEW_HASH,
    ])).toThrow("--actor");
  });

  it("rejects preview hash drift before provider classification", async () => {
    const deps = dependencies();

    await expect(
      executeGuideAudienceTimeoutRecoveryCommand({
        mode: "classify",
        cohortHash: SEND_HASH,
        actor: "owner",
        sendInstagram: false,
      }, deps),
    ).rejects.toThrow("preview cohort drift");

    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.recordRun).not.toHaveBeenCalled();
  });

  it("requires a fresh exact count and a separate Instagram-send flag before customer contact", () => {
    expect(() => parseGuideAudienceTimeoutRecoveryArgs([
      "--mode", "send", "--cohort-hash", SEND_HASH, "--actor", "owner",
    ])).toThrow("--expected-count");
    expect(() => parseGuideAudienceTimeoutRecoveryArgs([
      "--mode", "send", "--cohort-hash", SEND_HASH, "--actor", "owner", "--expected-count", "1",
    ])).toThrow("--send-instagram");
  });

  it("rejects allowlisted-count drift before it can send a gated DM", async () => {
    const deps = dependencies();

    await expect(
      executeGuideAudienceTimeoutRecoveryCommand({
        mode: "send",
        cohortHash: SEND_HASH,
        expectedCount: 2,
        actor: "owner",
        sendInstagram: true,
      }, deps),
    ).rejects.toThrow("allowlisted candidate count drift");

    expect(deps.recordRun).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("sends only after the classified hash and exact count are freshly re-established", async () => {
    const deps = dependencies();

    const output = await executeGuideAudienceTimeoutRecoveryCommand({
      mode: "send",
      cohortHash: SEND_HASH,
      expectedCount: 1,
      actor: "owner",
      sendInstagram: true,
    }, deps);

    expect(deps.recordRun).toHaveBeenCalledWith({
      actor: "owner",
      mode: "send",
      candidateCount: 1,
      cohortHash: SEND_HASH,
      excluded: authorizedPlan.excluded,
    });
    expect(deps.send).toHaveBeenCalledWith(authorizedPlan, SEND_HASH);
    expect(output).toContain("Sent: 1");
  });
});
