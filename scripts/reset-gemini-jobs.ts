import { prisma } from "../src/lib/prisma.js";

// Re-arm dead Gemini jobs after an API-key rotation. `failed` is terminal and
// `running` rows from a crashed tick are never re-picked, so both need a manual
// reset to `pending` (see geminiQueueWorker MAX_ATTEMPTS).
//
//   npx tsx scripts/reset-gemini-jobs.ts canary   # newest failed job with video
//   npx tsx scripts/reset-gemini-jobs.ts all      # every failed/running job
async function main() {
  const mode = process.argv[2];
  if (mode !== "canary" && mode !== "all") {
    console.error("usage: reset-gemini-jobs.ts <canary|all>");
    process.exitCode = 1;
    return;
  }

  if (mode === "canary") {
    const job = await prisma.geminiJob.findFirst({
      where: { status: "failed", reel: { mediaUrl: { not: null } } },
      orderBy: { reel: { postedAt: "desc" } },
      select: { mediaId: true, reel: { select: { postedAt: true } } },
    });
    if (!job) {
      console.log("no failed job with a downloadable video found");
      return;
    }
    await prisma.geminiJob.update({
      where: { mediaId: job.mediaId },
      data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    console.log(`canary reset: ${job.mediaId} (posted ${job.reel?.postedAt?.toISOString() ?? "unknown"})`);
    return;
  }

  const result = await prisma.geminiJob.updateMany({
    where: { status: { in: ["failed", "running"] } },
    data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  console.log(`reset ${result.count} job(s) to pending`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
