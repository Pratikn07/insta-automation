import type {
  GuideAudienceActionSource,
  GuideAudienceConfidence,
  GuideAudienceDecisionKind,
  GuideAudienceDeferReason,
  GuideAudienceOrigin,
  PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type GuideAudienceIdentity = {
  id: string;
  name: string | null;
  username: string | null;
};

export type CurrentGuideAudienceClassification = {
  id: string;
  igUserId: string;
  identityHash: string;
  origin: GuideAudienceOrigin;
  confidence: GuideAudienceConfidence;
  evidence: string;
  provider: string;
  modelId: string;
  method: string;
  classifiedAt: Date;
};

export type CreateGuideAudienceClassificationInput = Omit<
  CurrentGuideAudienceClassification,
  "id"
>;

export type CreateGuideAudienceDecisionInput = {
  igUserId: string;
  identityHash: string;
  kind: GuideAudienceDecisionKind;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
  classificationId?: string;
  deferReason?: GuideAudienceDeferReason;
  provider: string;
  modelId: string;
  method: string;
};

export type GuideAudienceAuthorizationRepository = {
  findCurrentIdentity(igUserId: string): Promise<GuideAudienceIdentity | null>;
  findCurrentClassification(input: {
    igUserId: string;
    identityHash: string;
    method: string;
  }): Promise<CurrentGuideAudienceClassification | null>;
  createClassification(
    input: CreateGuideAudienceClassificationInput,
  ): Promise<CurrentGuideAudienceClassification>;
  createDecision(input: CreateGuideAudienceDecisionInput): Promise<{ id: string }>;
};

export type GuideAudienceAuthorizationDatabase = Pick<
  PrismaClient,
  "igUser" | "guideAudienceClassification" | "guideAudienceDecision"
>;

const classificationSelect = {
  id: true,
  igUserId: true,
  identityHash: true,
  origin: true,
  confidence: true,
  evidence: true,
  provider: true,
  modelId: true,
  method: true,
  classifiedAt: true,
} as const;

/**
 * Persists guide-only audience provenance. The intentionally narrow shape keeps
 * names, usernames, prompts, and raw provider responses out of this audit path.
 */
export function createGuideAudienceAuthorizationRepository(
  database: GuideAudienceAuthorizationDatabase = prisma,
): GuideAudienceAuthorizationRepository {
  return {
    findCurrentIdentity: (igUserId) =>
      database.igUser.findUnique({
        where: { id: igUserId },
        select: { id: true, name: true, username: true },
      }),

    findCurrentClassification: (input) =>
      database.guideAudienceClassification.findUnique({
        where: {
          igUserId_identityHash_method: {
            igUserId: input.igUserId,
            identityHash: input.identityHash,
            method: input.method,
          },
        },
        select: classificationSelect,
      }),

    createClassification: (input) =>
      database.guideAudienceClassification.upsert({
        where: {
          igUserId_identityHash_method: {
            igUserId: input.igUserId,
            identityHash: input.identityHash,
            method: input.method,
          },
        },
        create: input,
        // An identical snapshot/method is immutable. Retaining its first result
        // prevents duplicate callers from silently changing an audit verdict.
        update: {},
        select: classificationSelect,
      }),

    createDecision: async (input) => {
      const row = await database.guideAudienceDecision.create({
        data: {
          igUserId: input.igUserId,
          identityHash: input.identityHash,
          kind: input.kind,
          source: input.source,
          conversationId: input.conversationId ?? null,
          commentId: input.commentId ?? null,
          inboundMessageId: input.inboundMessageId ?? null,
          resourceId: input.resourceId ?? null,
          classificationId: input.classificationId ?? null,
          deferReason: input.deferReason ?? null,
          provider: input.provider,
          modelId: input.modelId,
          method: input.method,
        },
        select: { id: true },
      });
      return row;
    },
  };
}

export const guideAudienceAuthorizationRepository = createGuideAudienceAuthorizationRepository();
