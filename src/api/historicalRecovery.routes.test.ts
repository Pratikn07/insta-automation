import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";

const {
  candidateCount,
  candidateFindMany,
  candidateQueryRaw,
  getIgUsers,
  recordCampaignHealthObservation,
  logEvent,
  approveCampaign,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  cancelCampaign,
  advanceCampaignStage,
} = vi.hoisted(() => ({
  candidateCount: vi.fn(),
  candidateFindMany: vi.fn(),
  candidateQueryRaw: vi.fn(),
  getIgUsers: vi.fn(),
  recordCampaignHealthObservation: vi.fn(),
  logEvent: vi.fn(),
  approveCampaign: vi.fn(),
  pauseCampaign: vi.fn(),
  pauseCampaignGroup: vi.fn(),
  resumeCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  advanceCampaignStage: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $queryRaw: candidateQueryRaw,
    recoveryCandidate: { count: candidateCount, findMany: candidateFindMany },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../services/campaignHealthObservation.js", () => ({
  recordCampaignHealthObservation,
}));
vi.mock("../services/eventLogger.js", () => ({ logEvent }));
vi.mock("../services/recoveryCampaignControl.js", () => ({
  approveCampaign,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  cancelCampaign,
  advanceCampaignStage,
}));

import {
  buildHistoricalAttributionObservation,
  candidateViewWhere,
  CANDIDATE_VIEWS,
} from "./historicalRecovery.routes.js";
import { historicalRecoveryRouter } from "./historicalRecovery.routes.js";
import { apiRouter } from "./router.js";
import { CURRENT_ORIGIN_METHOD } from "../services/historicalRecoveryOriginPolicy.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function app(authenticated: boolean) {
  const server = express();
  server.use(express.json());
  if (authenticated) {
    server.use((req, _res, next) => {
      req.adminEmail = "owner@example.com";
      next();
    });
  }
  server.use(historicalRecoveryRouter);
  server.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal_error" });
  });
  return server;
}

function ownerApiApp() {
  const server = express();
  server.use(express.json());
  server.use("/api", apiRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  candidateQueryRaw.mockResolvedValue([]);
  candidateCount.mockResolvedValue(1);
  getIgUsers.mockResolvedValue({ "ig-1": { username: "frozen-owner" } });
  recordCampaignHealthObservation.mockResolvedValue({ created: true });
  logEvent.mockResolvedValue(undefined);
  approveCampaign.mockResolvedValue({ ok: true, state: "paused" });
  pauseCampaignGroup.mockResolvedValue({
    rolloutGroupId: CAMPAIGN_ID,
    pausedCampaignIds: ["22222222-2222-4222-8222-222222222222"],
    skipped: [{ campaignId: "33333333-3333-4333-8333-333333333333", state: "completed" }],
  });
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

describe("buildHistoricalAttributionObservation", () => {
  const anchor = new Date("2026-08-08T12:00:00.000Z");

  it("uses dispatch start for treatment and includes the fixed 24/48h edges", () => {
    expect(buildHistoricalAttributionObservation({
      arm: "treatment",
      dispatchStartedAt: anchor,
      sentAt: new Date(anchor.getTime() + 10_000),
      lastAttemptAt: null,
      campaignStartedAt: new Date(anchor.getTime() - 3600_000),
      laterInboundAt: new Date(anchor.getTime() + 24 * 3600_000),
      laterCompletedAt: new Date(anchor.getTime() + 48 * 3600_000),
    })).toEqual({
      anchorAt: anchor,
      inboundWithin24Hours: true,
      completedWithin48Hours: true,
    });
  });

  it("uses campaign start for holdout and excludes one millisecond beyond an edge", () => {
    expect(buildHistoricalAttributionObservation({
      arm: "holdout",
      dispatchStartedAt: null,
      sentAt: null,
      lastAttemptAt: null,
      campaignStartedAt: anchor,
      laterInboundAt: new Date(anchor.getTime() + 24 * 3600_000 + 1),
      laterCompletedAt: new Date(anchor.getTime() + 48 * 3600_000 + 1),
    })).toEqual({
      anchorAt: anchor,
      inboundWithin24Hours: false,
      completedWithin48Hours: false,
    });
  });

  it("never reports an observation before its anchor", () => {
    expect(buildHistoricalAttributionObservation({
      arm: "treatment",
      dispatchStartedAt: anchor,
      sentAt: anchor,
      lastAttemptAt: anchor,
      campaignStartedAt: anchor,
      laterInboundAt: new Date(anchor.getTime() - 1),
      laterCompletedAt: new Date(anchor.getTime() - 1),
    })).toMatchObject({
      inboundWithin24Hours: false,
      completedWithin48Hours: false,
    });
  });
});

describe("GET /candidates", () => {
  it("returns the frozen origin provenance from the candidate", async () => {
    candidateFindMany.mockResolvedValue([{
      id: "22222222-2222-4222-8222-222222222222",
      campaignId: CAMPAIGN_ID,
      igUserId: "ig-1",
      keywordSnapshot: "SLEEP",
      commentId: "comment-1",
      mediaId: "media-1",
      commentAt: new Date("2026-06-25T10:00:00.000Z"),
      publicReplyText: "Recovery copy",
      evidence: "gate_sent_no_read",
      selectionPosition: 0,
      sourceChoiceReason: "newest_eligible_comment",
      dispatchCommentId: null,
      arm: "treatment",
      outcome: "pending",
      audienceOrigin: "us_western",
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
      audienceOriginConfidence: "low",
      sentAt: null,
      publicReplyId: null,
      suppressionReason: null,
      laterInboundAt: null,
      laterCompletedAt: null,
      dispatchStartedAt: null,
      lastAttemptAt: null,
      campaign: { startedAt: new Date("2026-08-01T00:00:00.000Z") },
      sources: [],
    }]);

    const response = await request(app(true)).get(`/candidates?campaignId=${CAMPAIGN_ID}&view=all`);

    expect(response.status).toBe(200);
    expect(response.body.candidates[0]).toMatchObject({
      audienceOrigin: "us_western",
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
      audienceOriginConfidence: "low",
    });
  });
});

describe("POST /campaigns/:id/approve", () => {
  it("forwards the safe pending-launch option to campaign approval", async () => {
    const response = await request(app(true))
      .post(`/campaigns/${CAMPAIGN_ID}/approve`)
      .send({ approvedBy: "owner@example.com", startPaused: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, state: "paused" });
    expect(approveCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      "owner@example.com",
      expect.any(Date),
      { startPaused: true },
    );
  });

  it("rejects a non-boolean pending-launch option", async () => {
    await request(app(true))
      .post(`/campaigns/${CAMPAIGN_ID}/approve`)
      .send({ approvedBy: "owner@example.com", startPaused: "yes" })
      .expect(400);

    expect(approveCampaign).not.toHaveBeenCalled();
  });
});

describe("POST /campaigns/:id/health-observations", () => {
  const body = {
    kind: "complaint",
    sourceKey: "moderation:case-123",
    observedAt: "2026-08-08T20:00:00.000Z",
    safeDetail: "verified_report",
  };

  it("requires an authenticated admin identity", async () => {
    await request(app(false))
      .post(`/campaigns/${CAMPAIGN_ID}/health-observations`)
      .send(body)
      .expect(401);

    expect(recordCampaignHealthObservation).not.toHaveBeenCalled();
  });

  it.each(["opt_out", "negative_reply", "made_up"])(
    "rejects manual ingestion of %s",
    async (kind) => {
      await request(app(true))
        .post(`/campaigns/${CAMPAIGN_ID}/health-observations`)
        .send({ ...body, kind })
        .expect(400);
    },
  );

  it("bounds source keys and safe detail", async () => {
    await request(app(true))
      .post(`/campaigns/${CAMPAIGN_ID}/health-observations`)
      .send({ ...body, sourceKey: "x".repeat(201), safeDetail: "y".repeat(201) })
      .expect(400);
  });

  it("records trusted evidence and audits only bounded safe fields", async () => {
    await request(app(true))
      .post(`/campaigns/${CAMPAIGN_ID}/health-observations`)
      .send(body)
      .expect(200, { created: true });

    expect(recordCampaignHealthObservation).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      kind: "complaint",
      sourceKey: "moderation:case-123",
      observedAt: new Date("2026-08-08T20:00:00.000Z"),
      safeDetail: "verified_report",
    });
    expect(logEvent).toHaveBeenCalledWith("historical_campaign_health_observation_ingested", {
      campaignId: CAMPAIGN_ID,
      kind: "complaint",
      sourceKey: "moderation:case-123",
      safeDetail: "verified_report",
      actor: "owner@example.com",
      created: true,
    });
  });

  it("returns an idempotent replay as not created", async () => {
    recordCampaignHealthObservation.mockResolvedValue({ created: false });

    await request(app(true))
      .post(`/campaigns/${CAMPAIGN_ID}/health-observations`)
      .send(body)
      .expect(200, { created: false });
  });
});

describe("POST /rollout-groups/:id/pause", () => {
  it("returns the exact group result and forwards the bounded trimmed reason", async () => {
    const response = await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/pause`)
      .send({ reason: "  owner emergency stop  " });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      rolloutGroupId: CAMPAIGN_ID,
      pausedCampaignIds: ["22222222-2222-4222-8222-222222222222"],
      skipped: [{ campaignId: "33333333-3333-4333-8333-333333333333", state: "completed" }],
    });
    expect(pauseCampaignGroup).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      "owner emergency stop",
      expect.any(Date),
    );
  });

  it("rejects a malformed rollout-group UUID", async () => {
    await request(app(true))
      .post("/rollout-groups/not-a-uuid/pause")
      .send({ reason: "stop" })
      .expect(400, { error: "invalid_group_pause" });

    expect(pauseCampaignGroup).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "x".repeat(201)])("rejects the invalid reason %p", async (reason) => {
    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/pause`)
      .send({ reason })
      .expect(400, { error: "invalid_group_pause" });

    expect(pauseCampaignGroup).not.toHaveBeenCalled();
  });

  it("inherits owner authentication from the parent API router", async () => {
    await request(ownerApiApp())
      .post(`/api/historical-recovery/rollout-groups/${CAMPAIGN_ID}/pause`)
      .send({ reason: "stop" })
      .expect(401, { error: "missing_bearer_token" });

    expect(pauseCampaignGroup).not.toHaveBeenCalled();
  });

  it("returns not_found when a valid rollout group has no campaigns", async () => {
    pauseCampaignGroup.mockRejectedValueOnce(Object.assign(
      new Error("campaign_group_not_found"),
      { code: "campaign_group_not_found" },
    ));

    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/pause`)
      .send({ reason: "stop" })
      .expect(404, { error: "not_found" });
  });

  it("forwards an unexpected service rejection to the error middleware", async () => {
    pauseCampaignGroup.mockRejectedValueOnce(new Error("database unavailable"));

    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/pause`)
      .send({ reason: "stop" })
      .expect(500, { error: "internal_error" });
  });
});
