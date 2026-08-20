import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewMocks = vi.hoisted(() => ({
  confirmUnitDelivered: vi.fn(),
  retryUncertainUnit: vi.fn(),
  cancelGuideDelivery: vi.fn(),
}));

vi.mock("../services/guideDeliveryReviewService.js", () => reviewMocks);

const { guideDeliveriesRouter } = await import("./guideDeliveries.routes.js");

const deliveryId = randomUUID();
const unitId = randomUUID();
const OWNER = "owner@example.com";

function makeApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      req.adminEmail = OWNER;
      next();
    });
  }
  app.use("/api/guide-deliveries", guideDeliveriesRouter);
  return app;
}

function reviewError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { name: "GuideDeliveryReviewError", code });
}

beforeEach(() => {
  vi.clearAllMocks();
  reviewMocks.confirmUnitDelivered.mockResolvedValue({ status: "accepted" });
  reviewMocks.retryUncertainUnit.mockResolvedValue({ status: "processing_started" });
  reviewMocks.cancelGuideDelivery.mockResolvedValue({ status: "accepted" });
});

describe("guide delivery owner routes", () => {
  it("uses the authenticated owner as confirm audit actor and never accepts actor/action from the body", async () => {
    reviewMocks.confirmUnitDelivered.mockResolvedValueOnce({ status: "processing_started" });

    const response = await request(makeApp())
      .post(`/api/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .send({ actor: "attacker@example.com", action: "retry_uncertain" })
      .expect(202);

    expect(response.body).toEqual({});
    expect(reviewMocks.confirmUnitDelivered).toHaveBeenCalledWith({
      deliveryId,
      unitId,
      actor: OWNER,
      now: expect.any(Date),
    });
  });

  it("returns 204 when confirm is accepted without further processing", async () => {
    const response = await request(makeApp())
      .post(`/api/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .expect(204);

    expect(response.text).toBe("");
  });

  it("requires the exact literal duplicate-risk acknowledgement", async () => {
    for (const body of [{}, { acknowledgeDuplicateRisk: false }, { acknowledgeDuplicateRisk: "true" }]) {
      const response = await request(makeApp())
        .post(`/api/guide-deliveries/${deliveryId}/units/${unitId}/retry`)
        .send(body)
        .expect(400);
      expect(response.body).toEqual({ error: "duplicate_risk_acknowledgement_required" });
    }
    expect(reviewMocks.retryUncertainUnit).not.toHaveBeenCalled();
  });

  it("starts one acknowledged retry with the authenticated actor", async () => {
    const response = await request(makeApp())
      .post(`/api/guide-deliveries/${deliveryId}/units/${unitId}/retry`)
      .send({ acknowledgeDuplicateRisk: true, actor: "attacker@example.com" })
      .expect(202);

    expect(response.body).toEqual({});
    expect(reviewMocks.retryUncertainUnit).toHaveBeenCalledWith({
      deliveryId,
      unitId,
      actor: OWNER,
      acknowledgeDuplicateRisk: true,
      now: expect.any(Date),
    });
  });

  it("cancels idempotently without exposing private rows", async () => {
    const response = await request(makeApp())
      .post(`/api/guide-deliveries/${deliveryId}/cancel`)
      .send({ action: "confirm_delivered" })
      .expect(204);

    expect(response.text).toBe("");
    expect(reviewMocks.cancelGuideDelivery).toHaveBeenCalledWith({
      deliveryId,
      actor: OWNER,
      now: expect.any(Date),
    });
  });

  it.each([
    ["delivery_not_found", 404],
    ["unit_not_found", 404],
    ["delivery_state_changed", 409],
    ["messaging_window_closed", 409],
    ["duplicate_risk_acknowledgement_required", 400],
  ] as const)("maps %s to its stable response", async (code, status) => {
    reviewMocks.confirmUnitDelivered.mockRejectedValueOnce(reviewError(code));

    const response = await request(makeApp())
      .post(`/api/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .expect(status);

    expect(response.body).toEqual({ error: code });
  });

  it("fails closed when the router is mounted without authenticated owner state", async () => {
    const response = await request(makeApp(false))
      .post(`/api/guide-deliveries/${deliveryId}/cancel`)
      .expect(401);

    expect(response.body).toEqual({ error: "owner_auth_required" });
    expect(reviewMocks.cancelGuideDelivery).not.toHaveBeenCalled();
  });
});
