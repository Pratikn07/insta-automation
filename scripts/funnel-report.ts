// Run a funnel and print it.
//
// Three access paths, one definition — this is the "future-proofing" the funnel
// layer is built for:
//
//   1. CLI, anywhere DATABASE_URL exists (your machine, a deploy shell, or a
//      cloud session whose environment defines it):
//        npm run funnel -- guide-follow
//        npm run funnel -- guide-follow --from 2026-07-01 --to 2026-08-14
//        npm run funnel -- guide-follow --json
//
//   2. No database access at all. Print the SQL and run it wherever you like —
//      the Supabase SQL editor, psql, a Desktop MCP client — then read the
//      result. Requires no DATABASE_URL and opens no connection:
//        npm run funnel -- guide-follow --print-sql
//
//   3. MCP. The same statement --print-sql emits is what an MCP client should
//      run; see docs/funnels.md for the read-only role and .mcp.json wiring.
//
// Everything here is read-only.

// Load .env into process.env. runFunnel deliberately does NOT import
// config/env (that would demand the whole Meta keyring for a read-only
// report), so without this the CLI would ignore a perfectly good DATABASE_URL
// sitting in .env. dotenv is a no-op when there is no .env file, which keeps
// --print-sql usable in an environment that has none.
import "dotenv/config";

import { FUNNEL_KEYS, getFunnelDef } from "../src/services/funnels/registry.js";
import {
  COHORT_SQL,
  EVENT_LOOKBACK_MARGIN,
  type GuideFollowResult,
} from "../src/services/funnels/guideFollowFunnel.js";

interface Args {
  key: string;
  from: Date;
  to: Date;
  json: boolean;
  printSql: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = argv[i + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };

  const to = flag("to") ? new Date(`${flag("to")}T00:00:00.000Z`) : new Date();
  const from = flag("from")
    ? new Date(`${flag("from")}T00:00:00.000Z`)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("--from/--to must be YYYY-MM-DD");
  }
  if (from >= to) throw new Error("--from must be before --to");

  return {
    key: positional[0] ?? "guide-follow",
    from,
    to,
    json: argv.includes("--json"),
    printSql: argv.includes("--print-sql"),
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** A rate that may have been suppressed for want of sample. */
function rate(r: { numerator: number; denominator: number; pct: number | null }): string {
  const counts = `${r.numerator} of ${r.denominator}`;
  return r.pct === null ? `${counts} (too few to rate)` : `${r.pct}%  (${counts})`;
}

function printGuideFollow(result: GuideFollowResult): void {
  const { stages } = result;
  console.log(`\n${result.name} — ${result.question}`);
  console.log(
    `Cohort: conversations that entered between ${day(new Date(result.window.from))} and ${day(
      new Date(result.window.to),
    )} (${result.cohortSize} total), followed forward however long they took.\n`,
  );

  const width = Math.max(...stages.map((s) => s.label.length));
  for (const s of stages) {
    const step = s.ofPrevPct === null ? "     " : `${pad(s.ofPrevPct.toFixed(1), 5)}%`;
    const ofEntry = s.ofEntryPct === null ? "  —  " : `${pad(s.ofEntryPct.toFixed(1), 5)}%`;
    console.log(
      `  ${s.label.padEnd(width)}  ${pad(s.count, 6)}   step ${step}   of entry ${ofEntry}`,
    );
  }

  console.log(`\n  THE NUMBER — ${result.headline.label}`);
  console.log(`    ${rate(result.headline.rate)}`);
  console.log(`    ${result.headline.rationale}`);

  console.log(`\n  Follow gate (secondary)`);
  console.log(`    ${rate(result.followGateConversion)}`);
  console.log(`    of everyone who hit the follow wall, this many followed and got the guide.`);
  console.log(`    Still stuck at the wall: ${result.stuckAtWall}`);
  console.log(`    Never saw the wall (already following / already had it): ${result.expressLane}`);

  if (result.askDistribution.length > 0) {
    console.log(`\n  Asks before they cleared the wall`);
    for (const b of result.askDistribution) {
      console.log(
        `    asked ${b.asks}×: ${pad(b.conversations, 4)} conversations, ${pad(b.cleared, 4)} cleared`,
      );
    }
  }

  console.log(`\n  By entry path`);
  for (const p of result.byEntryPath) {
    console.log(
      `    ${p.entryPath.padEnd(8)} entered ${pad(p.entered, 5)}  →  guide ${pad(
        p.guideDelivered,
        5,
      )}   ${rate(p.deliveryRate)}`,
    );
  }

  console.log(`\n  Durability (second reading, ~21 days)`);
  console.log(`    ${rate(result.retention)}`);

  console.log(`\n  What the Home tile counts, for comparison`);
  console.log(
    `    delivered to a confirmed non-follower: ${result.homeTileCohort.deliveredToNonFollower}` +
      `  (redeliveries: ${result.homeTileCohort.ofWhichRedelivery})`,
  );
  console.log(
    `    Post follow-gate, a delivery to a confirmed non-follower is essentially`,
  );
  console.log(
    `    always a redelivery — if those two numbers match, the Home tile is`,
  );
  console.log(`    measuring the redelivery residue, not new-follower conversion.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const def = getFunnelDef(args.key);
  if (!def) {
    console.error(`Unknown funnel "${args.key}". Available: ${FUNNEL_KEYS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (args.printSql) {
    // Deliberately no database import on this path: printing the query must
    // work with no DATABASE_URL and no connection, so it is usable from a
    // session that has (and should have) no credentials at all.
    console.log(`-- ${def.name}: ${def.question}`);
    console.log(`-- $1 = ${args.from.toISOString()}`);
    console.log(`-- $2 = ${args.to.toISOString()}`);
    console.log(`-- $3 = ${EVENT_LOOKBACK_MARGIN}`);
    console.log(
      `-- Read-only. Returns one row per conversation; feed the rows to\n` +
        `-- summarizeGuideFollow() in src/services/funnels/guideFollowFunnel.ts,\n` +
        `-- which is where every percentage is computed.\n`,
    );
    console.log(COHORT_SQL);
    return;
  }

  // Imported lazily so --print-sql needs no database and no environment at all.
  const { runGuideFollowFunnel, createStandaloneFunnelClient } = await import(
    "../src/services/funnels/runFunnel.js"
  );
  const prisma = createStandaloneFunnelClient();

  try {
    const result = await runGuideFollowFunnel(prisma, { from: args.from, to: args.to });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printGuideFollow(result);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
