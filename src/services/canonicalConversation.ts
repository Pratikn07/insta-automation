import type { ConversationState, Prisma } from "@prisma/client";

export type ConversationHistoryRole = "unreconciled" | "canonical" | "alias";

export type CanonicalConversationResolution = {
  requestedConversation: {
    id: string;
    igUserId: string;
    keywordId: string;
    state: ConversationState;
    completedAt: Date | null;
    canonicalIntentId: string | null;
  };
  role: ConversationHistoryRole;
  canonicalIntentId: string | null;
  canonicalConversationId: string | null;
  intentCompletedAt: Date | null;
  mayOwnOperationalWork: boolean;
};

export function conversationHistoryRole(input: {
  conversationId: string;
  canonicalIntentId: string | null;
  canonicalConversationId: string | null | undefined;
}): ConversationHistoryRole {
  if (!input.canonicalIntentId) return "unreconciled";
  return input.canonicalConversationId === input.conversationId ? "canonical" : "alias";
}

/** Query form of the same rule, for list/DONE/count paths. */
export function operationalConversationWhere(): Prisma.ConversationWhereInput {
  return { OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }] };
}

/** Resolve exact role when a caller has a concrete conversation id. */
export async function resolveCanonicalConversation(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<CanonicalConversationResolution | null> {
  const row = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      igUserId: true,
      keywordId: true,
      state: true,
      completedAt: true,
      canonicalIntentId: true,
      canonicalIntent: {
        select: {
          id: true,
          canonicalConversationId: true,
          completedAt: true,
        },
      },
    },
  });
  if (!row) return null;

  const role = conversationHistoryRole({
    conversationId: row.id,
    canonicalIntentId: row.canonicalIntentId,
    canonicalConversationId: row.canonicalIntent?.canonicalConversationId,
  });
  return {
    requestedConversation: {
      id: row.id,
      igUserId: row.igUserId,
      keywordId: row.keywordId,
      state: row.state,
      completedAt: row.completedAt,
      canonicalIntentId: row.canonicalIntentId,
    },
    role,
    canonicalIntentId: row.canonicalIntentId,
    canonicalConversationId: row.canonicalIntent?.canonicalConversationId ?? null,
    intentCompletedAt: row.canonicalIntent?.completedAt ?? null,
    mayOwnOperationalWork: role !== "alias",
  };
}
