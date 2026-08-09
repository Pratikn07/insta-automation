import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/guideDeliveryReviewService.js", () => ({
  confirmUnitDelivered: vi.fn(),
  retryUncertainUnit: vi.fn(),
  cancelGuideDelivery: vi.fn(),
}));

import { createGuideDeliveriesRouter } from "./guideDeliveries.routes.js";

const deliveryId = "00000000-0000-4000-8000-000000000001";
const unitId = "00000000-0000-4000-8000-000000000002";
const actor = "authenticated-owner@example.com";

describe("guide delivery owner routes", () => {
  const confirmUnitDelivered = vi.fn();
  const retryUncertainUnit = vi.fn();
  const cancelGuideDelivery = vi.fn();

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.adminEmail = actor;
      next();
    });
    server.use("/guide-deliveries", createGuideDeliveriesRouter({
      confirmUnitDelivered,
      retryUncertainUnit,
      cancelGuideDelivery,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    }));
    return server;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    confirmUnitDelivered.mockResolvedValue({ ok: true, directive: "none", idempotent: true });
    retryUncertainUnit.mockResolvedValue({ ok: true, directive: "resume", idempotent: false });
    cancelGuideDelivery.mockResolvedValue({ ok: true, directive: "none", idempotent: false });
  });

  it("uses only authenticated request state as the confirmation audit actor", async () => {
    await request(app())
      .post(`/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .send({ actor: "spoofed@example.com", action: "retry" })
      .expect(204);

    expect(confirmUnitDelivered).toHaveBeenCalledWith({
      deliveryId,
      unitId,
      actor,
      now: new Date("2026-08-09T12:00:00.000Z"),
    });
  });

  it("accepts only the literal retry acknowledgement and ignores spoofed actor fields", async () => {
    await request(app())
      .post(`/guide-deliveries/${deliveryId}/units/${unitId}/retry`)
      .send({ acknowledgeDuplicateRisk: true, actor: "spoofed@example.com" })
      .expect(202);

    expect(retryUncertainUnit).toHaveBeenCalledWith({
      deliveryId,
      unitId,
      actor,
      acknowledgeDuplicateRisk: true,
      now: new Date("2026-08-09T12:00:00.000Z"),
    });

    await request(app())
      .post(`/guide-deliveries/${deliveryId}/units/${unitId}/retry`)
      .send({ acknowledgeDuplicateRisk: false })
      .expect(400, { error: "duplicate_risk_acknowledgement_required" });
  });

  it.each([
    ["delivery_not_found", 404],
    ["unit_not_found", 404],
    ["delivery_state_changed", 409],
    ["messaging_window_closed", 409],
  ] as const)("maps %s to a stable status", async (error, status) => {
    confirmUnitDelivered.mockResolvedValueOnce({ ok: false, error });
    const response = await request(app())
      .post(`/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .expect(status);
    expect(response.body).toEqual({ error });
  });

  it("returns 202 for started confirmation work and no private row", async () => {
    confirmUnitDelivered.mockResolvedValueOnce({
      ok: true,
      directive: "finalize",
      idempotent: false,
    });
    const response = await request(app())
      .post(`/guide-deliveries/${deliveryId}/units/${unitId}/confirm-delivered`)
      .expect(202);
    expect(response.body).toEqual({});
  });

  it("cancels idempotently with an empty 204 body", async () => {
    const response = await request(app())
      .post(`/guide-deliveries/${deliveryId}/cancel`)
      .send({ actor: "spoofed@example.com" })
      .expect(204);
    expect(response.text).toBe("");
    expect(cancelGuideDelivery).toHaveBeenCalledWith({
      deliveryId,
      actor,
      now: new Date("2026-08-09T12:00:00.000Z"),
    });
  });

  it("rejects malformed UUID paths without calling the service", async () => {
    await request(app())
      .post("/guide-deliveries/not-a-uuid/units/not-a-uuid/confirm-delivered")
      .expect(400, { error: "invalid_guide_delivery_request" });
    expect(confirmUnitDelivered).not.toHaveBeenCalled();
  });
});
