import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";

const {
  candidateCount,
  candidateFindMany,
  candidateFindUnique,
  candidateUpdateMany,
  candidateQueryRaw,
  campaignFindMany,
  candidateGroupBy,
  historicalCandidateDetail,
  markHistoricalCandidateReviewed,
  getIgUsers,
  recordCampaignHealthObservation,
  logEvent,
  approveCampaign,
  approveCampaignGroup,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  resumeCampaignGroup,
  cancelCampaign,
  advanceCampaignStage,
} = vi.hoisted(() => ({
  candidateCount: vi.fn(),
  candidateFindMany: vi.fn(),
  candidateFindUnique: vi.fn(),
  candidateUpdateMany: vi.fn(),
  candidateQueryRaw: vi.fn(),
  campaignFindMany: vi.fn(),
  candidateGroupBy: vi.fn(),
  historicalCandidateDetail: vi.fn(),
  markHistoricalCandidateReviewed: vi.fn(),
  getIgUsers: vi.fn(),
  recordCampaignHealthObservation: vi.fn(),
  logEvent: vi.fn(),
  approveCampaign: vi.fn(),
  approveCampaignGroup: vi.fn(),
  pauseCampaign: vi.fn(),
  pauseCampaignGroup: vi.fn(),
  resumeCampaign: vi.fn(),
  resumeCampaignGroup: vi.fn(),
  cancelCampaign: vi.fn(),
  advanceCampaignStage: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $queryRaw: candidateQueryRaw,
    recoveryCampaign: { findMany: campaignFindMany },
    recoveryCandidate: {
      count: candidateCount,
      findMany: candidateFindMany,
      findUnique: candidateFindUnique,
      updateMany: candidateUpdateMany,
      groupBy: candidateGroupBy,
    },
  },
}));
vi.mock("../services/igUserService.js", () => ({ getIgUsers }));
vi.mock("../services/historicalRecoveryCandidateDetail.js", () => ({ historicalCandidateDetail }));
vi.mock("../services/historicalRecoveryReview.js", () => ({
  HISTORICAL_REVIEWABLE_OUTCOMES: ["send_failed", "send_uncertain"],
  markHistoricalCandidateReviewed,
}));
vi.mock("../services/campaignHealthObservation.js", () => ({
  recordCampaignHealthObservation,
}));
vi.mock("../services/eventLogger.js", () => ({ logEvent }));
vi.mock("../services/recoveryCampaignControl.js", () => ({
  approveCampaign,
  approveCampaignGroup,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  resumeCampaignGroup,
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
  candidateFindMany.mockResolvedValue([]);
  candidateFindUnique.mockResolvedValue(null);
  candidateUpdateMany.mockResolvedValue({ count: 0 });
  candidateGroupBy.mockResolvedValue([]);
  campaignFindMany.mockResolvedValue([]);
  getIgUsers.mockResolvedValue({
    "ig-1": { username: "frozen-owner", audienceSegment: "other" },
  });
  historicalCandidateDetail.mockResolvedValue(null);
  markHistoricalCandidateReviewed.mockResolvedValue({ kind: "not_found" });
  recordCampaignHealthObservation.mockResolvedValue({ created: true });
  logEvent.mockResolvedValue(undefined);
  approveCampaign.mockResolvedValue({ ok: true, state: "paused" });
  approveCampaignGroup.mockResolvedValue({
    ok: true,
    state: "paused",
    campaignIds: ["22222222-2222-4222-8222-222222222222"],
  });
  resumeCampaignGroup.mockResolvedValue({
    ok: true,
    state: "running",
    campaignIds: ["22222222-2222-4222-8222-222222222222"],
  });
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
  it("returns frozen and current audience segments independently", async () => {
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
      audienceSegment: "unknown_no_name",
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
      audienceSegment: "unknown_no_name",
      currentAudienceSegment: "other",
    });
  });

  it("returns and preserves the validated asOf pagination boundary", async () => {
    const asOf = "2026-08-12T10:00:00.000Z";

    const first = await request(app(true)).get(`/candidates?campaignId=${CAMPAIGN_ID}&view=all`);

    expect(first.status).toBe(200);
    expect(first.body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const next = await request(app(true)).get(
      `/candidates?campaignId=${CAMPAIGN_ID}&view=all&cursor=22222222-2222-4222-8222-222222222222&asOf=${encodeURIComponent(asOf)}`,
    );

    expect(next.status).toBe(200);
    expect(next.body.asOf).toBe(asOf);
    expect(candidateFindMany.mock.calls.at(-1)?.[0]?.where).toMatchObject({
      campaignId: CAMPAIGN_ID,
      createdAt: { lte: new Date(asOf) },
    });
  });

  it.each([
    "?campaignId=11111111-1111-4111-8111-111111111111&view=all&cursor=22222222-2222-4222-8222-222222222222",
    "?campaignId=11111111-1111-4111-8111-111111111111&view=all&asOf=2026-08-12T10%3A00%3A00.000Z",
  ])("rejects an incomplete pagination boundary: %s", async (query) => {
    const response = await request(app(true)).get(`/candidates${query}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_query");
  });

  it("rejects a future pagination boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
    try {
      await request(app(true)).get(
        "/candidates?campaignId=11111111-1111-4111-8111-111111111111&view=all&cursor=22222222-2222-4222-8222-222222222222&asOf=2026-08-12T10%3A00%3A00.001Z",
      ).expect(400, { error: "invalid_query" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /campaigns", () => {
  it("reports each campaign's cap separately from its shared recent group capacity", async () => {
    const rolloutGroupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    campaignFindMany.mockResolvedValue([{
      id: CAMPAIGN_ID,
      phase: "unknown_read_pilot",
      state: "running",
      selectionVersion: "selection-v2",
      selectionFingerprint: null,
      decisionHash: null,
      copyVersion: "recovery-v2",
      eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
      sourceDataCutoff: new Date("2026-08-01T00:00:00.000Z"),
      selectionLimit: 1000,
      westernOnly: null,
      holdoutPercent: 0,
      inboundWindowHours: 24,
      completionWindowHours: 48,
      batchSize: 1,
      hourlyCap: 3,
      dailyCap: 1000,
      candidateCount: 4,
      excludedCount: 0,
      audienceSegment: "other",
      rolloutGroupId,
      rolloutGroupHourlyCap: 10,
      approvedBy: "owner@example.com",
      approvedAt: new Date("2026-08-01T00:00:00.000Z"),
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      pausedAt: null,
      pauseReason: null,
      endedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }]);
    candidateQueryRaw.mockResolvedValueOnce([{ rolloutGroupId, sentLastHour: 7 }]);

    const response = await request(app(true)).get("/campaigns");

    expect(response.status).toBe(200);
    expect(response.body.campaigns[0]).toMatchObject({
      audienceSegment: "other",
      rolloutGroupId,
      rolloutGroupHourlyCap: 10,
      rolloutGroupSentLastHour: 7,
      hourlyCap: 3,
    });
    const capacityQuery = candidateQueryRaw.mock.calls[0]?.[0].join("?");
    expect(capacityQuery).toContain('"reserved_at" >');
    expect(capacityQuery).toContain("'reserved', 'dispatch_started', 'sent', 'uncertain'");
    expect(capacityQuery).toContain('"rollout_group_id" IS NOT NULL');
  });

  it("reports zero shared capacity for an ungrouped campaign", async () => {
    campaignFindMany.mockResolvedValue([{
      id: CAMPAIGN_ID,
      phase: "unknown_read_pilot",
      state: "running",
      selectionVersion: "selection-v2",
      selectionFingerprint: null,
      decisionHash: null,
      copyVersion: "recovery-v2",
      eligibilityPolicyVersion: null,
      sourceDataCutoff: new Date("2026-08-01T00:00:00.000Z"),
      selectionLimit: 1000,
      westernOnly: null,
      holdoutPercent: 0,
      inboundWindowHours: 24,
      completionWindowHours: 48,
      batchSize: 1,
      hourlyCap: 3,
      dailyCap: 1000,
      candidateCount: 4,
      excludedCount: 0,
      audienceSegment: null,
      rolloutGroupId: null,
      rolloutGroupHourlyCap: null,
      approvedBy: null,
      approvedAt: null,
      startedAt: null,
      pausedAt: null,
      pauseReason: null,
      endedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }]);
    candidateQueryRaw.mockResolvedValueOnce([]);

    const response = await request(app(true)).get("/campaigns");

    expect(response.status).toBe(200);
    expect(response.body.campaigns[0]).toMatchObject({
      rolloutGroupId: null,
      rolloutGroupHourlyCap: null,
      rolloutGroupSentLastHour: 0,
    });
  });
});

describe("GET /candidates/:id", () => {
  it("exposes frozen and current audience segments from the detailed read model", async () => {
    const candidateId = "22222222-2222-4222-8222-222222222222";
    historicalCandidateDetail.mockResolvedValue({
      candidate: {
        id: candidateId,
        audienceSegment: "unknown_no_name",
        currentAudienceSegment: "other",
      },
    });

    const response = await request(app(true)).get(`/candidates/${candidateId}`);

    expect(response.status).toBe(200);
    expect(response.body.candidate).toMatchObject({
      audienceSegment: "unknown_no_name",
      currentAudienceSegment: "other",
    });
    expect(historicalCandidateDetail).toHaveBeenCalledWith(candidateId);
  });

  it("forwards an unexpected detail service failure to Express error handling", async () => {
    historicalCandidateDetail.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(app(true)).get("/candidates/22222222-2222-4222-8222-222222222222");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });
});

describe("POST /candidates/:id/mark-reviewed", () => {
  const candidateId = "22222222-2222-4222-8222-222222222222";

  it("acknowledges a reviewable historical failure without changing its outcome", async () => {
    markHistoricalCandidateReviewed.mockResolvedValueOnce({ kind: "reviewed" });

    const response = await request(app(true)).post(`/candidates/${candidateId}/mark-reviewed`);

    expect(response.status).toBe(204);
    expect(markHistoricalCandidateReviewed).toHaveBeenCalledWith(expect.objectContaining({
      candidateId,
      actor: "owner@example.com",
    }));
  });

  it("is idempotent for a previously reviewed candidate", async () => {
    markHistoricalCandidateReviewed.mockResolvedValueOnce({ kind: "already_reviewed" });

    await request(app(true)).post(`/candidates/${candidateId}/mark-reviewed`).expect(204);
  });

  it("does not acknowledge an outcome that does not require review", async () => {
    markHistoricalCandidateReviewed.mockResolvedValueOnce({ kind: "conflict", outcome: "sent" });

    await request(app(true)).post(`/candidates/${candidateId}/mark-reviewed`).expect(409);
  });

  it("returns 404 for an unknown candidate and 400 for a malformed id", async () => {
    await request(app(true)).post(`/candidates/${candidateId}/mark-reviewed`).expect(404);
    await request(app(true)).post("/candidates/not-a-uuid/mark-reviewed").expect(400);
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

describe("atomic rollout-group approve and resume", () => {
  const campaigns = [{
    id: "22222222-2222-4222-8222-222222222222",
    segment: "other",
    decisionHash: "d".repeat(64),
  }];
  const body = { campaigns, selectorPhase: "unknown_read_pilot" };

  it("uses the authenticated owner and one group approval service call", async () => {
    const response = await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/approve`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      state: "paused",
      campaignIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(approveCampaignGroup).toHaveBeenCalledWith({
      rolloutGroupId: CAMPAIGN_ID,
      campaigns,
      selectorPhase: "unknown_read_pilot",
      approvedBy: "owner@example.com",
    });
    expect(approveCampaign).not.toHaveBeenCalled();
  });

  it("resumes the exact group with one atomic service call", async () => {
    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/resume`)
      .send(body)
      .expect(200, {
        ok: true,
        state: "running",
        campaignIds: ["22222222-2222-4222-8222-222222222222"],
      });
    expect(resumeCampaignGroup).toHaveBeenCalledWith({
      rolloutGroupId: CAMPAIGN_ID,
      campaigns,
      selectorPhase: "unknown_read_pilot",
    });
    expect(resumeCampaign).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, or non-canonical campaign topology", async () => {
    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/approve`)
      .send({
        selectorPhase: "unknown_read_pilot",
        campaigns: [
          { id: campaigns[0]!.id, segment: "unknown_cue" },
          { id: campaigns[0]!.id, segment: "other" },
        ],
      })
      .expect(400, { error: "invalid_group_transition" });
    expect(approveCampaignGroup).not.toHaveBeenCalled();
  });

  it("rejects a transition that is not bound to an exact selector decision hash", async () => {
    await request(app(true))
      .post(`/rollout-groups/${CAMPAIGN_ID}/approve`)
      .send({ ...body, campaigns: [{ ...campaigns[0], decisionHash: "not-a-hash" }] })
      .expect(400, { error: "invalid_group_transition" });
    expect(approveCampaignGroup).not.toHaveBeenCalled();
  });

  it("inherits owner authentication from the API router", async () => {
    await request(ownerApiApp())
      .post(`/api/historical-recovery/rollout-groups/${CAMPAIGN_ID}/approve`)
      .send(body)
      .expect(401, { error: "missing_bearer_token" });
    expect(approveCampaignGroup).not.toHaveBeenCalled();
  });
});
