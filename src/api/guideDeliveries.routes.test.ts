import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewMocks = vi.hoisted(() => ({
  confirmUnitDelivered: vi.fn(),
  retryUncertainUnit: vi.fn(),
  cancelGuideDelivery: vi.fn(),
}));
const releaseAttemptForConversation = vi.hoisted(() => vi.fn());
const resendAccessAction = vi.hoisted(() => vi.fn());

vi.mock("../services/guideDeliveryReviewService.js", () => reviewMocks);
vi.mock("../services/guideAccessRepository.js", () => ({
  guideAccessRepository: { releaseAttemptForConversation },
}));
vi.mock("../services/guideAccessReviewService.js", () => ({
  guideAccessReviewService: { resendAction: resendAccessAction },
}));

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
  releaseAttemptForConversation.mockReset().mockResolvedValue("released");
  resendAccessAction.mockReset().mockResolvedValue("sent");
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

// Review round 2, Important. The one remedy for an attempt nobody else can clear.
describe("POST /api/guide-deliveries/access/:conversationId/release", () => {
  const CONVERSATION = "90000000-0000-4000-8000-000000000009";
  const base = `/api/guide-deliveries/access/${CONVERSATION}/release`;

  it("releases a stuck attempt once the operator acknowledges the duplicate risk", async () => {
    releaseAttemptForConversation.mockResolvedValue("released");

    await request(makeApp()).post(base).send({ acknowledgeDuplicateRisk: true }).expect(204);

    expect(releaseAttemptForConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION, actor: OWNER }),
    );
  });

  it("refuses without the acknowledgement, because the parent may already have received it", async () => {
    await request(makeApp())
      .post(base)
      .send({})
      .expect(400, { error: "duplicate_risk_acknowledgement_required" });

    expect(releaseAttemptForConversation).not.toHaveBeenCalled();
  });

  it("refuses to release an attempt that is mid-delivery", async () => {
    releaseAttemptForConversation.mockResolvedValue("delivering");

    await request(makeApp())
      .post(base)
      .send({ acknowledgeDuplicateRisk: true })
      .expect(409, { error: "access_attempt_delivering" });
  });

  it("reports nothing to release when no attempt is active", async () => {
    releaseAttemptForConversation.mockResolvedValue("not_found");

    await request(makeApp())
      .post(base)
      .send({ acknowledgeDuplicateRisk: true })
      .expect(404, { error: "access_attempt_not_found" });
  });

  it("rejects a non-uuid conversation before touching the database", async () => {
    await request(makeApp())
      .post("/api/guide-deliveries/access/not-a-uuid/release")
      .send({ acknowledgeDuplicateRisk: true })
      .expect(404, { error: "access_attempt_not_found" });

    expect(releaseAttemptForConversation).not.toHaveBeenCalled();
  });
});

// Review round 3, Minor. Mount-level `requireAdmin` protects this in production, but the
// route's own `owner()` call is what puts the actor in the audit trail. Replacing it with a
// fallback passed every route test, so a silently wrong `actor` was undetectable.
describe("release requires an authenticated owner for its audit trail", () => {
  it("refuses without authentication and records nothing", async () => {
    await request(makeApp(false))
      .post(`/api/guide-deliveries/access/${randomUUID()}/release`)
      .send({ acknowledgeDuplicateRisk: true })
      .expect(401, { error: "owner_auth_required" });

    expect(releaseAttemptForConversation).not.toHaveBeenCalled();
  });
});

describe("POST /api/guide-deliveries/access/:conversationId/resend-action", () => {
  const CONVERSATION = "90000000-0000-4000-8000-000000000009";
  const base = `/api/guide-deliveries/access/${CONVERSATION}/resend-action`;

  it("sends one fresh action only after the owner acknowledges duplicate risk", async () => {
    await request(makeApp()).post(base).send({ acknowledgeDuplicateRisk: true }).expect(204);

    expect(resendAccessAction).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      actor: OWNER,
      now: expect.any(Date),
    });
  });

  it("does not send without explicit acknowledgement", async () => {
    await request(makeApp())
      .post(base)
      .send({ acknowledgeDuplicateRisk: false })
      .expect(400, { error: "duplicate_risk_acknowledgement_required" });
    expect(resendAccessAction).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404, "access_attempt_not_found"],
    ["messaging_window_closed", 409, "messaging_window_closed"],
    ["delivering", 409, "access_attempt_delivering"],
    ["needs_review", 409, "access_attempt_needs_review"],
  ] as const)("maps %s to a stable owner response", async (result, status, error) => {
    resendAccessAction.mockResolvedValueOnce(result);
    await request(makeApp())
      .post(base)
      .send({ acknowledgeDuplicateRisk: true })
      .expect(status, { error });
  });
});
