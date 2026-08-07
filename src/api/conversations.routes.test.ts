import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationFindMany = vi.fn();
const gateQueueFindMany = vi.fn();
const getIgUsers = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    conversation: { findMany: conversationFindMany },
    gateQueue: { findMany: gateQueueFindMany },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../config/env.js", () => ({
  env: { DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-01T00:00:00.000Z" },
}));

const { conversationsRouter, readTrackingAvailability } = await import("./conversations.routes.js");

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
    keyword: { id: "kw-1", keyword: "SLEEP" },
    recoveryReminders: [],
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
  gateQueueFindMany.mockReset().mockResolvedValue([]);
  getIgUsers.mockReset().mockResolvedValue({});
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
