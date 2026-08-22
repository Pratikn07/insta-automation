import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatLegacyProviderBodySummary,
  redactLegacyProviderBodies,
  type LegacyProviderBodyPrisma,
} from "../src/services/legacyProviderBodyRedaction.js";

/**
 * Strips the legacy `requestBody` from event payloads written before the logger
 * moved to `describeGraphError`. Dry run by default:
 *
 *   npx tsx scripts/redact-legacy-provider-bodies.ts            # count only
 *   npx tsx scripts/redact-legacy-provider-bodies.ts --write    # apply
 *
 * The logic and its tests live in src/services/legacyProviderBodyRedaction.ts —
 * vitest only collects `src/**\/*.test.ts`, so a test placed next to this file
 * would never run.
 */
export async function runLegacyProviderBodyRedactionCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.some((arg) => arg !== "--write")) {
    throw new Error("usage: redact-legacy-provider-bodies [--write]");
  }

  const { prisma } = await import("../src/lib/prisma.js");
  try {
    const summary = await redactLegacyProviderBodies(
      prisma as unknown as LegacyProviderBodyPrisma,
      { write: args.includes("--write") },
    );
    console.log(formatLegacyProviderBodySummary(summary));
  } finally {
    await prisma.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  runLegacyProviderBodyRedactionCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
