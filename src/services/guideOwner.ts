// src/services/guideOwner.ts
import type { DeliveryMode } from "./linkGuidePolicy.js";

export type GuideOwner = "v1" | "v2" | "link";

/**
 * Which path answers a guide request. A link guide is decided by the guide alone and
 * never reaches the strict-gate selector, so no flag or allowlist can put a link guide
 * behind the follow gate. Everything else is the selector's decision, unchanged.
 *
 * Selector errors propagate on purpose: each caller already catches them, logs, and
 * falls back to V1, and that behavior stays where it is.
 */
export function guideOwnerFor(
  input: { deliveryMode: DeliveryMode | undefined; igUserId: string; resourceId: string },
  selectStrictOwner: (input: { igUserId: string; resourceId: string }) => "v1" | "v2",
): GuideOwner {
  if (input.deliveryMode === "link") return "link";
  return selectStrictOwner({ igUserId: input.igUserId, resourceId: input.resourceId });
}
