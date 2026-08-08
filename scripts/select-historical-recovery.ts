import { prisma } from "../src/lib/prisma.js";
import { selectHistoricalCandidates } from "../src/services/historicalRecoverySelector.js";
import { env } from "../src/config/env.js";
import { COPY_VERSION } from "../src/services/historicalRecoveryCopy.js";
import type { CampaignPhase } from "../src/services/historicalRecoveryEligibility.js";

/**
 * Preview (and optionally draft) a historical recovery campaign.
 *
 *   npx tsx scripts/select-historical-recovery.ts                  # report only
 *   npx tsx scripts/select-historical-recovery.ts --limit 25       # stage-1 size
 *   npx tsx scripts/select-historical-recovery.ts --write          # create a DRAFT
 *
 * `--write` creates a campaign in `draft`, never `running`: sending requires owner
 * approval, which the chk_campaign_running_is_approved constraint enforces.
 *
 * Nothing here contacts anybody.
 */

const WRITE = process.argv.includes("--write");

// Phase must be stated, never defaulted. The old script hardcoded
// `unknown_read_pilot`, which meant there was no way to run a Phase 1 selection at
// all, AND that a mixed pool inherited a label nobody chose. The design also
// sequences these: Phase 1 is observed before a Phase 2 pilot is selectable.
const phaseArg = process.argv.indexOf("--phase");
const phaseRaw = phaseArg >= 0 ? process.argv[phaseArg + 1] : undefined;

function requirePhase(value: string | undefined): CampaignPhase {
  if (value === "confirmed_failure" || value === "unknown_read_pilot") return value;
  console.error(
    "--phase is required and decides which cohort is selected:\n" +
      "  --phase confirmed_failure    only gate_exhausted (Meta confirmed the DM failed)\n" +
      "  --phase unknown_read_pilot   only gate_sent_no_read (accepted, no read receipt)\n\n" +
      "The two need different copy and cannot share a campaign.",
  );
  process.exit(1);
}

const PHASE = requirePhase(phaseRaw);
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

// This flag changes the pool by ~30% (680 of 1,665 eligible rows are excluded by
// it), so reading the wrong value silently produces a campaign targeting the wrong
// people. The local default is false while production is true, and a script run
// from a laptop picks up the local value — so require it explicitly rather than
// letting an unset variable decide who gets contacted.
if (process.env.DM_RECOVERY_WESTERN_ONLY === undefined) {
  console.error(
    "DM_RECOVERY_WESTERN_ONLY is not set. It must match production, which decides\n" +
      "whether out-of-market people are excluded. Check with:\n" +
      "  railway variables --service api | grep WESTERN_ONLY\n" +
      "then re-run with e.g. DM_RECOVERY_WESTERN_ONLY=true",
  );
  process.exit(1);
}

// Default: comments at least 7 days old. A recent commenter may still be mid-flow,
// and the gate's own 48-hour window plus retry schedule needs room to finish.
const MIN_AGE_DAYS = 7;

async function main() {
  const now = new Date();
  const report = await selectHistoricalCandidates({
    phase: PHASE,
    selectionVersion: "v1-canonical-intents",
    copyVersion: COPY_VERSION,
    // Read the live flag rather than assuming: the filter must match what the
    // prospective feature is actually doing today.
    westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
    commentTo: new Date(now.getTime() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000),
    limit: LIMIT,
    persist: WRITE,
    now,
  });

  console.log(WRITE ? "DRAFT CAMPAIGN CREATED" : "DRY RUN — nothing written");
  if (report.campaignId) console.log(`  campaign id       : ${report.campaignId}`);
  console.log(`  phase             : ${PHASE}`);
  console.log(`  westernOnly       : ${env.DM_RECOVERY_WESTERN_ONLY}`);
  console.log(`  min comment age   : ${MIN_AGE_DAYS} days`);
  console.log(`  intents examined  : ${report.rawIntents}`);
  console.log(`  ELIGIBLE          : ${report.eligible}  (${report.eligiblePeople} people)`);
  for (const [evidence, count] of Object.entries(report.byEvidence)) {
    console.log(`    ${evidence.padEnd(24)} ${count}`);
  }
  console.log("  excluded:");
  for (const [reason, count] of Object.entries(report.excludedByReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${reason.padEnd(28)} ${count}`);
  }

  // The invariant worth stating in the output, not just asserting in code: one
  // public comment per person.
  if (report.eligible !== report.eligiblePeople) {
    console.log(`\n  WARNING: ${report.eligible} candidates for ${report.eligiblePeople} people`);
  } else {
    console.log(`\n  one candidate per person: OK`);
  }
  if (!WRITE) console.log("\nRe-run with --write to create a draft campaign.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
