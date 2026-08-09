import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { GUIDE_DELIVERY_LEASE_MS: 120_000 } }));
vi.mock("../lib/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("./guideDeliveryCompletion.js", () => ({ finalizeGuideDelivery: vi.fn() }));
vi.mock("./guideDeliveryService.js", () => ({ processClaimedGuideDelivery: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
import type {
  ClaimedGuideDelivery,
  GuideDeliveryRepository,
  OwnerGuideDeliveryTransitionResult,
} from "./guideDeliveryRepository.js";
import { createGuideDeliveryReviewService } from "./guideDeliveryReviewService.js";

const deliveryId = "00000000-0000-4000-8000-000000000001";
const unitId = "00000000-0000-4000-8000-000000000002";
const actor = "owner@example.com";
const now = new Date("2026-08-09T12:00:00.000Z");
const claimToken = "00000000-0000-4000-8000-000000000003";

describe("guide delivery owner review service", () => {
  const ownerConfirmUnitDelivered = vi.fn();
  const ownerRetryUncertainUnit = vi.fn();
  const ownerCancelDelivery = vi.fn();
  const claimById = vi.fn();
  const processClaimedGuideDelivery = vi.fn();
  const finalizeGuideDelivery = vi.fn();
  const loggerError = vi.fn();

  function subject() {
    return createGuideDeliveryReviewService({
      repository: {
        ownerConfirmUnitDelivered,
        ownerRetryUncertainUnit,
        ownerCancelDelivery,
        claimById,
      } as unknown as GuideDeliveryRepository,
      processClaimedGuideDelivery,
      finalizeGuideDelivery,
      leaseMs: 120_000,
      logger: { error: loggerError },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    claimById.mockResolvedValue({ id: deliveryId, claimToken } as ClaimedGuideDelivery);
    processClaimedGuideDelivery.mockResolvedValue("completed");
    finalizeGuideDelivery.mockResolvedValue("completed");
    ownerCancelDelivery.mockResolvedValue({ ok: true, directive: "none", idempotent: false });
  });

  it("confirms under the repository lock before starting post-commit resume", async () => {
    const order: string[] = [];
    ownerConfirmUnitDelivered.mockImplementation(async () => {
      order.push("committed");
      return { ok: true, directive: "resume", idempotent: false } satisfies OwnerGuideDeliveryTransitionResult;
    });
    processClaimedGuideDelivery.mockImplementation(async () => {
      order.push("processed");
      return "completed";
    });

    await expect(subject().confirmUnitDelivered({ deliveryId, unitId, actor, now }))
      .resolves.toEqual({ ok: true, directive: "resume", idempotent: false });

    expect(order).toEqual(["committed", "processed"]);
    expect(ownerConfirmUnitDelivered).toHaveBeenCalledWith({ deliveryId, unitId, actor, now });
    expect(claimById).toHaveBeenCalledWith({
      deliveryId,
      now,
      claimExpiresAt: new Date(now.getTime() + 120_000),
    });
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("finalizes confirmed all-sent work only after the transition commits", async () => {
    ownerConfirmUnitDelivered.mockResolvedValue({
      ok: true,
      directive: "finalize",
      idempotent: false,
    });

    await expect(subject().confirmUnitDelivered({ deliveryId, unitId, actor, now }))
      .resolves.toMatchObject({ ok: true, directive: "finalize" });

    expect(finalizeGuideDelivery).toHaveBeenCalledWith(deliveryId, claimToken);
    expect(processClaimedGuideDelivery).not.toHaveBeenCalled();
  });

  it("does not invoke processor/finalizer when a transition loses its state fence", async () => {
    ownerConfirmUnitDelivered.mockResolvedValue({ ok: false, error: "delivery_state_changed" });

    await expect(subject().confirmUnitDelivered({ deliveryId, unitId, actor, now }))
      .resolves.toEqual({ ok: false, error: "delivery_state_changed" });

    expect(claimById).not.toHaveBeenCalled();
    expect(processClaimedGuideDelivery).not.toHaveBeenCalled();
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("requires a literal duplicate-risk acknowledgement before touching the repository", async () => {
    await expect(subject().retryUncertainUnit({
      deliveryId,
      unitId,
      actor,
      acknowledgeDuplicateRisk: false,
      now,
    })).resolves.toEqual({ ok: false, error: "duplicate_risk_acknowledgement_required" });

    expect(ownerRetryUncertainUnit).not.toHaveBeenCalled();
  });

  it("authorizes one retry before starting post-commit processing", async () => {
    ownerRetryUncertainUnit.mockResolvedValue({
      ok: true,
      directive: "resume",
      idempotent: false,
    });

    await expect(subject().retryUncertainUnit({
      deliveryId,
      unitId,
      actor,
      acknowledgeDuplicateRisk: true,
      now,
    })).resolves.toMatchObject({ ok: true, directive: "resume" });

    expect(ownerRetryUncertainUnit).toHaveBeenCalledWith({ deliveryId, unitId, actor, now });
    expect(processClaimedGuideDelivery).toHaveBeenCalledTimes(1);
  });

  it("cancels without claiming, processing, or finalizing", async () => {
    await expect(subject().cancelGuideDelivery({ deliveryId, actor, now }))
      .resolves.toEqual({ ok: true, directive: "none", idempotent: false });

    expect(ownerCancelDelivery).toHaveBeenCalledWith({ deliveryId, actor, now });
    expect(claimById).not.toHaveBeenCalled();
    expect(processClaimedGuideDelivery).not.toHaveBeenCalled();
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("contains post-commit failures without logging private records", async () => {
    ownerConfirmUnitDelivered.mockResolvedValue({
      ok: true,
      directive: "resume",
      idempotent: false,
    });
    processClaimedGuideDelivery.mockRejectedValue(new Error("PRIVATE SNAPSHOT"));

    await expect(subject().confirmUnitDelivered({ deliveryId, unitId, actor, now }))
      .resolves.toMatchObject({ ok: true, directive: "resume" });

    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "guide_delivery_owner_resume_failed", deliveryId },
      "Guide delivery owner action could not start post-commit work",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PRIVATE SNAPSHOT");
  });
});
