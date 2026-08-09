import { describe, expect, it } from "vitest";
import {
  buildSelectionDecisionHash,
  buildSelectionFingerprint,
  verifyStoredSelectionSnapshot,
  type SelectionSnapshotConfiguration,
  type SelectionSnapshotExclusion,
  type SelectionSnapshotInclusion,
} from "./historicalRecoverySnapshot.js";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";

function config(
  overrides: Partial<SelectionSnapshotConfiguration> = {},
): SelectionSnapshotConfiguration {
  return {
    phase: "unknown_read_pilot",
    selectionVersion: "selector-v2",
    sourceDataCutoff: "2026-08-08T20:00:00.000Z",
    commentFrom: "2026-07-01T00:00:00.000Z",
    commentTo: "2026-08-01T00:00:00.000Z",
    selectionLimit: 25,
    westernOnly: true,
    holdoutPercent: 10,
    copyVersion: "copy-v2",
    eligibilityPolicyVersion: "eligibility-v2",
    inboundWindowHours: 48,
    completionWindowHours: 48,
    ...overrides,
  };
}

function inclusion(
  overrides: Partial<SelectionSnapshotInclusion> = {},
): SelectionSnapshotInclusion {
  return {
    position: 0,
    intentId: "11111111-1111-4111-8111-111111111111",
    igUserId: "person-1",
    conversationId: "22222222-2222-4222-8222-222222222222",
    keywordId: "33333333-3333-4333-8333-333333333333",
    commentId: "comment-new",
    mediaId: "media-1",
    commentAt: "2026-07-20T00:00:00.000Z",
    keywordSnapshot: "SLEEP",
    publicReplyText: "Please DM SLEEP",
    evidence: "gate_sent_no_read",
    audienceOrigin: "us_western",
    audienceOriginMethod: CURRENT_ORIGIN_METHOD,
    audienceOriginConfidence: "high",
    arm: "treatment",
    sourceChoiceReason: "newest_eligible_comment",
    sources: [
      {
        position: 0,
        commentId: "comment-new",
        mediaId: "media-1",
        receivedAt: "2026-07-20T00:00:00.000Z",
        choiceReason: "newest_eligible_comment",
      },
      {
        position: 1,
        commentId: "comment-old",
        mediaId: "media-0",
        receivedAt: "2026-07-19T00:00:00.000Z",
        choiceReason: "approved_fallback",
      },
    ],
    ...overrides,
  };
}

function exclusion(
  overrides: Partial<SelectionSnapshotExclusion> = {},
): SelectionSnapshotExclusion {
  return {
    intentId: "44444444-4444-4444-8444-444444444444",
    igUserId: "person-2",
    keywordId: "55555555-5555-4555-8555-555555555555",
    reason: "has_engagement_evidence",
    ...overrides,
  };
}

describe("selection snapshot fingerprint", () => {
  it("changes for every normalized selector input", () => {
    const base = buildSelectionFingerprint(config());
    const variants: SelectionSnapshotConfiguration[] = [
      config({ phase: "confirmed_failure" }),
      config({ selectionVersion: "selector-v3" }),
      config({ sourceDataCutoff: "2026-08-08T20:00:00.001Z" }),
      config({ commentFrom: null }),
      config({ commentTo: null }),
      config({ selectionLimit: 50 }),
      config({ westernOnly: false }),
      config({ holdoutPercent: 50 }),
      config({ copyVersion: "copy-v3" }),
      config({ eligibilityPolicyVersion: "eligibility-v3" }),
      config({ inboundWindowHours: 72 }),
      config({ completionWindowHours: 72 }),
    ];

    expect(new Set(variants.map(buildSelectionFingerprint))).toHaveLength(variants.length);
    for (const variant of variants) expect(buildSelectionFingerprint(variant)).not.toBe(base);
  });

  it("is stable across object construction order", () => {
    const first = config();
    const second = {
      completionWindowHours: 48,
      inboundWindowHours: 48,
      eligibilityPolicyVersion: "eligibility-v2",
      copyVersion: "copy-v2",
      holdoutPercent: 10,
      westernOnly: true,
      commentTo: "2026-08-01T00:00:00.000Z",
      commentFrom: "2026-07-01T00:00:00.000Z",
      selectionLimit: 25,
      sourceDataCutoff: "2026-08-08T20:00:00.000Z",
      selectionVersion: "selector-v2",
      phase: "unknown_read_pilot" as const,
    };
    expect(buildSelectionFingerprint(second)).toBe(buildSelectionFingerprint(first));
  });
});

describe("selection snapshot decision hash", () => {
  it("covers origin method, arms, ordered approved sources, source reason, and exclusions", () => {
    const base = buildSelectionDecisionHash(config(), [inclusion()], [exclusion()]);
    const variants = [
      buildSelectionDecisionHash(config(), [inclusion({ arm: "holdout" })], [exclusion()]),
      buildSelectionDecisionHash(
        config(),
        [inclusion({ sources: [...inclusion().sources].reverse() })],
        [exclusion()],
      ),
      buildSelectionDecisionHash(
        config(),
        [inclusion({ sourceChoiceReason: "manual_primary" })],
        [exclusion()],
      ),
      buildSelectionDecisionHash(
        config(),
        [inclusion({ audienceOriginMethod: "name" })],
        [exclusion()],
      ),
      buildSelectionDecisionHash(config(), [inclusion()], [exclusion({ reason: "other" })]),
      buildSelectionDecisionHash(config({ copyVersion: "copy-v3" }), [inclusion()], [exclusion()]),
    ];
    for (const hash of variants) expect(hash).not.toBe(base);
  });

  it("sorts exclusions by intent identity but preserves inclusion/source positions", () => {
    const exclusion2 = exclusion({
      intentId: "66666666-6666-4666-8666-666666666666",
      igUserId: "person-3",
    });
    expect(
      buildSelectionDecisionHash(config(), [inclusion()], [exclusion(), exclusion2]),
    ).toBe(
      buildSelectionDecisionHash(config(), [inclusion()], [exclusion2, exclusion()]),
    );

    const second = inclusion({
      position: 1,
      intentId: "77777777-7777-4777-8777-777777777777",
      igUserId: "person-4",
    });
    expect(buildSelectionDecisionHash(config(), [inclusion(), second], [])).not.toBe(
      buildSelectionDecisionHash(config(), [second, inclusion()], []),
    );
  });
});

describe("stored selection snapshot verification", () => {
  function stored(overrides: Record<string, unknown> = {}) {
    const configuration = config();
    const inclusions = [inclusion()];
    const exclusions = [exclusion()];
    return {
      configuration,
      selectionFingerprint: buildSelectionFingerprint(configuration),
      decisionHash: buildSelectionDecisionHash(configuration, inclusions, exclusions),
      candidateCount: inclusions.length,
      excludedCount: exclusions.length,
      inclusions,
      exclusions,
      ...overrides,
    };
  }

  it("accepts the exact complete manifest", () => {
    expect(verifyStoredSelectionSnapshot(stored())).toEqual({ ok: true });
  });

  it.each([
    ["missing config", { configuration: null }, "snapshot_incomplete"],
    ["missing fingerprint", { selectionFingerprint: null }, "snapshot_incomplete"],
    ["candidate count drift", { candidateCount: 2 }, "snapshot_incomplete"],
    ["exclusion count drift", { excludedCount: 2 }, "snapshot_incomplete"],
    [
      "source gap",
      { inclusions: [inclusion({ sources: [inclusion().sources[1]!] })] },
      "snapshot_incomplete",
    ],
    [
      "missing candidate origin method",
      { inclusions: [inclusion({ audienceOriginMethod: null })] },
      "snapshot_incomplete",
    ],
    [
      "config drift",
      { configuration: config({ westernOnly: false }) },
      "snapshot_fingerprint_mismatch",
    ],
    [
      "arm drift",
      { inclusions: [inclusion({ arm: "holdout" })] },
      "snapshot_hash_mismatch",
    ],
  ])("rejects %s", (_label, override, reason) => {
    expect(verifyStoredSelectionSnapshot(stored(override as Record<string, unknown>))).toEqual({
      ok: false,
      reason,
    });
  });
});
