import { prisma } from "../src/lib/prisma.js";
import { pathToFileURL } from "node:url";
import {
  countInstagramCodeUnits,
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  isInstagramGuideTextTooLong,
} from "../shared/guideMessagePolicy.js";

type AuditPrismaClient = Pick<typeof prisma, "resourceMessage" | "$disconnect">;

function reportAuditFailure(): void {
  console.error("guide_message_length_audit_failed");
}

export async function runGuideMessageLengthAudit(client: AuditPrismaClient = prisma): Promise<number> {
  let exitCode = 0;

  try {
    const messages = await client.resourceMessage.findMany({
      where: { body: { not: null } },
      select: {
        id: true,
        order: true,
        type: true,
        body: true,
        resource: {
          select: {
            id: true,
            name: true,
            keywords: { where: { active: true }, select: { id: true } },
          },
        },
      },
    });

    const invalidMessages = messages
      .filter((message) => message.body !== null && isInstagramGuideTextTooLong(message.body))
      .sort((left, right) => {
        const activeDifference =
          Number(right.resource.keywords.length > 0) - Number(left.resource.keywords.length > 0);
        if (activeDifference !== 0) return activeDifference;
        const nameDifference = left.resource.name.localeCompare(right.resource.name);
        if (nameDifference !== 0) return nameDifference;
        return left.order - right.order;
      });

    for (const message of invalidMessages) {
      const codeUnits = countInstagramCodeUnits(message.body!);
      console.log(
        `resourceId=${message.resource.id} resource=${JSON.stringify(message.resource.name)} ` +
          `messageId=${message.id} order=${message.order} type=${message.type} ` +
          `codeUnits=${codeUnits} overBy=${codeUnits - INSTAGRAM_GUIDE_TEXT_LIMIT} ` +
          `activeKeywords=${message.resource.keywords.length}`,
      );
    }

    if (invalidMessages.some((message) => message.resource.keywords.length > 0)) {
      exitCode = 1;
    }
  } catch {
    reportAuditFailure();
    exitCode = 1;
  }

  try {
    await client.$disconnect();
  } catch {
    reportAuditFailure();
    exitCode = 1;
  }

  return exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void runGuideMessageLengthAudit().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      reportAuditFailure();
      process.exitCode = 1;
    },
  );
}
