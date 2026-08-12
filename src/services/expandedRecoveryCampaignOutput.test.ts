import { describe, expect, it } from "vitest";
import { formatExpandedRecoveryCampaignSelection } from "./expandedRecoveryCampaignOutput.js";

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
