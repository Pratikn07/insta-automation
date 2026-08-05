import { describe, it, expect, vi, beforeEach } from "vitest";

const eventLog = { count: vi.fn(), findMany: vi.fn() };
const dmMessage = { count: vi.fn(), groupBy: vi.fn() };
const dmThread = { count: vi.fn(), findMany: vi.fn() };
const replyDraft = { count: vi.fn() };
const keyword = { findMany: vi.fn() };

vi.mock("../lib/prisma.js", () => ({
  prisma: { eventLog, dmMessage, dmThread, replyDraft, keyword },
}));

const { getBusinessOverview, getKeywordGuideCatalog, getConversationSummary } = await import(
  "./advisorReadService.js"
);

beforeEach(() => {
  for (const model of [eventLog, dmMessage, dmThread, replyDraft, keyword]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  eventLog.count.mockResolvedValue(42);
  eventLog.findMany.mockResolvedValue([
    { payload: { keyword: "SLEEP" } },
    { payload: { keyword: "SLEEP" } },
    { payload: { keyword: "POTTY" } },
  ]);
  dmMessage.count.mockResolvedValue(18);
  dmMessage.groupBy.mockResolvedValue([]);
  dmThread.count.mockResolvedValue(3);
  dmThread.findMany.mockResolvedValue([]);
  replyDraft.count.mockResolvedValue(5);
  keyword.findMany.mockResolvedValue([]);
});

describe("getBusinessOverview", () => {
  it("returns measured values and a computed reply rate", async () => {
    const result = await getBusinessOverview({ windowDays: 7 });

    expect(result).toMatchObject({
      windowDays: 7,
      guideDeliveries: 42,
      inboundDmCount: 18,
      needsReplyCount: 3,
      approvedReplyCount: 5,
      replyRatePct: 27.8, // 5/18 → 27.8%
      topKeyword: { keyword: "SLEEP", triggers: 2 },
    });
    expect(typeof result.capturedAt).toBe("string");
  });

  // The whole point of the null contract: "we delivered nothing" and "we could not
  // measure deliveries" are different answers, and an advisor must not conflate them.
  it("returns null rather than zero when a metric's source fails", async () => {
    eventLog.count.mockRejectedValue(new Error("relation missing"));
    const result = await getBusinessOverview({ windowDays: 7 });
    expect(result.guideDeliveries).toBeNull();
    expect(result.guideDeliveries).not.toBe(0);
  });

  it("returns a null reply rate rather than dividing by zero inbound", async () => {
    dmMessage.count.mockResolvedValue(0);
    const result = await getBusinessOverview({ windowDays: 30 });
    expect(result.inboundDmCount).toBe(0);
    expect(result.replyRatePct).toBeNull();
  });

  it("returns a null reply rate when either side is unmeasurable", async () => {
    replyDraft.count.mockRejectedValue(new Error("db down"));
    const result = await getBusinessOverview({ windowDays: 7 });
    expect(result.approvedReplyCount).toBeNull();
    expect(result.replyRatePct).toBeNull();
  });

  it("reports no top keyword rather than inventing one", async () => {
    eventLog.findMany.mockResolvedValue([]);
    const result = await getBusinessOverview({ windowDays: 7 });
    expect(result.topKeyword).toBeNull();
  });

  it("bounds every count to the requested window", async () => {
    await getBusinessOverview({ windowDays: 7 });
    const [[call]] = eventLog.count.mock.calls as [[{ where: { createdAt: { gte: Date } } }]];
    const ageMs = Date.now() - call.where.createdAt.gte.getTime();
    expect(ageMs).toBeGreaterThan(6.9 * 86_400_000);
    expect(ageMs).toBeLessThan(7.1 * 86_400_000);
  });
});

describe("getKeywordGuideCatalog", () => {
  beforeEach(() => {
    keyword.findMany.mockResolvedValue([
      {
        keyword: "PICKY",
        mediaId: null,
        resource: {
          name: "Picky",
          kind: "guide",
          theme: "eating",
          ageMinMonths: 12,
          ageMaxMonths: 72,
          description: "Toddler Feeding Handbook",
          _count: { messages: 11 },
        },
      },
    ]);
  });

  it("returns the routing facets the advisor needs", async () => {
    const result = await getKeywordGuideCatalog({ limit: 50 });
    expect(result.items[0]).toEqual({
      keyword: "PICKY",
      mediaId: null,
      resourceName: "Picky",
      kind: "guide",
      theme: "eating",
      ageMinMonths: 12,
      ageMaxMonths: 72,
      description: "Toddler Feeding Handbook",
      messageCount: 11,
    });
  });

  // A signed Storage URL in a model prompt is a leak with no upside — the advisor
  // recommends a guide, it does not reproduce one.
  it("never selects media URLs or transcribed page text", async () => {
    await getKeywordGuideCatalog({ limit: 50 });
    const [[call]] = keyword.findMany.mock.calls as [[{ select: Record<string, unknown> }]];
    const selection = JSON.stringify(call.select);
    expect(selection).not.toContain("mediaUrl");
    expect(selection).not.toContain("altText");
    expect(selection).not.toContain("body");
  });

  it("enforces the row cap in the query", async () => {
    await getKeywordGuideCatalog({ limit: 5 });
    const [[call]] = keyword.findMany.mock.calls as [[{ take: number; where: unknown }]];
    expect(call.take).toBe(5);
    expect(call.where).toEqual({ active: true });
  });
});

describe("getConversationSummary", () => {
  beforeEach(() => {
    dmThread.findMany.mockResolvedValue([
      {
        id: "thread-1",
        username: "amanda_home",
        lastMessageAt: new Date("2026-08-04T10:00:00.000Z"),
        needsReply: true,
        messages: [{ text: "my child will not sleep, email me at a@b.com" }],
        drafts: [{ status: "pending_approval" }],
      },
    ]);
    dmMessage.groupBy.mockResolvedValue([
      { threadId: "thread-1", direction: "inbound", _count: { _all: 2 } },
      { threadId: "thread-1", direction: "outbound", _count: { _all: 1 } },
    ]);
  });

  it("returns bounded thread summaries with counts and reply state", async () => {
    const result = await getConversationSummary({ windowDays: 7, limit: 10 });
    expect(result.threads[0]).toMatchObject({
      username: "amanda_home",
      inboundCount: 2,
      outboundCount: 1,
      replyState: "pending_approval",
    });
  });

  it("never returns full DM bodies from conversation_summary", async () => {
    const result = await getConversationSummary({ windowDays: 7, limit: 10 });
    // The excerpt is redacted and capped; the raw body must not survive.
    expect(JSON.stringify(result)).not.toContain("a@b.com");
    expect(result.threads[0]!.topicExcerpt).toContain("[email]");
  });

  it("derives reply state from the thread when there is no draft", async () => {
    dmThread.findMany.mockResolvedValue([
      {
        id: "thread-2",
        username: "geri",
        lastMessageAt: new Date(),
        needsReply: true,
        messages: [],
        drafts: [],
      },
    ]);
    const result = await getConversationSummary({ windowDays: 7, limit: 10 });
    expect(result.threads[0]!.replyState).toBe("needs_review");
  });

  it("counts directions with ONE grouped query, not per thread", async () => {
    await getConversationSummary({ windowDays: 7, limit: 25 });
    expect(dmMessage.groupBy).toHaveBeenCalledTimes(1);
  });

  it("enforces the row cap in the query", async () => {
    await getConversationSummary({ windowDays: 7, limit: 3 });
    const [[call]] = dmThread.findMany.mock.calls as [[{ take: number }]];
    expect(call.take).toBe(3);
  });
});
