import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const updateMany = vi.fn();
const groupBy = vi.fn();
const count = vi.fn();
const getIgUsers = vi.fn();
const getRecoveryHealthSnapshot = vi.fn();
const logEvent = vi.fn();

const eventFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { findMany, findUnique, updateMany, groupBy, count },
    eventLog: { findFirst: eventFindFirst },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../services/dmRecoveryHealth.js", () => ({ getRecoveryHealthSnapshot }));
vi.mock("../services/eventLogger.js", () => ({ logEvent }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const envMock = {
  DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-v1",
  DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-01T00:00:00.000Z",
  DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-15T00:00:00.000Z",
  DM_RECOVERY_WESTERN_ONLY: true,
};
vi.mock("../config/env.js", () => ({ env: envMock }));

const { recoveryRemindersRouter, viewWhere } = await import("./recoveryReminders.routes.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/recovery-reminders", recoveryRemindersRouter);
  return app;
}

const NOW = new Date("2026-08-06T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    conversationId: "convo-1",
    igUserId: "ig-1",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    mediaId: "media-1",
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    acceptedAt: new Date("2026-08-06T00:00:00.000Z"),
    eligibleAt: new Date("2026-08-06T10:00:00.000Z"),
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: new Date("2026-08-05T23:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [findMany, findUnique, updateMany, groupBy, count, getIgUsers, getRecoveryHealthSnapshot, logEvent, eventFindFirst]) {
    fn.mockReset();
  }
  findMany.mockResolvedValue([]);
  groupBy.mockResolvedValue([]);
  count.mockResolvedValue(0);
  getIgUsers.mockResolvedValue({});
  getRecoveryHealthSnapshot.mockResolvedValue({ circuitOpen: false });
  eventFindFirst.mockResolvedValue(null);
  envMock.DM_RECOVERY_WESTERN_ONLY = true;
});

describe("viewWhere", () => {
  it.each([
    ["scheduled", { status: "waiting", eligibleAt: { gt: NOW } }],
    ["ready", { status: "waiting", eligibleAt: { lte: NOW } }],
    ["sent", { status: "sent" }],
    ["suppressed", { status: "suppressed" }],
    ["control", { status: "control" }],
    [
      "attention",
      { status: { in: ["send_failed", "send_uncertain", "tracking_unavailable"] } },
    ],
    ["all", {}],
  ])("maps the %s view", (view, expected) => {
    expect(viewWhere(view as never, NOW)).toEqual(expected);
  });
});

describe("GET /", () => {
  it("rejects an unknown view", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders?view=nope");
    expect(res.status).toBe(400);
  });

  it("rejects a non-uuid cursor", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders?cursor=abc");
    expect(res.status).toBe(400);
  });

  it("rejects a limit above the maximum", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders?limit=101");
    expect(res.status).toBe(400);
  });

  it("returns the stable row shape with the person resolved", async () => {
    findMany.mockResolvedValue([row()]);
    getIgUsers.mockResolvedValue({ "ig-1": { username: "sarah", name: "Sarah" } });

    const res = await request(makeApp()).get("/api/recovery-reminders");

    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toEqual({
      id: "rec-1",
      conversationId: "convo-1",
      igUserId: "ig-1",
      username: "sarah",
      name: "Sarah",
      keyword: { id: "kw-1", keyword: "SLEEP" },
      media: { id: "media-1", permalink: null, caption: null },
      triggerKind: "no_confirmed_read",
      status: "waiting",
      cohort: "treatment",
      acceptedAt: "2026-08-06T00:00:00.000Z",
      eligibleAt: "2026-08-06T10:00:00.000Z",
      seenAt: null,
      engagedAt: null,
      firstEngagementKind: null,
      suppressionReason: null,
      sentAt: null,
      attempts: 0,
      lastAttemptAt: null,
      lastErrorCategory: null,
      reviewedAt: null,
      createdAt: "2026-08-05T23:00:00.000Z",
    });
  });

  // publicReplyText is the message we would post; it is not the owner's to read
  // from a list endpoint, and raw provider data must never appear here.
  it("never leaks the public reply text or provider fields", async () => {
    findMany.mockResolvedValue([row()]);
    const res = await request(makeApp()).get("/api/recovery-reminders");

    const select = findMany.mock.calls[0]![0].select;
    expect(select).not.toHaveProperty("publicReplyText");
    expect(JSON.stringify(res.body)).not.toContain("publicReplyText");
  });

  it("resolves every person in one batched call", async () => {
    findMany.mockResolvedValue([row({ id: "a", igUserId: "ig-1" }), row({ id: "b", igUserId: "ig-2" })]);

    await request(makeApp()).get("/api/recovery-reminders");

    expect(getIgUsers).toHaveBeenCalledOnce();
    expect(getIgUsers).toHaveBeenCalledWith(["ig-1", "ig-2"]);
  });

  // Prisma's `skip: 1` steps over the cursor row, so the cursor must be the LAST
  // row of THIS page. Pointing it at the extra limit+1 row made the next page
  // start after that row and drop it — one lost record per page boundary.
  it("pages with limit + 1 and hands back the last row of this page", async () => {
    findMany.mockResolvedValue([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);

    const res = await request(makeApp()).get("/api/recovery-reminders?limit=2");

    expect(findMany.mock.calls[0]![0].take).toBe(3);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(res.body.nextCursor).toBe("b");
  });

  it("skips the cursor row itself so no record is lost or repeated", async () => {
    findMany.mockResolvedValue([row({ id: "c" })]);

    await request(makeApp()).get("/api/recovery-reminders?limit=2&cursor=11111111-1111-4111-8111-111111111111");

    const args = findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
    expect(args.skip).toBe(1);
  });

  it("returns a null cursor on the last page", async () => {
    findMany.mockResolvedValue([row({ id: "a" })]);
    const res = await request(makeApp()).get("/api/recovery-reminders?limit=2");
    expect(res.body.nextCursor).toBeNull();
  });

  it("applies the keyword and cohort filters", async () => {
    await request(makeApp()).get(
      "/api/recovery-reminders?cohort=control&keywordId=11111111-1111-4111-8111-111111111111",
    );

    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      cohort: "control",
      keywordId: "11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("GET /counts", () => {
  it("reports records and unique people for every view", async () => {
    // One groupBy per view: rows carry igUserId so people can be counted distinctly.
    groupBy.mockImplementation(async () => [
      { igUserId: "ig-1", _count: { _all: 2 } },
      { igUserId: "ig-2", _count: { _all: 1 } },
    ]);

    const res = await request(makeApp()).get("/api/recovery-reminders/counts");

    expect(res.status).toBe(200);
    for (const view of ["all", "scheduled", "ready", "sent", "suppressed", "control", "attention"]) {
      expect(res.body[view]).toEqual({ records: 3, people: 2 });
    }
  });

  it("is registered before the :id route", async () => {
    await request(makeApp()).get("/api/recovery-reminders/counts");
    expect(findUnique).not.toHaveBeenCalled();
  });
});

// `scheduled` and `ready` are split by an eligibleAt comparison against now, so
// recomputing it per request moved the boundary mid-pagination. A row eligible
// between page 1 and page 2 was `scheduled` on page 1 and `ready` by page 2,
// where it sorted above the cursor — so it appeared on neither page.
describe("GET / boundary stability across pages", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
    getIgUsers.mockResolvedValue({});
  });

  it("returns the boundary it read at", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders?view=scheduled");

    expect(res.status).toBe(200);
    expect(typeof res.body.asOf).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.asOf))).toBe(false);
  });

  it("reuses a supplied boundary instead of advancing it", async () => {
    const asOf = "2026-08-06T12:00:00.000Z";

    const res = await request(makeApp()).get(
      `/api/recovery-reminders?view=scheduled&asOf=${encodeURIComponent(asOf)}`,
    );

    expect(res.body.asOf).toBe(asOf);
    expect(findMany.mock.calls[0]![0].where.eligibleAt).toEqual({ gt: new Date(asOf) });
  });

  it("keeps page two on page one's boundary for the ready view", async () => {
    const first = await request(makeApp()).get("/api/recovery-reminders?view=ready&limit=1");
    const boundary = first.body.asOf;

    await request(makeApp()).get(
      `/api/recovery-reminders?view=ready&limit=1&cursor=11111111-1111-4111-8111-111111111111&asOf=${encodeURIComponent(boundary)}`,
    );

    const pageOne = findMany.mock.calls[0]![0].where.eligibleAt;
    const pageTwo = findMany.mock.calls[1]![0].where.eligibleAt;
    expect(pageTwo).toEqual(pageOne);
  });

  it("rejects an unparseable boundary rather than silently drifting", async () => {
    const res = await request(makeApp()).get(
      "/api/recovery-reminders?view=ready&asOf=not-a-timestamp",
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_query" });
  });
});

describe("GET /metrics", () => {
  // Registered after /:id, Express captures "metrics" as an id and the
  // endpoint 404s.
  it("is not captured by the :id route", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders/metrics");
    expect(res.status).toBe(200);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("excludes settings_blocked rows from the cohort comparison", async () => {
    await request(makeApp()).get("/api/recovery-reminders/metrics");
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      triggerKind: "no_confirmed_read",
    });
  });

  it("returns null rates rather than dividing by zero", async () => {
    const res = await request(makeApp()).get("/api/recovery-reminders/metrics");
    expect(res.body.experiment.treatment.completionRate48h).toBeNull();
    expect(res.body.experiment.absoluteLiftPercentagePoints).toBeNull();
    expect(res.body.experiment.relativeLiftPercent).toBeNull();
    expect(res.body.accuracy.readEventCoverage).toBeNull();
  });

  // With the market filter on, a treatment row for an out-of-market person is
  // suppressed and never sent, but the equivalent control row is terminal at
  // creation and never runs that check. Splitting on cohort alone therefore
  // leaves never-sent people in treatment while control holds every origin, and
  // the lift reads low. Both arms must be filtered on the same snapshot.
  describe("arm comparability", () => {
    // METRICS_SELECT pulls `conversation` and `repliedAt`; the metrics maths
    // dereferences them, so a metrics fixture needs both.
    const metricsRow = (id: string, cohort: string, audienceOrigin: string | null) =>
      row({
        id,
        // eligiblePeople counts DISTINCT people, so each fixture needs its own
        // user or two rows collapse into one and the assertion lies.
        igUserId: `ig-${id}`,
        cohort,
        audienceOrigin,
        triggerKind: "no_confirmed_read",
        acceptedAt: new Date("2026-08-06T00:00:00.000Z"),
        repliedAt: null,
        conversation: { completedAt: null },
      });
    const inMarket = (id: string, cohort: string) => metricsRow(id, cohort, "us_western");
    const outOfMarket = (id: string, cohort: string) => metricsRow(id, cohort, "south_asian");

    it("excludes out-of-market rows from BOTH arms", async () => {
      findMany.mockResolvedValue([
        inMarket("t1", "treatment"),
        outOfMarket("t2", "treatment"),
        inMarket("c1", "control"),
        outOfMarket("c2", "control"),
      ]);

      const res = await request(makeApp()).get("/api/recovery-reminders/metrics");

      // One in-market row per arm survives; the two out-of-market ones do not.
      expect(res.body.experiment.treatment.eligiblePeople).toBe(1);
      expect(res.body.experiment.control.withheld).toBe(1);
      expect(res.body.experiment.withheldOutOfMarket).toBe(2);
    });

    it("keeps every row when the market filter is off", async () => {
      envMock.DM_RECOVERY_WESTERN_ONLY = false;
      findMany.mockResolvedValue([
        inMarket("t1", "treatment"),
        outOfMarket("t2", "treatment"),
      ]);

      const res = await request(makeApp()).get("/api/recovery-reminders/metrics");

      expect(res.body.experiment.treatment.eligiblePeople).toBe(2);
      expect(res.body.experiment.withheldOutOfMarket).toBe(0);
    });

    // Rows created before the snapshot column existed carry a null origin.
    // Dropping them would silently discard the start of the experiment.
    it("keeps rows that predate the snapshot column", async () => {
      findMany.mockResolvedValue([
        metricsRow("old", "treatment", null),
      ]);

      const res = await request(makeApp()).get("/api/recovery-reminders/metrics");

      expect(res.body.experiment.treatment.eligiblePeople).toBe(1);
      expect(res.body.experiment.withheldOutOfMarket).toBe(0);
    });
  });

  it("includes the health snapshot", async () => {
    getRecoveryHealthSnapshot.mockResolvedValue({ circuitOpen: true, reason: "hourly_cap" });
    const res = await request(makeApp()).get("/api/recovery-reminders/metrics");
    expect(res.body.health).toEqual({ circuitOpen: true, reason: "hourly_cap" });
  });

  // `.env.example` ships the window empty until the experiment starts, so this
  // is the default deploy state. It must not query for the cohort at all: `id`
  // is a uuid column, so an `id: ""` sentinel is rejected with P2023 before any
  // SQL is sent, and Express 4 does not catch the async rejection — the request
  // hangs instead of returning.
  it("reports an empty experiment without querying when the window is unset", async () => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({
      env: {
        DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-v1",
        DM_RECOVERY_EXPERIMENT_START_AT: undefined,
        DM_RECOVERY_EXPERIMENT_END_AT: undefined,
      },
    }));
    const isolated = await import("./recoveryReminders.routes.js");
    vi.doUnmock("../config/env.js");

    const app = express();
    app.use(express.json());
    app.use("/api/recovery-reminders", isolated.recoveryRemindersRouter);

    const res = await request(app).get("/api/recovery-reminders/metrics");

    expect(res.status).toBe(200);
    expect(res.body.experiment.treatment.eligiblePeople).toBe(0);
    expect(res.body.experiment.control.withheld).toBe(0);
    // The cohort query is skipped entirely, not issued with a sentinel filter.
    for (const call of findMany.mock.calls) {
      expect(call[0]?.where?.id).toBeUndefined();
    }
  });
});

describe("GET /:id", () => {
  it("returns 404 for a missing record", async () => {
    findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/recovery-reminders/rec-1");
    expect(res.status).toBe(404);
  });

  // The timeline is assembled from stored timestamps, never from a replayed
  // provider response, and is ordered so the owner can read what happened.
  it("builds an ordered timeline from stored timestamps", async () => {
    findUnique.mockResolvedValue(
      row({
        seenAt: new Date("2026-08-06T11:00:00.000Z"),
        sentAt: new Date("2026-08-06T12:30:00.000Z"),
        status: "sent",
      }),
    );

    const res = await request(makeApp()).get("/api/recovery-reminders/rec-1");

    expect(res.status).toBe(200);
    const kinds = res.body.timeline.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toEqual(["created", "accepted", "eligible", "seen", "sent"]);
    const times = res.body.timeline.map((e: { at: string }) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("never returns the public reply text", async () => {
    findUnique.mockResolvedValue(row());
    const res = await request(makeApp()).get("/api/recovery-reminders/rec-1");
    expect(JSON.stringify(res.body)).not.toContain("publicReplyText");
  });
});

describe("POST /:id/cancel", () => {
  it.each(["waiting", "control", "tracking_unavailable", "send_failed"])(
    "cancels an unsent %s item",
    async (status) => {
      findUnique.mockResolvedValue({ id: "rec-1", status });
      updateMany.mockResolvedValue({ count: 1 });

      const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/cancel");

      expect(res.status).toBe(204);
      // Guarded on the exact status observed, not the whole cancellable set:
      // that is what makes the logged transition provable rather than assumed.
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "rec-1",
            status,
            sentAt: null,
            publicReplyId: null,
          }),
        }),
      );
      expect(logEvent).toHaveBeenCalledWith(
        "dm_recovery_cancelled",
        expect.objectContaining({ previousStatus: status, newStatus: "cancelled" }),
      );
    },
  );

  it.each(["sending", "sent", "send_uncertain", "cancelled"])(
    "returns 409 for %s",
    async (status) => {
      updateMany.mockResolvedValue({ count: 0 });
      findUnique.mockResolvedValue({ id: "rec-1", status });

      const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/cancel");

      expect(res.status).toBe(409);
      expect(logEvent).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the record does not exist", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/cancel");
    expect(res.status).toBe(404);
  });
});

describe("POST /:id/mark-reviewed", () => {
  it("stamps reviewedAt without touching send status", async () => {
    findUnique.mockResolvedValue({ id: "rec-1", status: "send_failed", reviewedAt: null });
    updateMany.mockResolvedValue({ count: 1 });

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/mark-reviewed");

    expect(res.status).toBe(204);
    const call = updateMany.mock.calls[0]![0];
    expect(call.where.status).toEqual({
      in: ["send_failed", "send_uncertain", "tracking_unavailable"],
    });
    expect(call.data).toEqual({ reviewedAt: expect.any(Date) });
    expect(call.data).not.toHaveProperty("status");
    // Review is an acknowledgement, so the status it reports is the one it left
    // in place — stated on both sides rather than left to be inferred.
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_reviewed",
      expect.objectContaining({ previousStatus: "send_failed", newStatus: "send_failed" }),
    );
  });

  // A second click, or a retried request, must not move the timestamp off the
  // moment a person actually looked, and must not add a second audit entry.
  it("is idempotent: a repeat review neither rewrites the time nor re-logs", async () => {
    findUnique.mockResolvedValue({
      id: "rec-1",
      status: "send_failed",
      reviewedAt: new Date("2026-08-06T09:00:00.000Z"),
    });

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/mark-reviewed");

    expect(res.status).toBe(204);
    expect(updateMany).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  // Two owners clicking at once is not a conflict — both wanted it reviewed, and
  // it is. Only the loser's write is dropped, not their intent.
  it("succeeds for the loser of a concurrent review", async () => {
    findUnique
      .mockResolvedValueOnce({ id: "rec-1", status: "send_failed", reviewedAt: null })
      .mockResolvedValueOnce({ reviewedAt: new Date() });
    updateMany.mockResolvedValue({ count: 0 });

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/mark-reviewed");

    expect(res.status).toBe(204);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("returns 409 for a record that is not awaiting review", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: "rec-1", status: "sent", reviewedAt: null });

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/mark-reviewed");
    expect(res.status).toBe(409);
  });

  it("returns 404 when the record does not exist", async () => {
    findUnique.mockResolvedValue(null);

    const res = await request(makeApp()).post("/api/recovery-reminders/rec-1/mark-reviewed");
    expect(res.status).toBe(404);
  });
});
