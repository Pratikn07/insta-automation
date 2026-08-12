import type { CampaignPhase } from "./historicalRecoveryEligibility.js";
import type { ExpandedRecoveryCampaignSelection } from "./expandedRecoveryCampaignSelector.js";

export function formatExpandedRecoveryCampaignSelection(
  result: ExpandedRecoveryCampaignSelection & { phase: CampaignPhase },
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
