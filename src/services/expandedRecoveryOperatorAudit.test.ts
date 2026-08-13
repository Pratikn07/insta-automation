import { describe, expect, it } from "vitest";
import {
  assertExpandedGroupAuditSnapshot,
  hasExactHistoricalAudienceShape,
  isAuthorizedFirstSendRow,
  type ExpandedGroupAuditSnapshot,
} from "../../scripts/expanded-recovery-audit.js";
import {
  buildSelectionDecisionHash,
  buildSelectionFingerprint,
  type SelectionSnapshotConfiguration,
  type SelectionSnapshotInclusion,
} from "./historicalRecoverySnapshot.js";

describe("expanded recovery audit parity", () => {
  it("uses the production JS no-name normalization rather than SQL trim emulation", () => {
    expect(hasExactHistoricalAudienceShape({ username: " - ", name: "\t", segment: "unknown_no_name", origin: "unknown", confidence: "low", method: "llm_v3" })).toBe(true);
    expect(hasExactHistoricalAudienceShape({ username: " — ", name: "\t", segment: "unknown_no_name", origin: "unknown", confidence: "low", method: "llm_v3" })).toBe(false);
  });
});

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const SEGMENTS = ["other", "unknown_cue", "unknown_generic", "unknown_no_name"] as const;

function groupSnapshot(): ExpandedGroupAuditSnapshot {
  const campaigns = SEGMENTS.map((segment, campaignIndex) => {
    const id = `22222222-2222-4222-8222-22222222222${campaignIndex + 1}`;
    const configuration: SelectionSnapshotConfiguration = {
      phase: "unknown_read_pilot",
      selectionVersion: "v1-canonical-intents-expanded-audience",
      sourceDataCutoff: "2026-08-11T00:00:00.000Z",
      commentFrom: null,
      commentTo: "2026-08-04T00:00:00.000Z",
      selectionLimit: null,
      westernOnly: false,
      holdoutPercent: 0,
      copyVersion: "recovery-v2",
      eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
      inboundWindowHours: 24,
      completionWindowHours: 48,
      audienceSegment: segment,
      rolloutGroupId: GROUP_ID,
      rolloutGroupHourlyCap: 10,
    };
    const inclusion: SelectionSnapshotInclusion = {
      position: 0,
      intentId: `33333333-3333-4333-8333-33333333333${campaignIndex + 1}`,
      igUserId: `person-${campaignIndex + 1}`,
      conversationId: null,
      keywordId: `44444444-4444-4444-8444-44444444444${campaignIndex + 1}`,
      commentId: `comment-${campaignIndex + 1}`,
      mediaId: `media-${campaignIndex + 1}`,
      commentAt: "2026-08-01T00:00:00.000Z",
      keywordSnapshot: "SLEEP",
      publicReplyText: "DM @tinysoho SLEEP",
      evidence: "gate_sent_no_read",
      audienceOrigin: segment === "other" ? "other" : "unknown",
      audienceOriginMethod: "llm_v3",
      audienceOriginConfidence: "low",
      audienceSegment: segment,
      arm: "treatment",
      sourceChoiceReason: "newest_eligible_comment",
      sources: [
        { position: 0, commentId: `comment-${campaignIndex + 1}`, mediaId: `media-${campaignIndex + 1}`, receivedAt: "2026-08-01T00:00:00.000Z", choiceReason: "newest_eligible_comment" },
        { position: 1, commentId: `fallback-${campaignIndex + 1}`, mediaId: `media-${campaignIndex + 1}`, receivedAt: "2026-07-31T00:00:00.000Z", choiceReason: "approved_fallback" },
      ],
    };
    const exclusions = [{
      intentId: `55555555-5555-4555-8555-55555555555${campaignIndex + 1}`,
      igUserId: `excluded-${campaignIndex + 1}`,
      keywordId: inclusion.keywordId,
      reason: "audience_segment_mismatch",
    }];
    return {
      id,
      state: "draft",
      phase: "unknown_read_pilot",
      audienceSegment: segment,
      rolloutGroupId: GROUP_ID,
      rolloutGroupHourlyCap: 10,
      selectionVersion: "v1-canonical-intents-expanded-audience",
      copyVersion: "recovery-v2",
      eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
      holdoutPercent: 0,
      batchSize: 1,
      hourlyCap: 10,
      dailyCap: 1000,
      candidateCount: 1,
      excludedCount: 1,
      allCandidatesMatchLive: true,
      snapshot: {
        configuration,
        selectionFingerprint: buildSelectionFingerprint(configuration),
        decisionHash: buildSelectionDecisionHash(configuration, [inclusion], exclusions),
        candidateCount: 1,
        excludedCount: 1,
        inclusions: [inclusion],
        exclusions,
      },
    };
  });
  return {
    expectedGroupId: GROUP_ID,
    expectedCampaigns: campaigns.map(({ id, audienceSegment, snapshot }) => ({
      id,
      segment: audienceSegment,
      decisionHash: snapshot.decisionHash!,
    })),
    expectedStates: ["draft"],
    expectedPhase: "unknown_read_pilot",
    rollingCapacity: 0,
    campaigns,
  };
}

describe("expanded group pre-approval audit", () => {
  it("accepts one complete, exact, treatment-only manifest for every non-empty segment", () => {
    expect(() => assertExpandedGroupAuditSnapshot(groupSnapshot())).not.toThrow();
  });

  it.each([
    ["fingerprint", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.snapshot.selectionFingerprint = "f".repeat(64); }],
    ["decision hash", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.snapshot.decisionHash = "e".repeat(64); }],
    ["selection version", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.selectionVersion = "wrong"; }],
    ["copy version", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.copyVersion = "wrong"; }],
    ["policy version", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.eligibilityPolicyVersion = "wrong"; }],
    ["campaign phase", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.phase = "confirmed_failure"; }],
    ["candidate count", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.candidateCount = 2; }],
    ["exclusion count", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.excludedCount = 2; }],
    ["holdout arm", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.snapshot.inclusions[0]!.arm = "holdout"; }],
    ["source order", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.snapshot.inclusions[0]!.sources[1]!.position = 7; }],
    ["live mismatch", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[0]!.allCandidatesMatchLive = false; }],
    ["duplicate person", (value: ExpandedGroupAuditSnapshot) => { value.campaigns[1]!.snapshot.inclusions[0]!.igUserId = value.campaigns[0]!.snapshot.inclusions[0]!.igUserId; }],
    ["campaign topology", (value: ExpandedGroupAuditSnapshot) => { value.expectedCampaigns.reverse(); }],
    ["selector decision hash", (value: ExpandedGroupAuditSnapshot) => { value.expectedCampaigns[0]!.decisionHash = "0".repeat(64); }],
  ])("rejects a bad %s before approval", (_label, mutate) => {
    const value = groupSnapshot();
    mutate(value);
    expect(() => assertExpandedGroupAuditSnapshot(value)).toThrow("expanded_group_audit_failed");
  });
});

describe("first-send source authorization", () => {
  const row = {
    candidateId: "candidate-1",
    sourceKind: "historical",
    sourceId: "candidate-1",
    dispatchCommentId: "comment-2",
    approvedSourceCommentIds: ["comment-1", "comment-2"],
  };

  it("accepts only a historical candidate dispatch to one immutable approved source", () => {
    expect(isAuthorizedFirstSendRow(row)).toBe(true);
  });

  it.each([
    { sourceKind: "prospective" },
    { sourceId: "another-candidate" },
    { dispatchCommentId: "unapproved-comment" },
    { dispatchCommentId: null },
    { approvedSourceCommentIds: [] },
  ])("rejects an unauthorized source shape %#", (override) => {
    expect(isAuthorizedFirstSendRow({ ...row, ...override })).toBe(false);
  });
});
