import { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  cancelGuideDelivery,
  confirmUnitDelivered,
  retryUncertainUnit,
  type GuideDeliveryReviewErrorCode,
  type GuideDeliveryReviewResult,
} from "../services/guideDeliveryReviewService.js";
import { guideAccessRepository } from "../services/guideAccessRepository.js";
import { asyncRouter } from "./asyncRouter.js";

export const guideDeliveriesRouter = asyncRouter();

const unitParamsSchema = z.object({
  deliveryId: z.string().uuid(),
  unitId: z.string().uuid(),
});
const deliveryParamsSchema = z.object({ deliveryId: z.string().uuid() });
const accessParamsSchema = z.object({ conversationId: z.string().uuid() });
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

/**
 * Release a guide-access attempt an operator cannot clear any other way.
 *
 * Every fault in the strict-access flow parks the attempt in `needs_review`, which is an
 * ACTIVE state: it blocks the parent's next request for the rest of their messaging window,
 * and nothing automatic clears it. Before this route the only escape was the parent
 * messaging again AFTER the window lapsed, so a parent who gave up stayed blocked with no
 * surface showing it and no action available.
 *
 * Releasing authorizes nothing — a new attempt must earn its own live follow confirmation.
 * But it can mean the parent is sent something they may already have received, which is the
 * judgement this system deliberately gives to a human rather than a retry loop. Hence the
 * same explicit acknowledgement the uncertain-unit retry demands.
 */
guideDeliveriesRouter.post("/access/:conversationId/release", async (req, res) => {
  const actor = owner(req, res);
  if (!actor) return;
  const params = accessParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(404).json({ error: "access_attempt_not_found" });
  const body = retryBodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "duplicate_risk_acknowledgement_required" });
  }

  const result = await guideAccessRepository.releaseAttemptForConversation({
    conversationId: params.data.conversationId,
    actor,
    now: new Date(),
  });
  if (result === "not_found") {
    return res.status(404).json({ error: "access_attempt_not_found" });
  }
  if (result === "delivering") {
    // Expiring a mid-delivery attempt leaves nothing active, so the parent's next message
    // would open a new attempt and send a second guide while the first is still in flight.
    // Cancelling the delivery releases its own attempt correctly.
    return res.status(409).json({ error: "access_attempt_delivering" });
  }
  return res.status(204).end();
});
