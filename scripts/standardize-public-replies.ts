import path from "node:path";
import { pathToFileURL } from "node:url";

export const APPROVED_PUBLIC_REPLY = "It’s waiting for you 💛 Check your DMs (and Requests)!";

type KeywordWhere = {
  active: true;
  publicReply: { not: string };
};

type UpcomingAutomationWhere = KeywordWhere & {
  status: { in: ["waiting", "needs_attention"] };
};

type UpdateManyResult = { count: number };

export type PublicReplyRolloutPrisma = {
  keyword: {
    count(args: { where: KeywordWhere }): Promise<number>;
    updateMany(args: { where: KeywordWhere; data: { publicReply: string } }): Promise<UpdateManyResult>;
  };
  upcomingAutomation: {
    count(args: { where: UpcomingAutomationWhere }): Promise<number>;
    updateMany(args: {
      where: UpcomingAutomationWhere;
      data: { publicReply: string };
    }): Promise<UpdateManyResult>;
  };
  $transaction<T>(work: (transaction: PublicReplyRolloutPrisma) => Promise<T>): Promise<T>;
};

export type PublicReplyRolloutSummary = {
  keywords: number;
  upcomingAutomations: number;
};

const keywordWhere: KeywordWhere = {
  active: true,
  publicReply: { not: APPROVED_PUBLIC_REPLY },
};

const upcomingAutomationWhere: UpcomingAutomationWhere = {
  ...keywordWhere,
  status: { in: ["waiting", "needs_attention"] },
};

export async function standardizePublicReplies(
  prisma: PublicReplyRolloutPrisma,
  options: { write?: boolean } = {},
): Promise<PublicReplyRolloutSummary> {
  if (!options.write) {
    const keywords = await prisma.keyword.count({ where: keywordWhere });
    const upcomingAutomations = await prisma.upcomingAutomation.count({ where: upcomingAutomationWhere });
    return { keywords, upcomingAutomations };
  }

  return prisma.$transaction(async (transaction) => {
    const [keywords, upcomingAutomations] = await Promise.all([
      transaction.keyword.updateMany({
        where: keywordWhere,
        data: { publicReply: APPROVED_PUBLIC_REPLY },
      }),
      transaction.upcomingAutomation.updateMany({
        where: upcomingAutomationWhere,
        data: { publicReply: APPROVED_PUBLIC_REPLY },
      }),
    ]);
    return { keywords: keywords.count, upcomingAutomations: upcomingAutomations.count };
  });
}

export function formatPublicReplyRolloutSummary(summary: PublicReplyRolloutSummary): string {
  return JSON.stringify(summary);
}

export async function runPublicReplyRolloutCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.some((arg) => arg !== "--write")) {
    throw new Error("usage: standardize-public-replies [--write]");
  }

  const { prisma } = await import("../src/lib/prisma.js");
  try {
    const summary = await standardizePublicReplies(
      prisma as unknown as PublicReplyRolloutPrisma,
      { write: args.includes("--write") },
    );
    console.log(formatPublicReplyRolloutSummary(summary));
  } finally {
    await prisma.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  runPublicReplyRolloutCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
