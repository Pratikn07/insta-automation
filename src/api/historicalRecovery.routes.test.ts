import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const campaignFindMany = vi.fn();
const candidateFindMany = vi.fn();
const candidateCount = vi.fn();
const candidateGroupBy = vi.fn();
const getIgUsers = vi.fn();
const approveCampaign = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    recoveryCampaign: { findMany: campaignFindMany },
    recoveryCandidate: {
      findMany: candidateFindMany,
      count: candidateCount,
      groupBy: candidateGroupBy,
    },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../config/env.js", () => ({
  env: { DM_RECOVERY_ENABLED: true, DM_RECOVERY_HISTORICAL_ENABLED: true },
}));
vi.mock("../services/recoveryCampaignControl.js", () => ({
  approveCampaign,
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  advanceCampaignStage: vi.fn(),
}));

const { candidateViewWhere, CANDIDATE_VIEWS, historicalRecoveryRouter } = await import(
  "./historicalRecovery.routes.js"
);

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(adminEmail = "owner@example.com") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminEmail = adminEmail;
    next();
  });
  app.use("/api/historical-recovery", historicalRecoveryRouter);
  return app;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
    campaignId: CAMPAIGN_ID,
    campaignPhase: "unknown_read_pilot",
    igUserId: "ig-1",
    keywordSnapshot: "SLEEP",
    commentId: "comment-1",
    mediaId: "media-1",
    commentAt: new Date("2026-06-25T10:00:00.000Z"),
    publicReplyText: "Recovery copy",
    evidence: "gate_sent_no_read",
    arm: "treatment",
    outcome: "send_uncertain",
    audienceOrigin: "us_western",
    audienceOriginConfidence: "high",
    sentAt: null,
    publicReplyId: null,
    suppressionReason: "missing_reply_id",
    reviewedAt: null,
    laterInboundAt: null,
    laterCompletedAt: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    campaignFindMany,
    candidateFindMany,
    candidateCount,
    candidateGroupBy,
    getIgUsers,
    approveCampaign,
  ]) {
    fn.mockReset();
  }
  campaignFindMany.mockResolvedValue([]);
  candidateFindMany.mockResolvedValue([]);
  candidateCount.mockResolvedValue(0);
  candidateGroupBy.mockResolvedValue([]);
  getIgUsers.mockResolvedValue({});
});

// The list and the tab badges both read from candidateViewWhere. If they could
// disagree, a badge would promise rows the list does not show — the class of bug
// that makes an operator distrust the whole surface.

describe("candidateViewWhere", () => {
  // A holdout row is the control arm, not something waiting to send. Including it in
  // `pending` would overstate the work remaining and imply it will eventually go out.
  it("excludes holdout rows from pending", () => {
    expect(candidateViewWhere("pending")).toEqual({ outcome: "pending", arm: "treatment" });
  });

  it("keeps holdout as its own view", () => {
    expect(candidateViewWhere("holdout")).toEqual({ arm: "holdout" });
  });

  // Both mean "will not be sent, and not because of a failure", so they read as one
  // group to the operator.
  it("groups suppressed and cancelled together", () => {
    expect(candidateViewWhere("suppressed")).toEqual({
      outcome: { in: ["suppressed", "cancelled"] },
    });
  });

  // send_uncertain may already have posted and is never retried automatically, so it
  // must surface in a view a human actually opens.
  it("puts uncertain and failed sends in attention", () => {
    expect(candidateViewWhere("attention")).toEqual({
      outcome: { in: ["send_uncertain", "send_failed"] },
    });
  });

  // The outcome the campaign exists to measure, across BOTH arms (QA-12).
  //
  // This previously required `outcome: "sent"`, which hid the control arm entirely: a
  // holdout who completed on their own never appeared, so any treatment figure read as
  // pure lift with no baseline to compare against. A settled candidate plus a later
  // completion is the definition; which arm it was in is what makes the number mean
  // something.
  it("counts a later completion in either arm as recovered", () => {
    expect(candidateViewWhere("recovered")).toEqual({
      laterCompletedAt: { not: null },
      outcome: { in: ["sent", "send_uncertain", "holdout_withheld"] },
    });
  });

  // A completion always requires the candidate to have been settled first. A pending row
  // was never acted on, so a completion against it is coincidence, not recovery.
  it("never counts a pending candidate as recovered", () => {
    const where = candidateViewWhere("recovered") as { outcome: { in: string[] } };
    expect(where.outcome.in).not.toContain("pending");
  });

  it("filters nothing for all", () => {
    expect(candidateViewWhere("all")).toEqual({});
  });

  it("defines a filter for every advertised view", () => {
    for (const view of CANDIDATE_VIEWS) {
      expect(candidateViewWhere(view)).toBeDefined();
    }
  });

  // A pending row must never appear in a terminal view, or the operator sees the
  // same person in two places with contradictory status.
  it("keeps pending disjoint from the terminal views", () => {
    const pending = candidateViewWhere("pending") as { outcome?: unknown };
    for (const view of ["sent", "suppressed", "attention", "recovered"] as const) {
      expect(candidateViewWhere(view)).not.toEqual(pending);
    }
  });
});

describe("GET /candidates", () => {
  it("returns and applies one fixed asOf boundary to rows and counts", async () => {
    const asOf = "2026-08-08T20:00:00.000Z";

    const res = await request(makeApp()).get(
      `/api/historical-recovery/candidates?asOf=${encodeURIComponent(asOf)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(asOf);
    expect(candidateFindMany.mock.calls[0]![0].where.createdAt).toEqual({
      lte: new Date(asOf),
    });
    expect(
      candidateCount.mock.calls.every(
        ([args]) => args.where.createdAt.lte.getTime() === Date.parse(asOf),
      ),
    ).toBe(true);
  });

  it("returns a parseable server boundary on the first page", async () => {
    const res = await request(makeApp()).get("/api/historical-recovery/candidates");

    expect(res.status).toBe(200);
    expect(typeof res.body.asOf).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.asOf))).toBe(false);
  });

  it("rejects an invalid boundary", async () => {
    const res = await request(makeApp()).get(
      "/api/historical-recovery/candidates?asOf=not-a-date",
    );
    expect(res.status).toBe(400);
  });

  it("returns the last included row as cursor and skips it on continuation", async () => {
    candidateFindMany.mockResolvedValue([
      candidate({ id: "33333333-3333-4333-8333-333333333333" }),
      candidate({ id: "44444444-4444-4444-8444-444444444444" }),
      candidate({ id: "55555555-5555-4555-8555-555555555555" }),
    ]);

    const first = await request(makeApp()).get("/api/historical-recovery/candidates?limit=2");
    expect(first.body.candidates.map((row: { id: string }) => row.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(first.body.nextCursor).toBe("44444444-4444-4444-8444-444444444444");

    candidateFindMany.mockResolvedValue([]);
    await request(makeApp()).get(
      "/api/historical-recovery/candidates?cursor=44444444-4444-4444-8444-444444444444",
    );
    expect(candidateFindMany.mock.calls.at(-1)![0]).toMatchObject({
      cursor: { id: "44444444-4444-4444-8444-444444444444" },
      skip: 1,
    });
  });

  it("serializes phase and review state needed by the operator", async () => {
    candidateFindMany.mockResolvedValue([candidate()]);

    const res = await request(makeApp()).get("/api/historical-recovery/candidates");

    expect(res.body.candidates[0]).toMatchObject({
      campaignPhase: "unknown_read_pilot",
      reviewedAt: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    });
  });
});

describe("POST /campaigns/:id/approve", () => {
  it("attributes approval to the authenticated administrator", async () => {
    approveCampaign.mockResolvedValue({ ok: true, state: "running" });

    const res = await request(makeApp("admin@example.com"))
      .post(`/api/historical-recovery/campaigns/${CAMPAIGN_ID}/approve`)
      .send({ approvedBy: "forged@example.com" });

    expect(res.status).toBe(200);
    expect(approveCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, "admin@example.com");
  });

  it("rejects approval without an authenticated identity", async () => {
    approveCampaign.mockResolvedValue({ ok: true, state: "running" });

    const res = await request(makeApp(""))
      .post(`/api/historical-recovery/campaigns/${CAMPAIGN_ID}/approve`)
      .send({});

    expect(res.status).toBe(401);
    expect(approveCampaign).not.toHaveBeenCalled();
  });
});
