import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  cancelGuideDelivery,
  confirmUnitDelivered,
  retryUncertainUnit,
  type GuideDeliveryReviewErrorCode,
  type GuideDeliveryReviewResult,
} from "../services/guideDeliveryReviewService.js";

export const guideDeliveriesRouter = Router();

const unitParamsSchema = z.object({
  deliveryId: z.string().uuid(),
  unitId: z.string().uuid(),
});
const deliveryParamsSchema = z.object({ deliveryId: z.string().uuid() });
const retryBodySchema = z.object({ acknowledgeDuplicateRisk: z.literal(true) });

const ERROR_STATUS: Record<GuideDeliveryReviewErrorCode, number> = {
  duplicate_risk_acknowledgement_required: 400,
  delivery_not_found: 404,
  unit_not_found: 404,
  delivery_state_changed: 409,
  messaging_window_closed: 409,
};

function owner(req: Request, res: Response): string | null {
  if (req.adminEmail) return req.adminEmail;
  res.status(401).json({ error: "owner_auth_required" });
  return null;
}

function sendResult(res: Response, result: GuideDeliveryReviewResult): void {
  if (result.status === "processing_started") {
    res.status(202).end();
    return;
  }
  res.status(204).end();
}

function reviewErrorCode(error: unknown): GuideDeliveryReviewErrorCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && code in ERROR_STATUS
    ? (code as GuideDeliveryReviewErrorCode)
    : null;
}

function sendReviewError(res: Response, error: unknown): boolean {
  const code = reviewErrorCode(error);
  if (!code) return false;
  res.status(ERROR_STATUS[code]).json({ error: code });
  return true;
}

async function handleReviewAction(
  res: Response,
  next: NextFunction,
  action: () => Promise<GuideDeliveryReviewResult>,
): Promise<void> {
  try {
    sendResult(res, await action());
  } catch (error) {
    if (!sendReviewError(res, error)) next(error);
  }
}

guideDeliveriesRouter.post(
  "/:deliveryId/units/:unitId/confirm-delivered",
  async (req, res, next) => {
    const actor = owner(req, res);
    if (!actor) return;
    const params = unitParamsSchema.safeParse(req.params);
    if (!params.success) {
      const error = z.string().uuid().safeParse(req.params.deliveryId).success
        ? "unit_not_found"
        : "delivery_not_found";
      return res.status(404).json({ error });
    }
    await handleReviewAction(res, next, () =>
      confirmUnitDelivered({ ...params.data, actor, now: new Date() }),
    );
  },
);

guideDeliveriesRouter.post("/:deliveryId/units/:unitId/retry", async (req, res, next) => {
  const actor = owner(req, res);
  if (!actor) return;
  const params = unitParamsSchema.safeParse(req.params);
  if (!params.success) {
    const error = z.string().uuid().safeParse(req.params.deliveryId).success
      ? "unit_not_found"
      : "delivery_not_found";
    return res.status(404).json({ error });
  }
  const body = retryBodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "duplicate_risk_acknowledgement_required" });
  }
  await handleReviewAction(res, next, () =>
    retryUncertainUnit({ ...params.data, actor, ...body.data, now: new Date() }),
  );
});

guideDeliveriesRouter.post("/:deliveryId/cancel", async (req, res, next) => {
  const actor = owner(req, res);
  if (!actor) return;
  const params = deliveryParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(404).json({ error: "delivery_not_found" });
  await handleReviewAction(res, next, () =>
    cancelGuideDelivery({ ...params.data, actor, now: new Date() }),
  );
});
