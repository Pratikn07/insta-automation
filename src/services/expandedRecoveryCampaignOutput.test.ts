import { describe, expect, it } from "vitest";
import {
  expandedRecoveryCampaignSelectionRecord,
  formatExpandedRecoveryCampaignSelection,
} from "./expandedRecoveryCampaignOutput.js";

describe("formatExpandedRecoveryCampaignSelection", () => {
  it("does not claim drafts were created when every segment has zero candidates", () => {
    const output = formatExpandedRecoveryCampaignSelection({
      phase: "unknown_read_pilot",
      rolloutGroupId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      excludedPeople: 0,
      campaigns: [
        {
          segment: "other",
          campaignId: null,
          candidateCount: 0,
          decisionHash: "other-hash",
          excludedPeople: 0,
          excludedByReason: {},
        },
        {
          segment: "unknown_cue",
          campaignId: null,
          candidateCount: 0,
          decisionHash: "cue-hash",
          excludedPeople: 0,
          excludedByReason: {},
        },
        {
          segment: "unknown_generic",
          campaignId: null,
          candidateCount: 0,
          decisionHash: "generic-hash",
          excludedPeople: 0,
          excludedByReason: {},
        },
        {
          segment: "unknown_no_name",
          campaignId: null,
          candidateCount: 0,
          decisionHash: "no-name-hash",
          excludedPeople: 0,
          excludedByReason: {},
        },
      ],
    });

    expect(output).toContain("NO EXPANDED RECOVERY DRAFTS CREATED — every segment has zero candidates");
    expect(output).not.toContain("EXPANDED RECOVERY DRAFTS CREATED — none approved or started");
  });
});

describe("expandedRecoveryCampaignSelectionRecord", () => {
  it("emits the strict operator contract with fixed versions and all four segments in order", () => {
    const record = expandedRecoveryCampaignSelectionRecord({
      phase: "confirmed_failure",
      rolloutGroupId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      excludedPeople: 7,
      campaigns: [
        { segment: "other", campaignId: "11111111-1111-4111-8111-111111111111", candidateCount: 2, decisionHash: "1".repeat(64), excludedPeople: 1, excludedByReason: {} },
        { segment: "unknown_cue", campaignId: null, candidateCount: 0, decisionHash: "2".repeat(64), excludedPeople: 2, excludedByReason: {} },
        { segment: "unknown_generic", campaignId: "33333333-3333-4333-8333-333333333333", candidateCount: 4, decisionHash: "3".repeat(64), excludedPeople: 3, excludedByReason: {} },
        { segment: "unknown_no_name", campaignId: "44444444-4444-4444-8444-444444444444", candidateCount: 5, decisionHash: "4".repeat(64), excludedPeople: 4, excludedByReason: {} },
      ],
    });

    expect(record).toEqual({
      schemaVersion: 1,
      kind: "expanded-recovery-selection",
      rolloutGroupId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      phase: "confirmed_failure",
      groupHourlyCap: 10,
      dailyCap: 1000,
      holdoutPercent: 0,
      eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
      selectionVersion: "v1-canonical-intents-expanded-audience",
      copyVersion: "recovery-v2",
      onePersonAcrossRollout: true,
      campaigns: [
        { segment: "other", campaignId: "11111111-1111-4111-8111-111111111111", candidateCount: 2, excludedPeople: 1, decisionHash: "1".repeat(64) },
        { segment: "unknown_cue", campaignId: null, candidateCount: 0, excludedPeople: 2, decisionHash: "2".repeat(64) },
        { segment: "unknown_generic", campaignId: "33333333-3333-4333-8333-333333333333", candidateCount: 4, excludedPeople: 3, decisionHash: "3".repeat(64) },
        { segment: "unknown_no_name", campaignId: "44444444-4444-4444-8444-444444444444", candidateCount: 5, excludedPeople: 4, decisionHash: "4".repeat(64) },
      ],
    });
  });
});
