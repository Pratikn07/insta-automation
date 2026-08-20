import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getIgUsers } from "../services/igUserService.js";
import { env } from "../config/env.js";
import {
  conversationHistoryRole,
  operationalConversationWhere,
} from "../services/canonicalConversation.js";
import { asyncRouter } from "./asyncRouter.js";

/**
 * Enough recovery state for a badge, and no more: the copy we would post and
 * the provider identifiers stay out of the conversations list.
 */
const RECOVERY_SUMMARY_SELECT = {
  id: true,
  status: true,
  triggerKind: true,
  eligibleAt: true,
  sentAt: true,
} as const;

type RecoverySummaryRow = {
  id: string;
  status: string;
  triggerKind: string;
  eligibleAt: Date;
  sentAt: Date | null;
};

export type ReadTrackingAvailability = "tracked" | "predates_tracking" | "not_available";

/**
 * Why a journey has no read information.
 *
 * Derived only from whether a recovery row exists and when the conversation was
 * created — never from the conversation's current state. A completed journey
 * from before launch has no recovery row for the same reason an ineligible one
 * does, and reporting either as "no confirmed read" would be a claim we never
 * measured.
 */
export function readTrackingAvailability(
  recovery: RecoverySummaryRow | null,
  conversationCreatedAt: Date,
  trackingStart: Date | null,
): ReadTrackingAvailability {
  if (recovery) return "tracked";
  if (trackingStart && conversationCreatedAt < trackingStart) return "predates_tracking";
  return "not_available";
}

function trackingStartAt(): Date | null {
  const raw = env.DM_RECOVERY_EXPERIMENT_START_AT;
  return raw ? new Date(raw) : null;
}

function summariseRecovery(recovery: RecoverySummaryRow | null): Record<string, unknown> | null {
  if (!recovery) return null;
  return {
    id: recovery.id,
    status: recovery.status,
    triggerKind: recovery.triggerKind,
    eligibleAt: recovery.eligibleAt.toISOString(),
    sentAt: recovery.sentAt ? recovery.sentAt.toISOString() : null,
  };
}

export const conversationsRouter = asyncRouter();

const listQuerySchema = z.object({
  state: z.enum(["awaiting_done", "completed", "expired"]).optional(),
  mode: z.enum(["canonical", "raw"]).default("canonical"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

export type ConversationMode = "canonical" | "raw";

export function conversationScopeWhere(mode: ConversationMode): Prisma.ConversationWhereInput {
  return mode === "raw" ? {} : operationalConversationWhere();
}

conversationsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { state, mode, limit, cursor } = parsed.data;
  const scope = conversationScopeWhere(mode);

  const rows = await prisma.conversation.findMany({
    where: { ...scope, ...(state ? { state } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: {
      keyword: { select: { id: true, keyword: true } },
      // At most one row per conversation: a bounded badge, never an N+1.
      recoveryReminders: {
        take: 1,
        orderBy: { createdAt: "desc" },
        select: RECOVERY_SUMMARY_SELECT,
      },
      canonicalIntent: {
        select: {
          id: true,
          canonicalConversation: { select: { id: true } },
        },
      },
      ownedIntents: {
        select: {
          id: true,
          _count: { select: { aliasConversations: true } },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Attach resolved usernames (one batched query, no N+1).
  const users = await getIgUsers(items.map((c) => c.igUserId));

  // Derive each awaiting row's *delivery* status so the UI can tell apart "we
  // DM'd them, waiting on their reply" from "the DM never landed — auto-retrying".
  // The signal is the gate queue: a row exists ONLY when a comment-gate failed,
  // and status "pending" means it's still bouncing. (gatedAt is NOT reliable — the
  // inbound-DM gate path never stamps it.) One batched query, no N+1.
  const deliveryById = await deliveryStatusFor(
    items.filter((c) => c.state === "awaiting_done").map((c) => c.id),
  );

  const trackingStart = trackingStartAt();

  const withUsers = items.map(({ recoveryReminders, ownedIntents, canonicalIntent, ...c }) => {
    const historyRole = conversationHistoryRole({
      conversationId: c.id,
      canonicalIntentId: c.canonicalIntentId,
      canonicalConversationId: canonicalIntent?.canonicalConversation?.id,
    });
    const aliasCount = ownedIntents.reduce(
      (total, intent) => total + intent._count.aliasConversations,
      0,
    );
    const canonicalOwner =
      historyRole === "canonical"
        ? { id: c.id }
        : historyRole === "alias" && canonicalIntent?.canonicalConversation
          ? { id: canonicalIntent.canonicalConversation.id }
          : null;

    return {
      ...c,
      historyRole,
      canonicalOwner,
      canonicalConversationId: canonicalOwner?.id ?? null,
      aliasCount,
      recovery: summariseRecovery(recoveryReminders[0] ?? null),
      readTracking: readTrackingAvailability(
        recoveryReminders[0] ?? null,
        c.createdAt,
        trackingStart,
      ),
      username: users[c.igUserId]?.username ?? null,
      name: users[c.igUserId]?.name ?? null,
      isFollower: users[c.igUserId]?.isFollower ?? null,
      followerCount: users[c.igUserId]?.followerCount ?? null,
      isVerified: users[c.igUserId]?.isVerified ?? null,
      delivery: c.state === "awaiting_done" ? (deliveryById.get(c.id) ?? "delivered") : null,
    };
  });

  res.json({
    items: withUsers,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  });
});

export type DeliveryStatus = "delivered" | "retrying";

/**
 * Map conversationId → delivery status for the given awaiting_done rows.
 * A conversation has a gate_queue row only if its comment-gate DM failed; while
 * that row is "pending" the gate hasn't landed yet (worker still retrying), so we
 * surface "retrying". Anything without a live pending row counts as "delivered"
 * — either the gate sent first try, or a retry already succeeded (status "sent").
 * Note: an exhausted gate never appears here — such a conversation has gatedAt
 * null and is swept to "expired" at the 48h mark, well before the 7-day window
 * closes, so it leaves the awaiting bucket on its own.
 */
async function deliveryStatusFor(ids: string[]): Promise<Map<string, DeliveryStatus>> {
  const map = new Map<string, DeliveryStatus>();
  if (ids.length === 0) return map;
  const pending = await prisma.gateQueue.findMany({
    where: { conversationId: { in: ids }, status: "pending" },
    select: { conversationId: true },
  });
  for (const g of pending) map.set(g.conversationId, "retrying");
  return map;
}

/**
 * Per-state counts for the tab labels, plus how many of the "waiting" bucket are
 * actually unreached (gate still retrying) vs genuinely waiting on a reply. Lets
 * the UI show "Waiting 416 · Delivered 351 · No reply 300" at a glance, and split
 * the waiting count if we ever want to. One grouped query + one gate count.
 */
const countsQuerySchema = z.object({
  mode: z.enum(["canonical", "raw"]).default("canonical"),
});

conversationsRouter.get("/counts", async (req, res) => {
  const parsed = countsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const scope = conversationScopeWhere(parsed.data.mode);

  const [grouped, pendingGates] = await Promise.all([
    prisma.conversation.groupBy({ where: scope, by: ["state"], _count: { _all: true } }),
    // Conversations with a still-bouncing gate. GateQueue has no Prisma relation
    // to Conversation, so we intersect in code rather than via a nested filter.
    prisma.gateQueue.findMany({
      where: { status: "pending" },
      select: { conversationId: true },
      distinct: ["conversationId"],
    }),
  ]);

  const byState = { awaiting_done: 0, completed: 0, expired: 0 };
  for (const g of grouped) byState[g.state] = g._count._all;

  // Only count pending gates whose conversation is still awaiting (a pending gate
  // on an already-expired convo must not inflate the waiting bucket).
  const pendingIds = pendingGates.map((g) => g.conversationId);
  const retryingCount =
    pendingIds.length === 0
      ? 0
      : await prisma.conversation.count({
          where: { ...scope, id: { in: pendingIds }, state: "awaiting_done" },
        });

  res.json({
    awaiting_done: byState.awaiting_done,
    completed: byState.completed,
    expired: byState.expired,
    // Subsets of awaiting_done: waitingOnReply + retrying === awaiting_done.
    retrying: retryingCount,
    waitingOnReply: Math.max(byState.awaiting_done - retryingCount, 0),
  });
});

function strField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

conversationsRouter.get("/:id/events", async (req, res) => {
  const id = req.params.id;
  const convo = await prisma.conversation.findUnique({
    where: { id },
    include: {
      // Pull the configured copy so the panel can render the ACTUAL messages we
      // sent (public reply, gate DM, freebie steps) as chat bubbles — these live
      // on the keyword/resource, never in event payloads.
      keyword: {
        select: {
          id: true,
          keyword: true,
          publicReply: true,
          gateMessage: true,
          resource: {
            select: {
              id: true,
              name: true,
              messages: { orderBy: { order: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!convo) return res.status(404).json({ error: "not_found" });

  const events = await prisma.eventLog.findMany({
    where: { payload: { path: ["conversationId"], equals: id } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  // Resolve the ORIGINAL inbound message that triggered this conversation. Its
  // text isn't conversation-scoped: a comment lives on comment_received (joined by
  // commentId, which keyword_matched records), a DM lives on message_received
  // (joined by senderId). Either way we surface the user's actual words.
  const km = events.find((e) => e.kind === "keyword_matched");
  const commentId = strField(km?.payload, "commentId");
  const anchor = km?.createdAt ?? convo.createdAt;
  const entry: "comment" | "dm" = commentId ? "comment" : "dm";

  let inboundText: string | null = null;
  if (commentId) {
    const cr = await prisma.eventLog.findFirst({
      where: { kind: "comment_received", payload: { path: ["commentId"], equals: commentId } },
      orderBy: { createdAt: "asc" },
    });
    inboundText = strField(cr?.payload, "text");
  } else {
    const mr = await prisma.eventLog.findFirst({
      where: {
        kind: "message_received",
        payload: { path: ["senderId"], equals: convo.igUserId },
        createdAt: { lte: anchor },
      },
      orderBy: { createdAt: "desc" },
    });
    inboundText = strField(mr?.payload, "text");
  }

  // The latest gate-retry row (if the gate DM failed and was queued) so the panel
  // can reassure: "retrying automatically, attempt N, window open until …".
  const gate = await prisma.gateQueue.findFirst({
    where: { conversationId: id },
    orderBy: { createdAt: "desc" },
  });

  const users = await getIgUsers([convo.igUserId]);
  const u = users[convo.igUserId];
  res.json({
    conversation: {
      ...convo,
      username: u?.username ?? null,
      name: u?.name ?? null,
      isFollower: u?.isFollower ?? null,
      followerCount: u?.followerCount ?? null,
      isVerified: u?.isVerified ?? null,
    },
    events,
    entry,
    inboundText,
    gate: gate
      ? {
          status: gate.status,
          attempts: gate.attempts,
          nextAttemptAt: gate.nextAttemptAt,
          commentAt: gate.commentAt,
          lastError: gate.lastError,
        }
      : null,
  });
});
