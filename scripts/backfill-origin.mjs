import { PrismaClient } from "@prisma/client";
import { inferOrigin } from "../dist/src/services/originInference.js";

// One-time backfill: classify every ig_user's inferred origin from name/username
// and persist it. Idempotent — safe to re-run (recomputes + overwrites). Requires
// a build first (`npm run build`) so dist/ has the compiled classifier.
//
// This is a PROXY (name-based), clearly stored as such: origin_method='name',
// origin_confidence flags the low-certainty residual guesses.

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.igUser.findMany({ select: { id: true, username: true, name: true } });
  console.log(`Classifying ${users.length} users (name-only)…`);

  const tally = { us_western: 0, south_asian: 0, other: 0, unknown: 0 };
  let highConf = 0;
  const now = new Date();

  for (const u of users) {
    const r = inferOrigin(u.username, u.name);
    tally[r.origin]++;
    if (r.confidence === "high") highConf++;
    await prisma.igUser.update({
      where: { id: u.id },
      data: {
        inferredOrigin: r.origin,
        originConfidence: r.confidence,
        originMethod: r.method,
        originEvidence: r.evidence,
        originCheckedAt: now,
      },
    });
  }

  console.log("Done. Distribution:", tally);
  console.log(`High-confidence: ${highConf}/${users.length} (${Math.round((highConf / users.length) * 100)}%)`);
}

main()
  .catch((e) => {
    console.error("backfill crashed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
