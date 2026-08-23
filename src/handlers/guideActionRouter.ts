import type { GuideActionTokenAction } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { recordGuideAccessMetric } from "../services/guideAccessMetrics.js";
import {
  checkFollowFromAction,
  requestGuideFromAction,
  type GuideAccessActionOutcome,
} from "../services/guideAccessActionService.js";

const GUIDE_ACTION_PAYLOAD_RE =
  /^ts:guide:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type GuideActionRouterDependencies = {
  loadAction(tokenId: string): Promise<GuideActionTokenAction | null>;
  requestGuideFromAction(
    tokenId: string,
    senderId: string,
    inboundMessageId: string,
    eventAt: Date,
  ): Promise<GuideAccessActionOutcome>;
  checkFollowFromAction(
    tokenId: string,
    senderId: string,
    inboundMessageId: string,
    eventAt: Date,
  ): Promise<GuideAccessActionOutcome>;
  logger: {
    error(bindings: Record<string, unknown>, message: string): void;
  };
  /**
   * Aggregate-only. `received` is every guide control a parent actually operated;
   * `unsupported` is a payload this router could not parse. Recorded here because this is
   * the only place that sees the difference — and because both outcomes were declared in the
   * vocabulary with nothing writing them, which reads as a permanent zero rather than as
   * "no parent has tapped a control yet".
   */
  recordAction(outcome: "received" | "unsupported"): Promise<void>;
};

export type GuideActionRouteInput = {
  payload: unknown;
  senderId: string;
  /** Internal DmMessage UUID for quick replies; postbacks intentionally omit it. */
  inboundMessageId?: string;
  eventAt: Date;
};

export type GuideActionRouteResult =
  | { kind: "ignored" }
  | { kind: "handled"; outcome: GuideAccessActionOutcome };

export function parseGuideActionPayload(payload: unknown): { tokenId: string } | null {
  if (typeof payload !== "string") return null;
  const match = GUIDE_ACTION_PAYLOAD_RE.exec(payload);
  return match ? { tokenId: match[1]! } : null;
}

/** Measurement must never fail a parent's tap. */
async function countAction(
  dependencies: GuideActionRouterDependencies,
  outcome: "received" | "unsupported",
): Promise<void> {
  try {
    await dependencies.recordAction(outcome);
  } catch {
    // Aggregate counter only.
  }
}

export function createGuideActionRouter(dependencies: GuideActionRouterDependencies) {
  return async function routeGuideAction(
    input: GuideActionRouteInput,
  ): Promise<GuideActionRouteResult> {
    const parsed = parseGuideActionPayload(input.payload);
    if (!parsed) {
      await countAction(dependencies, "unsupported");
      return { kind: "ignored" };
    }
    await countAction(dependencies, "received");

    let action: GuideActionTokenAction | null;
    try {
      action = await dependencies.loadAction(parsed.tokenId);
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_action_type_lookup_failed" },
        "Guide action type lookup failed",
      );
      return { kind: "handled", outcome: "access_attempt_needs_review" };
    }
    if (!action) return { kind: "handled", outcome: "action_expired" };

    // A postback has no persisted inbound DmMessage UUID. The opaque token UUID
    // is safe as both the thread lookup miss and the durable follow-recovery
    // trigger. Quick replies retain their internal captured message UUID.
    const inboundMessageId = input.inboundMessageId ?? parsed.tokenId;
    const outcome =
      action === "request_guide"
        ? await dependencies.requestGuideFromAction(
            parsed.tokenId,
            input.senderId,
            inboundMessageId,
            input.eventAt,
          )
        : await dependencies.checkFollowFromAction(
            parsed.tokenId,
            input.senderId,
            inboundMessageId,
            input.eventAt,
          );

    return { kind: "handled", outcome };
  };
}

export const routeGuideAction = createGuideActionRouter({
  async loadAction(tokenId) {
    const token = await prisma.guideActionToken.findUnique({
      where: { id: tokenId },
      select: { action: true },
    });
    return token?.action ?? null;
  },
  recordAction: async (outcome) => {
    await recordGuideAccessMetric("action", outcome);
  },
  requestGuideFromAction,
  checkFollowFromAction,
  logger,
});
