import { prisma } from "../src/lib/prisma.js";
import { selectHistoricalCandidates } from "../src/services/historicalRecoverySelector.js";
import { env } from "../src/config/env.js";
import { COPY_VERSION } from "../src/services/historicalRecoveryCopy.js";
import type { CampaignPhase } from "../src/services/historicalRecoveryEligibility.js";

/**
 * Draft a historical recovery campaign.
 *
 *   npx tsx scripts/select-historical-recovery.ts --phase X        # create a DRAFT
 *   npx tsx scripts/select-historical-recovery.ts --phase X --limit 25
 *   npx tsx scripts/select-historical-recovery.ts --phase X --preview   # write nothing
 *
 * Selecting WRITES A DRAFT by default, and that is the point (QA-14).
 *
 * It used to report without writing, and `--write` re-ran the whole selection to create
 * the campaign. Those are two executions of a query whose predicates are live — gate
 * status, a keyword's text or active flag, inferred_origin, a conversation completing —
 * and none of them can be bounded by the cutoff, because none of those tables keep
 * history. So the list that was reviewed and the list that was created could differ, and
 * nothing compared them.
 *
 * Now the reviewed artifact IS the draft: review it, then approve it. Approval promotes
 * exactly those stored rows and re-derives nothing.
 *
 * `--preview` still exists for exploring the shape of a cohort, and is deliberately
 * labelled in the output as not reviewable — a preview cannot be approved, because there
 * is nothing persisted to approve.
 *
 * A draft is inert: it cannot send until an owner approves it, which
 * chk_campaign_running_is_approved enforces and the worker's `state = 'running'`
 * predicate independently requires. Nothing here contacts anybody.
 */

const PREVIEW = process.argv.includes("--preview");
// Accepted and ignored: drafting is now the default, so old invocations still do the
// right thing rather than erroring on a flag that no longer has a job.
const LEGACY_WRITE = process.argv.includes("--write");

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

// Frozen on the campaign for compatibility and audit. Historical recovery now also
// requires the current Gemini origin gate regardless of this legacy setting, but
// requiring it keeps old automation invocations and reviewed configuration explicit.
if (process.env.DM_RECOVERY_WESTERN_ONLY === undefined) {
  console.error(
    "DM_RECOVERY_WESTERN_ONLY is not set. It is frozen on the campaign for audit.\n" +
      "Check production with:\n" +
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
    // Freeze the legacy setting for compatibility/audit. It does not bypass the
    // current-Gemini origin gate required by historical recovery.
    westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
    commentTo: new Date(now.getTime() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000),
    limit: LIMIT,
    persist: !PREVIEW,
    now,
  });

  const empty = !PREVIEW && report.campaignId === null;
  console.log(
    PREVIEW
      ? "PREVIEW — nothing written, nothing to approve"
      : empty
        ? "NO CANDIDATES — no draft created; the breakdown below is why"
        : "DRAFT CAMPAIGN CREATED",
  );
  if (report.campaignId) console.log(`  campaign id       : ${report.campaignId}`);
  // The fingerprint of who was chosen and why. Two runs over unchanged data print the
  // same value; a different one means a live predicate moved and the cohort is not the
  // one that was reviewed.
  console.log(`  decision hash     : ${report.decisionHash}`);
  console.log(`  phase             : ${PHASE}`);
  console.log(`  westernOnly (frozen): ${env.DM_RECOVERY_WESTERN_ONLY}`);
  console.log(`  min comment age   : ${MIN_AGE_DAYS} days`);
  console.log(`  intents examined  : ${report.rawIntents}`);
  console.log(`  ELIGIBLE          : ${report.eligible}  (${report.eligiblePeople} people)`);
  for (const [evidence, count] of Object.entries(report.byEvidence)) {
    console.log(`    ${evidence.padEnd(24)} ${count}`);
  }
  console.log("  selected origin provenance:");
  for (const [origin, count] of Object.entries(report.originBreakdown).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    console.log(`    ${origin.padEnd(28)} ${count}`);
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
  if (PREVIEW) {
    console.log(
      "\nA preview is NOT a reviewable selection: nothing was stored, so there is\n" +
        "nothing to approve and no record of what was excluded. Re-run without\n" +
        "--preview to create the draft you would actually review.",
    );
  } else {
    if (LEGACY_WRITE) {
      console.log("\nNote: --write is no longer needed. Selecting creates a draft by default.");
    }
    if (!empty) {
      console.log(
        "\nEvery excluded intent was recorded with its reason, so the draft is the full\n" +
          "decision — not just the people who made the cut. Review it, then approve it;\n" +
          "approval promotes these exact rows and does not re-select.",
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
