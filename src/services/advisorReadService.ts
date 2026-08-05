import { prisma } from "../lib/prisma.js";
import { redactExcerpt } from "./advisorRedact.js";

/**
 * The only data the advisor can see.
 *
 * Three fixed shapes, no free-form querying, and every row cap enforced in the
 * query rather than trimmed afterwards. The advisor gets aggregates and labels —
 * never a media URL, a signed URL, a token, or a full DM body.
 *
 * A metric whose source is unavailable returns **null**, never 0. "We delivered
 * nothing this week" and "we could not measure deliveries" are different answers,
 * and an advisor that conflates them would state a false fact with confidence.
 */

export type WindowDays = 7 | 30;

export interface BusinessOverview {
  windowDays: WindowDays;
  guideDeliveries: number | null;
  inboundDmCount: number | null;
  needsReplyCount: number | null;
  approvedReplyCount: number | null;
  replyRatePct: number | null;
  topKeyword: null | { keyword: string; triggers: number };
  capturedAt: string;
}

export interface KeywordGuideCatalog {
  items: Array<{
    keyword: string;
    mediaId: string | null;
    resourceName: string;
    kind: string | null;
    theme: string | null;
    ageMinMonths: number | null;
    ageMaxMonths: number | null;
    description: string | null;
    messageCount: number;
  }>;
}

export interface ConversationSummary {
  windowDays: WindowDays;
  totals: { threads: number; needsReply: number; approvedReplies: number };
  threads: Array<{
    username: string | null;
    inboundCount: number;
    outboundCount: number;
    latestAt: string;
    replyState: string;
    keyword: string | null;
    resourceName: string | null;
    topicExcerpt: string | null;
  }>;
}

function windowStart(windowDays: WindowDays): Date {
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
}

/** Run a count, returning null (not 0) when the query itself fails. */
async function safeCount(run: () => Promise<number>): Promise<number | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

export async function getBusinessOverview(input: {
  windowDays: WindowDays;
}): Promise<BusinessOverview> {
  const since = windowStart(input.windowDays);

  const guideDeliveries = await safeCount(() =>
    prisma.eventLog.count({ where: { kind: "sequence_completed", createdAt: { gte: since } } }),
  );
  const inboundDmCount = await safeCount(() =>
    prisma.dmMessage.count({
      where: { direction: "inbound", instagramTimestamp: { gte: since } },
    }),
  );
  const needsReplyCount = await safeCount(() =>
    prisma.dmThread.count({ where: { needsReply: true } }),
  );
  const approvedReplyCount = await safeCount(() =>
    prisma.replyDraft.count({ where: { status: "sent", sentAt: { gte: since } } }),
  );

  // Reply rate only means something when both sides were measurable, and dividing
  // by zero inbound would invent a number.
  const replyRatePct =
    approvedReplyCount !== null && inboundDmCount !== null && inboundDmCount > 0
      ? Math.round((approvedReplyCount / inboundDmCount) * 1000) / 10
      : null;

  return {
    windowDays: input.windowDays,
    guideDeliveries,
    inboundDmCount,
    needsReplyCount,
    approvedReplyCount,
    replyRatePct,
    topKeyword: await topKeywordIn(since),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Most-triggered keyword in the window, from keyword_matched events.
 *
 * The keyword word lives in the event payload rather than a column, so this reads
 * the events and tallies in code. Bounded to the window, and null when nothing
 * fired — the advisor should say "no keyword activity", not name an arbitrary one.
 */
async function topKeywordIn(since: Date): Promise<{ keyword: string; triggers: number } | null> {
  try {
    const events = await prisma.eventLog.findMany({
      where: { kind: "keyword_matched", createdAt: { gte: since } },
      select: { payload: true },
      take: 5_000,
    });
    const tally = new Map<string, number>();
    for (const e of events) {
      const payload = e.payload as { keyword?: unknown } | null;
      const keyword = typeof payload?.keyword === "string" ? payload.keyword : null;
      if (!keyword) continue;
      tally.set(keyword, (tally.get(keyword) ?? 0) + 1);
    }
    let best: { keyword: string; triggers: number } | null = null;
    for (const [keyword, triggers] of tally) {
      if (!best || triggers > best.triggers) best = { keyword, triggers };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The guide catalog as the advisor sees it: what exists and who it is for.
 *
 * Deliberately excludes media URLs and the transcribed page text (`alt_text`).
 * The advisor recommends which guide fits; it does not need to reproduce one, and
 * a signed URL in a model prompt is a leak with no upside.
 */
export async function getKeywordGuideCatalog(input: {
  limit: number;
}): Promise<KeywordGuideCatalog> {
  const rows = await prisma.keyword.findMany({
    where: { active: true },
    take: input.limit,
    orderBy: [{ keyword: "asc" }, { mediaId: "asc" }],
    select: {
      keyword: true,
      mediaId: true,
      resource: {
        select: {
          name: true,
          kind: true,
          theme: true,
          ageMinMonths: true,
          ageMaxMonths: true,
          description: true,
          _count: { select: { messages: true } },
        },
      },
    },
  });

  return {
    items: rows.map((r) => ({
      keyword: r.keyword,
      mediaId: r.mediaId,
      resourceName: r.resource.name,
      kind: r.resource.kind,
      theme: r.resource.theme,
      ageMinMonths: r.resource.ageMinMonths,
      ageMaxMonths: r.resource.ageMaxMonths,
      description: r.resource.description,
      messageCount: r.resource._count.messages,
    })),
  };
}

export async function getConversationSummary(input: {
  windowDays: WindowDays;
  limit: number;
}): Promise<ConversationSummary> {
  const since = windowStart(input.windowDays);

  const threadsInWindow = await prisma.dmThread.count({
    where: { lastMessageAt: { gte: since } },
  });
  const needsReply = await prisma.dmThread.count({ where: { needsReply: true } });
  const approvedReplies = await prisma.replyDraft.count({
    where: { status: "sent", sentAt: { gte: since } },
  });

  const rows = await prisma.dmThread.findMany({
    where: { lastMessageAt: { gte: since } },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: input.limit,
    select: {
      id: true,
      username: true,
      lastMessageAt: true,
      needsReply: true,
      // The newest INBOUND message only, and only to derive a redacted excerpt.
      messages: {
        where: { direction: "inbound" },
        orderBy: { instagramTimestamp: "desc" },
        take: 1,
        select: { text: true },
      },
      drafts: { orderBy: { revision: "desc" }, take: 1, select: { status: true } },
    },
  });

  // Direction counts for exactly the threads being returned: one grouped query,
  // no N+1.
  const grouped = await prisma.dmMessage.groupBy({
    by: ["threadId", "direction"],
    where: { threadId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const byThread = new Map<string, { inbound: number; outbound: number }>();
  for (const row of grouped) {
    const entry = byThread.get(row.threadId) ?? { inbound: 0, outbound: 0 };
    if (row.direction === "inbound") entry.inbound = row._count._all;
    else entry.outbound = row._count._all;
    byThread.set(row.threadId, entry);
  }

  return {
    windowDays: input.windowDays,
    totals: { threads: threadsInWindow, needsReply, approvedReplies },
    threads: rows.map((r) => {
      const counts = byThread.get(r.id);
      return {
        username: r.username,
        inboundCount: counts?.inbound ?? 0,
        outboundCount: counts?.outbound ?? 0,
        latestAt: r.lastMessageAt.toISOString(),
        replyState: r.drafts[0]?.status ?? (r.needsReply ? "needs_review" : "handled"),
        // Keyword/resource attribution per DM thread is not modelled yet — the
        // advisor is told null rather than shown a guess.
        keyword: null,
        resourceName: null,
        topicExcerpt: redactExcerpt(r.messages[0]?.text),
      };
    }),
  };
}
