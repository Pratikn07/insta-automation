import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { type AudienceSegment } from "./historicalAudienceSegment.js";
import {
  selectHistoricalCandidates,
  type SelectionReport,
} from "./historicalRecoverySelector.js";
import { EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION } from "./historicalRecoverySnapshot.js";

const EXPANDED_SEGMENTS = [
  "other",
  "unknown_cue",
  "unknown_generic",
  "unknown_no_name",
] as const satisfies readonly AudienceSegment[];

type ExpandedSegment = (typeof EXPANDED_SEGMENTS)[number];

type HistoricalSelectionInput = Parameters<typeof selectHistoricalCandidates>[0];

export type SelectExpandedRecoveryCampaignsInput = Omit<
  HistoricalSelectionInput,
  | "audienceSegment"
  | "dailyCap"
  | "eligibilityPolicyVersion"
  | "holdoutPercent"
  | "persist"
  | "rolloutGroupHourlyCap"
  | "rolloutGroupId"
  | "transaction"
>;

export type ExpandedRecoveryCampaign = {
  segment: ExpandedSegment;
  campaignId: string | null;
  candidateCount: number;
  decisionHash: string;
  excludedPeople: number;
  excludedByReason: Record<string, number>;
};

export type ExpandedRecoveryCampaignSelection = {
  rolloutGroupId: string;
  campaigns: ExpandedRecoveryCampaign[];
  excludedPeople: number;
};

function toCampaign(segment: ExpandedSegment, report: SelectionReport): ExpandedRecoveryCampaign {
  return {
    segment,
    campaignId: report.campaignId,
    candidateCount: report.eligiblePeople,
    decisionHash: report.decisionHash,
    excludedPeople: report.excludedPeople,
    excludedByReason: report.excludedByReason,
  };
}

function assertNoPersistedRolloutDuplicates(rows: Array<{ igUserId: string }>): void {
  const seen = new Set<string>();
  for (const { igUserId } of rows) {
    if (seen.has(igUserId)) {
      throw new Error(`expanded_recovery_rollout_group_duplicate_ig_user_id: ${igUserId}`);
    }
    seen.add(igUserId);
  }
}

/**
 * Create the four non-Western expanded-audience campaigns as one draft-only unit.
 *
 * No campaign is approved or started here. An outer serializable transaction means a
 * selector error, a duplicate person, or any write failure leaves no partial cohort.
 */
export async function selectExpandedRecoveryCampaigns(
  input: SelectExpandedRecoveryCampaignsInput,
): Promise<ExpandedRecoveryCampaignSelection> {
  const rolloutGroupId = randomUUID();
  const now = input.now ?? new Date();

  return prisma.$transaction(async (transaction) => {
    const campaigns: ExpandedRecoveryCampaign[] = [];
    for (const segment of EXPANDED_SEGMENTS) {
      const report = await selectHistoricalCandidates({
        ...input,
        audienceSegment: segment,
        eligibilityPolicyVersion: EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION,
        holdoutPercent: 0,
        dailyCap: 1000,
        persist: true,
        rolloutGroupId,
        rolloutGroupHourlyCap: 10,
        now,
        transaction,
      });
      campaigns.push(toCampaign(segment, report));
    }

    const persistedCandidates = await transaction.recoveryCandidate.findMany({
      where: { campaign: { rolloutGroupId } },
      select: { igUserId: true },
    });
    assertNoPersistedRolloutDuplicates(persistedCandidates);

    return {
      rolloutGroupId,
      campaigns,
      excludedPeople: campaigns.reduce((total, campaign) => total + campaign.excludedPeople, 0),
    };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
}
