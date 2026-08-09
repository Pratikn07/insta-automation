import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationFindMany = vi.fn();
const conversationGroupBy = vi.fn();
const conversationCount = vi.fn();
const gateQueueFindMany = vi.fn();
const getIgUsers = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    conversation: {
      findMany: conversationFindMany,
      groupBy: conversationGroupBy,
      count: conversationCount,
    },
    gateQueue: { findMany: gateQueueFindMany },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../config/env.js", () => ({
  env: { DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-01T00:00:00.000Z" },
}));

const { conversationsRouter, conversationScopeWhere, readTrackingAvailability } = await import(
  "./conversations.routes.js"
);

function makeApp() {
  const app = express();
  app.use("/api/conversations", conversationsRouter);
  return app;
}

const TRACKING_START = new Date("2026-08-01T00:00:00.000Z");

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "convo-1",
    igUserId: "ig-1",
    keywordId: "kw-1",
    state: "completed",
    createdAt: new Date("2026-08-05T10:00:00.000Z"),
    completedAt: null,
    canonicalIntentId: "intent-1",
    reconciliationReason: "oldest_valid_owner",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    recoveryReminders: [],
    ownedIntents: [
      { id: "intent-1", _count: { aliasConversations: 2 } },
    ],
    canonicalIntent: {
      id: "intent-1",
      canonicalConversation: { id: "convo-1" },
    },
    ...overrides,
  };
}

function reminder(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    status: "waiting",
    triggerKind: "no_confirmed_read",
    eligibleAt: new Date("2026-08-05T20:00:00.000Z"),
    sentAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  conversationFindMany.mockReset().mockResolvedValue([]);
  conversationGroupBy.mockReset().mockResolvedValue([]);
  conversationCount.mockReset().mockResolvedValue(0);
  gateQueueFindMany.mockReset().mockResolvedValue([]);
  getIgUsers.mockReset().mockResolvedValue({});
});

describe("conversationScopeWhere", () => {
  it("defaults operations to canonical owners plus unreconciled history", () => {
    expect(conversationScopeWhere("canonical")).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
    });
  });

  it("keeps every record in explicit raw mode", () => {
    expect(conversationScopeWhere("raw")).toEqual({});
  });
});

// The whole point of this field is to distinguish "we looked and there was no
// read" from "we were not watching yet". Inferring it from the conversation's
// current state would make every pre-launch journey look like a tracked miss.
describe("readTrackingAvailability", () => {
  it("is tracked whenever a recovery row exists, whatever its status", () => {
    for (const status of ["waiting", "control", "sent", "suppressed", "cancelled"]) {
      expect(
        readTrackingAvailability(reminder({ status }), new Date("2026-07-01"), TRACKING_START),
      ).toBe("tracked");
    }
  });

  it("is predates_tracking for a conversation older than the tracking start", () => {
    expect(readTrackingAvailability(null, new Date("2026-07-31T23:59:59Z"), TRACKING_START)).toBe(
      "predates_tracking",
    );
  });

  it("is not_available for a later conversation with no row", () => {
    expect(readTrackingAvailability(null, new Date("2026-08-05T00:00:00Z"), TRACKING_START)).toBe(
      "not_available",
    );
  });

  // Without a configured start we cannot claim anything predates tracking.
  it("is not_available when no tracking start is configured", () => {
    expect(readTrackingAvailability(null, new Date("2020-01-01"), null)).toBe("not_available");
  });
});

describe("GET /", () => {
  it("uses canonical scope by default", async () => {
    await request(makeApp()).get("/api/conversations");

    expect(conversationFindMany.mock.calls[0]![0].where).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
    });
  });

  it("includes aliases only in explicit raw mode", async () => {
    await request(makeApp()).get("/api/conversations?mode=raw");
    expect(conversationFindMany.mock.calls[0]![0].where).toEqual({});
  });

  it("combines state and canonical scope without dropping either", async () => {
    await request(makeApp()).get("/api/conversations?state=expired");
    expect(conversationFindMany.mock.calls[0]![0].where).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
      state: "expired",
    });
  });

  it("labels an alias and identifies its canonical owner", async () => {
    conversationFindMany.mockResolvedValue([
      conversation({
        id: "alias-1",
        canonicalIntentId: "intent-1",
        reconciliationReason: "duplicate_inside_window",
        ownedIntents: [],
        canonicalIntent: {
          id: "intent-1",
          canonicalConversation: { id: "canonical-1" },
        },
      }),
    ]);

    const res = await request(makeApp()).get("/api/conversations?mode=raw");

    expect(res.body.items[0]).toMatchObject({
      historyRole: "alias",
      canonicalOwner: { id: "canonical-1" },
      canonicalConversationId: "canonical-1",
      aliasCount: 0,
      reconciliationReason: "duplicate_inside_window",
    });
  });

  it("labels canonical owners with their alias count", async () => {
    conversationFindMany.mockResolvedValue([conversation()]);

    const res = await request(makeApp()).get("/api/conversations");

    expect(res.body.items[0]).toMatchObject({
      historyRole: "canonical",
      canonicalOwner: { id: "convo-1" },
      aliasCount: 2,
    });
  });

  it("labels legacy records with no intent as unreconciled", async () => {
    conversationFindMany.mockResolvedValue([
      conversation({
        canonicalIntentId: null,
        reconciliationReason: null,
        ownedIntents: [],
      }),
    ]);

    const res = await request(makeApp()).get("/api/conversations");

    expect(res.body.items[0]).toMatchObject({
      historyRole: "unreconciled",
      canonicalOwner: null,
      aliasCount: 0,
      reconciliationReason: null,
    });
  });

  it("attaches the newest recovery row as a bounded summary", async () => {
    conversationFindMany.mockResolvedValue([
      conversation({ recoveryReminders: [reminder({ id: "rec-newest" })] }),
    ]);

    const res = await request(makeApp()).get("/api/conversations");

    expect(res.status).toBe(200);
    expect(res.body.items[0].recovery).toEqual({
      id: "rec-newest",
      status: "waiting",
      triggerKind: "no_confirmed_read",
      eligibleAt: "2026-08-05T20:00:00.000Z",
      sentAt: null,
    });
    expect(res.body.items[0].readTracking).toBe("tracked");
  });

  it("selects at most one recovery row per conversation, newest first", async () => {
    await request(makeApp()).get("/api/conversations");

    const include = conversationFindMany.mock.calls[0]![0].include;
    expect(include.recoveryReminders.take).toBe(1);
    expect(include.recoveryReminders.orderBy).toEqual({ createdAt: "desc" });
  });

  it("returns a null summary and an availability reason when no row exists", async () => {
    conversationFindMany.mockResolvedValue([
      conversation({ createdAt: new Date("2026-07-15T00:00:00.000Z") }),
    ]);

    const res = await request(makeApp()).get("/api/conversations");

    expect(res.body.items[0].recovery).toBeNull();
    expect(res.body.items[0].readTracking).toBe("predates_tracking");
  });

  // The summary is for a badge, not a payload: the copy we would post and the
  // provider identifiers stay out of it.
  it("never exposes the public reply text through the summary", async () => {
    conversationFindMany.mockResolvedValue([
      conversation({ recoveryReminders: [reminder()] }),
    ]);

    const res = await request(makeApp()).get("/api/conversations");

    const include = conversationFindMany.mock.calls[0]![0].include;
    expect(include.recoveryReminders.select).not.toHaveProperty("publicReplyText");
    expect(JSON.stringify(res.body)).not.toContain("publicReplyText");
  });
});

describe("GET /counts", () => {
  it("uses the same canonical predicate as the default list", async () => {
    conversationGroupBy.mockResolvedValue([
      { state: "awaiting_done", _count: { _all: 2 } },
    ]);

    const res = await request(makeApp()).get("/api/conversations/counts");

    expect(res.status).toBe(200);
    expect(conversationGroupBy.mock.calls[0]![0].where).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
    });
  });

  it("uses raw scope for both totals and retrying rows", async () => {
    gateQueueFindMany.mockResolvedValue([{ conversationId: "convo-1" }]);
    conversationCount.mockResolvedValue(1);

    const res = await request(makeApp()).get("/api/conversations/counts?mode=raw");

    expect(res.status).toBe(200);
    expect(conversationGroupBy.mock.calls[0]![0].where).toEqual({});
    expect(conversationCount.mock.calls[0]![0].where).toEqual({
      id: { in: ["convo-1"] },
      state: "awaiting_done",
    });
  });

  it("intersects retrying rows with canonical scope", async () => {
    gateQueueFindMany.mockResolvedValue([{ conversationId: "convo-1" }]);
    conversationCount.mockResolvedValue(1);

    await request(makeApp()).get("/api/conversations/counts");

    expect(conversationCount.mock.calls[0]![0].where).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
      id: { in: ["convo-1"] },
      state: "awaiting_done",
    });
  });
});
