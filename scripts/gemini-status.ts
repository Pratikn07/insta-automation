import { prisma } from "../src/lib/prisma.js";

// Quick health read of the Gemini queue. Optional arg: a mediaId to inspect.
//   npx tsx scripts/gemini-status.ts [mediaId]
async function main() {
  const counts = await prisma.geminiJob.groupBy({ by: ["status"], _count: true });
  console.log(
    "queue:",
    counts.map((c) => `${c.status}=${c._count}`).sort().join(" "),
  );

  const mediaId = process.argv[2];
  if (mediaId) {
    const job = await prisma.geminiJob.findUnique({
      where: { mediaId },
      select: { status: true, attempts: true, lastError: true, updatedAt: true },
    });
    if (!job) {
      console.log(`STATUS:missing (${mediaId})`);
      return;
    }
    console.log(`lastError: ${job.lastError ?? "none"} | attempts: ${job.attempts} | updated: ${job.updatedAt.toISOString()}`);
    console.log(`STATUS:${job.status}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
