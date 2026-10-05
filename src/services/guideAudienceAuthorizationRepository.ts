import type {
  GuideAudienceActionSource,
  GuideAudienceConfidence,
  GuideAudienceDecisionKind,
  GuideAudienceDeferReason,
  GuideAudienceOrigin,
  PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/** Identity plus the stored verdict, in one read. */
export type GuideAudienceSubject = {
  id: string;
  username: string | null;
  name: string | null;
  inferredOrigin: string | null;
  originConfidence: string | null;
  originMethod: string | null;
};

export type CreateGuideAudienceDecisionInput = {
  igUserId: string;
  identityHash: string;
  kind: GuideAudienceDecisionKind;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
  origin?: GuideAudienceOrigin;
  confidence?: GuideAudienceConfidence;
  deferReason?: GuideAudienceDeferReason;
  provider: string;
  modelId: string;
  method: string;
};

export type GuideAudienceAuthorizationRepository = {
  findAudienceSubject(igUserId: string): Promise<GuideAudienceSubject | null>;
  createDecision(input: CreateGuideAudienceDecisionInput): Promise<{ id: string }>;
};

export type GuideAudienceAuthorizationDatabase = Pick<
  PrismaClient,
  "igUser" | "guideAudienceDecision"
>;

/**
 * Persists guide-only audience provenance. The intentionally narrow decision
 * shape keeps names, usernames, prompts, and raw provider responses out of this
 * audit path — only a bounded verdict and a hash of the identity snapshot.
 */
export function createGuideAudienceAuthorizationRepository(
  database: GuideAudienceAuthorizationDatabase = prisma,
): GuideAudienceAuthorizationRepository {
  return {
    // An absent row is a miss, not an error: rememberUsername runs before the
    // gate on the comment path, so absence means a DM-only sender we have
    // never resolved.
    findAudienceSubject: (igUserId) =>
      database.igUser.findUnique({
        where: { id: igUserId },
        select: {
          id: true,
          username: true,
          name: true,
          inferredOrigin: true,
          originConfidence: true,
          originMethod: true,
        },
      }),

    createDecision: (input) =>
      database.guideAudienceDecision.create({
        data: {
          igUserId: input.igUserId,
          identityHash: input.identityHash,
          kind: input.kind,
          source: input.source,
          conversationId: input.conversationId ?? null,
          commentId: input.commentId ?? null,
          inboundMessageId: input.inboundMessageId ?? null,
          resourceId: input.resourceId ?? null,
          origin: input.origin ?? null,
          confidence: input.confidence ?? null,
          deferReason: input.deferReason ?? null,
          provider: input.provider,
          modelId: input.modelId,
          method: input.method,
        },
        select: { id: true },
      }),
  };
}

export const guideAudienceAuthorizationRepository = createGuideAudienceAuthorizationRepository();
