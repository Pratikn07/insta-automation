import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";

const { recordCampaignHealthObservation, logEvent } = vi.hoisted(() => ({
  recordCampaignHealthObservation: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../services/campaignHealthObservation.js", () => ({
  recordCampaignHealthObservation,
}));
vi.mock("../services/eventLogger.js", () => ({ logEvent }));

import {
  buildHistoricalAttributionObservation,
  candidateViewWhere,
  CANDIDATE_VIEWS,
} from "./historicalRecovery.routes.js";
import { historicalRecoveryRouter } from "./historicalRecovery.routes.js";

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
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordCampaignHealthObservation.mockResolvedValue({ created: true });
  logEvent.mockResolvedValue(undefined);
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
