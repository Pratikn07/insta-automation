import type { CampaignPhase } from "./historicalRecoveryEligibility.js";
import type { ExpandedRecoveryCampaignSelection } from "./expandedRecoveryCampaignSelector.js";
import { COPY_VERSION } from "./historicalRecoveryCopy.js";
import { EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION } from "./historicalRecoverySnapshot.js";

export const EXPANDED_RECOVERY_SELECTION_VERSION = "v1-canonical-intents-expanded-audience";

type ExpandedSelectionWithPhase = ExpandedRecoveryCampaignSelection & { phase: CampaignPhase };

/** Strict single-record output consumed by the fail-closed production operator. */
export function expandedRecoveryCampaignSelectionRecord(result: ExpandedSelectionWithPhase) {
  return {
    schemaVersion: 1 as const,
    kind: "expanded-recovery-selection" as const,
    rolloutGroupId: result.rolloutGroupId,
    phase: result.phase,
    groupHourlyCap: 10 as const,
    dailyCap: 1000 as const,
    holdoutPercent: 0 as const,
    eligibilityPolicyVersion: EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION,
    selectionVersion: EXPANDED_RECOVERY_SELECTION_VERSION,
    copyVersion: COPY_VERSION,
    onePersonAcrossRollout: true as const,
    campaigns: result.campaigns.map((campaign) => ({
      segment: campaign.segment,
      campaignId: campaign.campaignId,
      candidateCount: campaign.candidateCount,
      excludedPeople: campaign.excludedPeople,
      decisionHash: campaign.decisionHash,
    })),
  };
}

export function formatExpandedRecoveryCampaignSelection(
  result: ExpandedSelectionWithPhase,
): string {
  const anyDraftCreated = result.campaigns.some((campaign) => campaign.campaignId !== null);
  const lines = [
    anyDraftCreated
      ? "EXPANDED RECOVERY DRAFTS CREATED — none approved or started"
      : "NO EXPANDED RECOVERY DRAFTS CREATED — every segment has zero candidates",
    `  rollout group      : ${result.rolloutGroupId}`,
    `  phase              : ${result.phase}`,
    "  group hourly cap   : 10",
    "  holdout percent    : 0",
    "  eligibility policy : eligibility-v4-expanded-audience",
    `  excluded people    : ${result.excludedPeople}`,
    "",
  ];

  for (const campaign of result.campaigns) {
    lines.push(
      `  ${campaign.segment}:`,
      `    campaign id       : ${campaign.campaignId ?? "none (zero candidates)"}`,
      `    decision hash     : ${campaign.decisionHash}`,
      `    candidate count   : ${campaign.candidateCount}`,
      `    excluded people   : ${campaign.excludedPeople}`,
      "    exclusions:",
    );
    for (const [reason, count] of Object.entries(campaign.excludedByReason).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      lines.push(`      ${reason}: ${count}`);
    }
  }

  lines.push(
    "",
    "  one person across rollout: OK",
    "  Drafts are inert. No campaign has been approved, started, or sent by this command.",
  );
  return lines.join("\n");
}
