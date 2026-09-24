import path from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { openConversationIn } from "../src/services/conversationService.js";
import { logEvent } from "../src/services/eventLogger.js";
import { startCommentGuideRequest } from "../src/services/guideAccessActionService.js";
import {
  createGuideAudienceAuthorizationService,
} from "../src/services/guideAudienceAuthorization.js";
import { guideAudienceAuthorizationRepository } from "../src/services/guideAudienceAuthorizationRepository.js";
import {
  GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT,
  GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT,
  authorizeGuideAudienceTimeoutRecovery,
  buildGuideAudienceTimeoutRecoveryPlan,
  executeGuideAudienceTimeoutRecovery,
  type AudienceTimeoutRecoveryCandidate,
  type GuideAudienceTimeoutRecoveryPlan,
} from "../src/services/guideAudienceTimeoutRecovery.js";
import { resolveJourneyIntent } from "../src/services/journeyIntentService.js";
import { findKeywordForComment } from "../src/services/keywordService.js";
import {
  createNvidiaAudienceClassifier,
  createTimeoutRetryingAudienceClassifier,
} from "../src/services/nvidiaAudienceClassifier.js";
import {
  executeGuideAudienceTimeoutRecoveryCommand,
  hasOpenGuideAudienceTimeoutRecoveryJourney,
  parseGuideAudienceTimeoutRecoveryArgs,
  safeGuideAudienceTimeoutRecoveryFailure,
} from "./guide-audience-timeout-recovery-core.js";

const COMMENT_EVIDENCE_SKEW_MS = 15 * 60 * 1_000;

type CommentReceivedEvidence = {
  commentId: string;
  igUserId: string;
  mediaId: string;
  text: string;
  receivedAt: Date;
};


function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function mergeCounts(...counts: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const count of counts) {
    for (const [key, value] of Object.entries(count)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function stringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function parseCommentReceivedEvidence(payload: unknown, receivedAt: Date): CommentReceivedEvidence | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const commentId = stringField(fields, "commentId");
  const igUserId = stringField(fields, "fromId");
  const mediaId = stringField(fields, "mediaId");
  const text = stringField(fields, "text");
  if (!commentId || !igUserId || !mediaId || !text) return null;
  return { commentId, igUserId, mediaId, text, receivedAt };
}

/**
 * Reconstruct only the fixed provider-timeout incident cohort from durable
 * records. We deliberately reject ambiguous/malformed evidence rather than
 * guessing at a post, guide, or recipient.
 */
async function loadIncidentPlan(): Promise<GuideAudienceTimeoutRecoveryPlan> {
  const evidenceFrom = new Date(
    GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT.getTime() - COMMENT_EVIDENCE_SKEW_MS,
  );
  const evidenceTo = new Date(
    GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT.getTime() + COMMENT_EVIDENCE_SKEW_MS,
  );
  const [decisions, events] = await Promise.all([
    prisma.guideAudienceDecision.findMany({
      where: {
        source: "comment",
        kind: "defer",
        deferReason: "provider_timeout",
        createdAt: {
          gte: GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT,
          lte: GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT,
        },
      },
      select: { id: true, commentId: true, igUserId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.eventLog.findMany({
      where: {
        kind: "comment_received",
        createdAt: { gte: evidenceFrom, lte: evidenceTo },
      },
      select: { payload: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  const evidenceByCommentId = new Map<string, CommentReceivedEvidence[]>();
  for (const event of events) {
    const evidence = parseCommentReceivedEvidence(event.payload, event.createdAt);
    if (!evidence) continue;
    const current = evidenceByCommentId.get(evidence.commentId) ?? [];
    current.push(evidence);
    evidenceByCommentId.set(evidence.commentId, current);
  }

  const candidates: AudienceTimeoutRecoveryCandidate[] = [];
  const loaderExcluded: Record<string, number> = {};
  for (const decision of decisions) {
    if (!decision.commentId) {
      increment(loaderExcluded, "missing_comment_id");
      continue;
    }
    const evidence = evidenceByCommentId.get(decision.commentId) ?? [];
    if (evidence.length === 0) {
      increment(loaderExcluded, "missing_comment_received_evidence");
      continue;
    }
    if (evidence.length !== 1) {
      increment(loaderExcluded, "ambiguous_comment_received_evidence");
      continue;
    }
    const comment = evidence[0]!;
    if (comment.igUserId !== decision.igUserId) {
      increment(loaderExcluded, "mismatched_comment_received_evidence");
      continue;
    }
    candidates.push({
      decisionId: decision.id,
      commentId: comment.commentId,
      igUserId: comment.igUserId,
      mediaId: comment.mediaId,
      text: comment.text,
      receivedAt: comment.receivedAt,
    });
  }

  // One frozen time is used across all window and existing-journey checks so a
  // long preview cannot make a row change classification halfway through itself.
  const now = new Date();
  const plan = await buildGuideAudienceTimeoutRecoveryPlan(candidates, {
    now: () => now,
    async resolveKeyword(candidate) {
      const match = await findKeywordForComment(candidate.text, candidate.mediaId);
      if (!match) return null;
      return {
        keywordId: match.keyword.id,
        resourceId: match.keyword.resourceId,
        mediaId: match.keyword.mediaId,
        mode: match.mode,
      };
    },
    hasOpenJourney: (input) => hasOpenGuideAudienceTimeoutRecoveryJourney(prisma, input, now),
  });
  return { ...plan, excluded: mergeCounts(loaderExcluded, plan.excluded) };
}

function createRecoveryAudienceAuthorizer() {
  const provider = createTimeoutRetryingAudienceClassifier(
    createNvidiaAudienceClassifier({ timeoutMs: env.NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS }),
    2,
  );
  return createGuideAudienceAuthorizationService({
    repository: guideAudienceAuthorizationRepository,
    provider,
    // This is independent of the live operator flag: recovery must never turn a
    // provider timeout into an unclassified outbound send.
    isEnabled: () => true,
    configuredModelId: env.NVIDIA_AUDIENCE_MODEL,
  });
}

export async function runGuideAudienceTimeoutRecoveryCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseGuideAudienceTimeoutRecoveryArgs(args);
  if (options.mode === "send" && env.GUIDE_AUDIENCE_BLOCK_ENABLED) {
    // startCommentGuideRequest has its own live authorization boundary. Requiring
    // it to remain off here makes the recovery's forced decision the single,
    // hash-fenced authority rather than attempting two different screenings.
    throw new Error("disable GUIDE_AUDIENCE_BLOCK_ENABLED before a recovery send");
  }

  const authorizer = createRecoveryAudienceAuthorizer();
  const output = await executeGuideAudienceTimeoutRecoveryCommand(options, {
    loadPlan: loadIncidentPlan,
    authorize: (plan) =>
      authorizeGuideAudienceTimeoutRecovery(plan, {
        authorize: (input) => authorizer.authorizeNewGuideAction(input),
      }),
    send: (plan, expectedCohortHash) =>
      executeGuideAudienceTimeoutRecovery(plan, {
        expectedCohortHash,
        openJourney: (input) =>
          resolveJourneyIntent(input, (tx) =>
            openConversationIn(tx, input.igUserId, input.keywordId),
          ),
        sendGatedDm: startCommentGuideRequest,
        recordOutcome: ({ decisionId, outcome }) =>
          logEvent("guide_audience_timeout_recovery_outcome", { decisionId, outcome }),
      }),
    recordRun: (input) => logEvent("guide_audience_timeout_recovery_run", input),
  });
  console.log(output);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  runGuideAudienceTimeoutRecoveryCli()
    .catch((error: unknown) => {
      // Command output stays aggregate-only: never echo raw provider, Graph,
      // comment, or identity data while repairing a production cohort.
      console.error(safeGuideAudienceTimeoutRecoveryFailure(error));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
