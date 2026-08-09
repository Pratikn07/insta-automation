import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import {
  cancelGuideDelivery,
  confirmUnitDelivered,
  retryUncertainUnit,
  type GuideDeliveryReviewResult,
} from "../services/guideDeliveryReviewService.js";

const idSchema = z.string().uuid();
const retryBodySchema = z.object({
  acknowledgeDuplicateRisk: z.literal(true),
});

type GuideDeliveryReviewRoutesDependencies = {
  confirmUnitDelivered: typeof confirmUnitDelivered;
  retryUncertainUnit: typeof retryUncertainUnit;
  cancelGuideDelivery: typeof cancelGuideDelivery;
  now(): Date;
};

function forwardAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function sendResult(res: Response, result: GuideDeliveryReviewResult) {
  if (result.ok) {
    return result.directive === "none" ? res.status(204).end() : res.status(202).end();
  }
  const status = result.error === "duplicate_risk_acknowledgement_required"
    ? 400
    : result.error === "delivery_not_found" || result.error === "unit_not_found"
      ? 404
      : 409;
  return res.status(status).json({ error: result.error });
}

export function createGuideDeliveriesRouter(
  dependencies: GuideDeliveryReviewRoutesDependencies,
): Router {
  const router = Router();

  router.post("/:deliveryId/units/:unitId/confirm-delivered", forwardAsync(async (req, res) => {
    const deliveryId = idSchema.safeParse(req.params.deliveryId);
    const unitId = idSchema.safeParse(req.params.unitId);
    if (!deliveryId.success || !unitId.success) {
      return res.status(400).json({ error: "invalid_guide_delivery_request" });
    }
    if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });
    const result = await dependencies.confirmUnitDelivered({
      deliveryId: deliveryId.data,
      unitId: unitId.data,
      actor: req.adminEmail,
      now: dependencies.now(),
    });
    return sendResult(res, result);
  }));

  router.post("/:deliveryId/units/:unitId/retry", forwardAsync(async (req, res) => {
    const deliveryId = idSchema.safeParse(req.params.deliveryId);
    const unitId = idSchema.safeParse(req.params.unitId);
    if (!deliveryId.success || !unitId.success) {
      return res.status(400).json({ error: "invalid_guide_delivery_request" });
    }
    if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });
    const body = retryBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "duplicate_risk_acknowledgement_required" });
    }
    const result = await dependencies.retryUncertainUnit({
      deliveryId: deliveryId.data,
      unitId: unitId.data,
      actor: req.adminEmail,
      acknowledgeDuplicateRisk: body.data.acknowledgeDuplicateRisk,
      now: dependencies.now(),
    });
    return sendResult(res, result);
  }));

  router.post("/:deliveryId/cancel", forwardAsync(async (req, res) => {
    const deliveryId = idSchema.safeParse(req.params.deliveryId);
    if (!deliveryId.success) {
      return res.status(400).json({ error: "invalid_guide_delivery_request" });
    }
    if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });
    const result = await dependencies.cancelGuideDelivery({
      deliveryId: deliveryId.data,
      actor: req.adminEmail,
      now: dependencies.now(),
    });
    return sendResult(res, result);
  }));

  return router;
}

export const guideDeliveriesRouter = createGuideDeliveriesRouter({
  confirmUnitDelivered,
  retryUncertainUnit,
  cancelGuideDelivery,
  now: () => new Date(),
});
