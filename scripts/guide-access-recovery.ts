import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { routeGuideAction } from "../src/handlers/guideActionRouter.js";
import { guideAccessRepository } from "../src/services/guideAccessRepository.js";
import {
  GUIDE_ACCESS_INCIDENT_STARTED_AT,
  classifyRecoveryCandidates,
  executeRecoveryCommand,
  parseRecoveryCliArgs,
  type RecoveryAttemptInput,
  type RecoveryAudit,
  type RecoveryCandidate,
} from "./guide-access-recovery-core.js";

async function loadRecoveryAudit(now = new Date()): Promise<RecoveryAudit> {
  const attempts = await prisma.guideAccessAttempt.findMany({
    where: {
      OR: [
        { state: { in: ["needs_review", "awaiting_request"] } },
        { actionTokens: { some: { status: "active", expiresAt: { lte: now } } } },
      ],
    },
    select: {
      id: true,
      conversationId: true,
      resourceId: true,
      state: true,
      lastFollowResult: true,
      followCheckCount: true,
      followResponseCount: true,
      messagingWindowExpiresAt: true,
      createdAt: true,
      updatedAt: true,
      resource: { select: { name: true } },
      conversation: { select: { igUserId: true } },
      actionTokens: {
        select: {
          id: true,
          action: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      },
    },
  });

  const conversationIds = [...new Set(attempts.map((attempt) => attempt.conversationId))];
  const resourceIds = [...new Set(attempts.map((attempt) => attempt.resourceId))];
  const senderIds = [...new Set(attempts.map((attempt) => attempt.conversation.igUserId))];
  const [deliveries, threads] = await Promise.all([
    conversationIds.length === 0
      ? []
      : prisma.guideDelivery.findMany({
          where: {
            conversationId: { in: conversationIds },
            resourceId: { in: resourceIds },
          },
          select: { conversationId: true, resourceId: true },
        }),
    senderIds.length === 0
      ? []
      : prisma.dmThread.findMany({
          where: { igUserId: { in: senderIds } },
          select: {
            igUserId: true,
            messages: {
              where: {
                direction: "inbound",
                instagramTimestamp: { gte: GUIDE_ACCESS_INCIDENT_STARTED_AT },
              },
              orderBy: { instagramTimestamp: "asc" },
              select: { id: true, instagramTimestamp: true },
            },
          },
        }),
  ]);
  const deliveryKeys = new Set(
    deliveries.map((delivery) => `${delivery.conversationId}:${delivery.resourceId}`),
  );
  const inboundBySender = new Map<string, Array<{ id: string; eventAt: Date }>>();
  for (const thread of threads) {
    const current = inboundBySender.get(thread.igUserId) ?? [];
    current.push(...thread.messages.map((message) => ({
      id: message.id,
      eventAt: message.instagramTimestamp,
    })));
    inboundBySender.set(thread.igUserId, current);
  }

  const inputs: RecoveryAttemptInput[] = attempts.map((attempt) => ({
    attemptId: attempt.id,
    conversationId: attempt.conversationId,
    senderId: attempt.conversation.igUserId,
    resourceName: attempt.resource.name,
    state: attempt.state,
    lastFollowResult: attempt.lastFollowResult,
    followCheckCount: attempt.followCheckCount,
    followResponseCount: attempt.followResponseCount,
    messagingWindowExpiresAt: attempt.messagingWindowExpiresAt,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    hasDelivery: deliveryKeys.has(`${attempt.conversationId}:${attempt.resourceId}`),
    tokens: attempt.actionTokens,
    inboundMessages: inboundBySender.get(attempt.conversation.igUserId) ?? [],
  }));
  return classifyRecoveryCandidates(inputs, now);
}

async function normalizeTokenStatus(
  candidates: RecoveryCandidate[],
  actor: string,
): Promise<number> {
  const tokenIds = candidates.flatMap((candidate) => candidate.tokenId ? [candidate.tokenId] : []);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.guideActionToken.updateMany({
      where: { id: { in: tokenIds }, status: "active", expiresAt: { lte: now } },
      data: { status: "expired" },
    });
    if (updated.count !== candidates.length) {
      throw new Error("token normalization fence changed; re-run the read-only audit");
    }
    await tx.eventLog.create({
      data: {
        kind: "guide_access_recovery_maintenance",
        payload: {
          actor,
          action: "normalize_token_status",
          count: updated.count,
          at: now.toISOString(),
        },
      },
    });
    return updated.count;
  });
}

async function releaseCounterReviews(
  candidates: RecoveryCandidate[],
  actor: string,
): Promise<number> {
  let released = 0;
  for (const candidate of candidates) {
    const outcome = await guideAccessRepository.releaseAttemptForConversation({
      conversationId: candidate.conversationId,
      actor,
      now: new Date(),
    });
    if (outcome !== "released") {
      throw new Error("review release fence changed; stop and re-run the read-only audit");
    }
    released += 1;
  }
  return released;
}

async function replaySwallowedAction(
  candidate: RecoveryCandidate,
  _actor: string,
): Promise<"handled" | "needs_review"> {
  if (!candidate.tokenId || !candidate.inboundMessageId || !candidate.inboundEventAt) {
    throw new Error("swallowed-action evidence is incomplete");
  }
  const routed = await routeGuideAction({
    payload: `ts:guide:${candidate.tokenId}`,
    senderId: candidate.senderId,
    eventId: candidate.inboundMessageId,
    source: "quick_reply",
    inboundMessageId: candidate.inboundMessageId,
    eventAt: candidate.inboundEventAt,
  });
  if (routed.kind !== "handled") throw new Error("persisted guide action was not routed");
  return routed.outcome === "access_attempt_needs_review" ? "needs_review" : "handled";
}

export async function runGuideAccessRecoveryCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseRecoveryCliArgs(args);
  const output = await executeRecoveryCommand(options, {
    load: () => loadRecoveryAudit(),
    normalizeTokenStatus,
    releaseCounterReviews,
    replaySwallowedAction,
  });
  console.log(output);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  runGuideAccessRecoveryCli()
    .catch((error: unknown) => {
      // Deliberately omit the provider/database error object. Production repair
      // output is an aggregate report, never a path for parent or token data.
      console.error(error instanceof Error ? error.message : "guide access recovery failed");
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
