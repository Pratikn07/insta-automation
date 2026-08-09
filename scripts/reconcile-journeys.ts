import { prisma } from "../src/lib/prisma.js";
import {
  JourneyReconciliationRunError,
  runJourneyReconciliation,
} from "../src/services/journeyReconciliationRunner.js";

/**
 * Build or apply a durable journey-reconciliation manifest.
 *
 *   npx tsx scripts/reconcile-journeys.ts
 *   npx tsx scripts/reconcile-journeys.ts --write --approved-run=<dry-run UUID>
 *   npx tsx scripts/reconcile-journeys.ts --resume=<run UUID> [--write]
 *
 * Dry run is the default and persists the exact per-window input fingerprint,
 * proposed owner, evidence choice, and conflict. Write mode requires the UUID of
 * a completed dry run and refuses any input drift. Each write, window result,
 * and resume checkpoint commits in one transaction.
 */

function valueOf(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const write = process.argv.includes("--write");
const approvedManifestRunId = valueOf("--approved-run=");
const resumeRunId = valueOf("--resume=");

async function main(): Promise<void> {
  const summary = await runJourneyReconciliation({
    write,
    approvedManifestRunId,
    resumeRunId,
  });

  console.log(write ? "APPLIED" : "DRY RUN — durable manifest only; no journey writes");
  console.log(`  run id          : ${summary.runId}`);
  console.log(`  source cutoff   : ${summary.sourceCutoff.toISOString()}`);
  console.log(`  windows         : ${summary.windows}`);
  for (const [result, count] of Object.entries(summary.results).sort()) {
    console.log(`    ${result.padEnd(30)} ${count}`);
  }
  if (!write) {
    console.log(
      `\nAfter owner review: npx tsx scripts/reconcile-journeys.ts --write --approved-run=${summary.runId}`,
    );
  }
}

main()
  .catch((error) => {
    if (error instanceof JourneyReconciliationRunError) {
      console.error(`${error.message}${error.runId ? ` (run ${error.runId})` : ""}`);
    } else {
      console.error("journey_reconciliation_failed");
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
