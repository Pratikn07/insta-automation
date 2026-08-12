import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { COPY_VERSION } from "../src/services/historicalRecoveryCopy.js";
import { selectExpandedRecoveryCampaigns } from "../src/services/expandedRecoveryCampaignSelector.js";
import type { CampaignPhase } from "../src/services/historicalRecoveryEligibility.js";

/**
 * Create four expanded historical-recovery DRAFTS in one atomic rollout group.
 *
 * This command does not approve, start, or send any campaign. Review the printed
 * immutable selections before using the separate owner approval workflow.
 */

const phaseArg = process.argv.indexOf("--phase");
const phaseRaw = phaseArg >= 0 ? process.argv[phaseArg + 1] : undefined;
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

function requirePhase(value: string | undefined): CampaignPhase {
  if (value === "confirmed_failure" || value === "unknown_read_pilot") return value;
  console.error(
    "--phase is required:\n" +
      "  --phase confirmed_failure\n" +
      "  --phase unknown_read_pilot",
  );
  process.exit(1);
}

const phase = requirePhase(phaseRaw);

if (process.env.DM_RECOVERY_WESTERN_ONLY === undefined) {
  console.error(
    "DM_RECOVERY_WESTERN_ONLY is not set. It remains frozen on each draft for audit.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const now = new Date();
  const result = await selectExpandedRecoveryCampaigns({
    phase,
    selectionVersion: "v1-canonical-intents-expanded-audience",
    copyVersion: COPY_VERSION,
    westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
    commentTo: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    limit,
    now,
  });

  console.log("EXPANDED RECOVERY DRAFTS CREATED — none approved or started");
  console.log(`  rollout group      : ${result.rolloutGroupId}`);
  console.log(`  phase              : ${phase}`);
  console.log("  group hourly cap   : 10");
  console.log("  holdout percent    : 0");
  console.log("  eligibility policy : eligibility-v4-expanded-audience");
  console.log(`  excluded people    : ${result.excludedPeople}`);
  console.log("");

  for (const campaign of result.campaigns) {
    console.log(`  ${campaign.segment}:`);
    console.log(`    campaign id       : ${campaign.campaignId ?? "none (zero candidates)"}`);
    console.log(`    decision hash     : ${campaign.decisionHash}`);
    console.log(`    candidate count   : ${campaign.candidateCount}`);
    console.log(`    excluded people   : ${campaign.excludedPeople}`);
    console.log("    exclusions:");
    for (const [reason, count] of Object.entries(campaign.excludedByReason).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      console.log(`      ${reason}: ${count}`);
    }
  }

  console.log("\n  one person across rollout: OK");
  console.log(
    "  Drafts are inert. No campaign has been approved, started, or sent by this command.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
