import { createHash } from "node:crypto";
import { env, guideFollowGateV2Ids } from "../config/env.js";
import { flags } from "./flagService.js";

export type GuideCoverDeliveryDecision = "include" | "omit";

export interface GuideCoverDeliverySelectorDependencies {
  /** Read on every delivery so an operator stop applies to the next plan compiled. */
  isEnabled(): boolean;
  /**
   * Read per decision, not captured at construction.
   *
   * Eagerly building this set at module scope would touch `env` the moment anything in the
   * import graph loaded this file, which both freezes the allowlist until a restart and
   * breaks every unrelated test that mocks `../config/env.js` without the parser export.
   */
  resourceIds(): ReadonlySet<string>;
  rolloutPercent(): number;
}

export interface GuideCoverDeliverySelectionInput {
  resourceId: string;
  /** Stable bucketing key. The trigger, so one journey never flips mid-flight. */
  triggerId: string;
}

/**
 * Decides only whether a cover is INCLUDED in a guide plan.
 *
 * It has no bearing on strict follower authorization and no bearing on which service owns
 * the guide send. Turning this off must never let an unauthorized guide out, and must never
 * stop an authorized guide going out — only its cover.
 *
 * Fails closed to `omit` on every malformed input, a throwing flag read, a malformed set, or
 * an out-of-range percent, so a configuration mistake can only ever send less.
 */
export function createGuideCoverDeliverySelector(
  dependencies: GuideCoverDeliverySelectorDependencies,
) {
  return {
    decide(input: GuideCoverDeliverySelectionInput): GuideCoverDeliveryDecision {
      if (input === null || typeof input !== "object") return "omit";
      if (
        typeof input.resourceId !== "string" ||
        input.resourceId.length === 0 ||
        typeof input.triggerId !== "string" ||
        input.triggerId.length === 0
      ) {
        return "omit";
      }

      let enabled: boolean;
      try {
        enabled = dependencies.isEnabled() === true;
      } catch {
        return "omit";
      }
      if (!enabled) return "omit";

      // An explicitly allowlisted guide is always in, regardless of percent. That is how a
      // single controlled guide is piloted before any percentage exists.
      let allowlisted: unknown;
      try {
        const ids = dependencies.resourceIds();
        if (ids === null || ids === undefined) return "omit";
        const has = ids?.has;
        if (typeof has !== "function") return "omit";
        allowlisted = has.call(ids, input.resourceId);
      } catch {
        return "omit";
      }
      if (allowlisted === true) return "include";
      if (allowlisted !== false) return "omit";

      let percent: number;
      try {
        percent = dependencies.rolloutPercent();
      } catch {
        return "omit";
      }
      if (!Number.isInteger(percent) || percent <= 0 || percent > 100) return "omit";

      // Hashed on the trigger so the decision is stable for one journey and independent of
      // the guide, rather than sending covers to a shifting set on every retry.
      const bucket = createHash("sha256").update(input.triggerId).digest().readUInt32BE(0);
      return bucket % 100 < percent ? "include" : "omit";
    },
  };
}

/** Runtime selector. Reads the switch per decision so a stop is immediate. */
export const guideCoverDeliverySelector = createGuideCoverDeliverySelector({
  isEnabled: () => flags.bool("GUIDE_COVER_DELIVERY_ENABLED"),
  resourceIds: () => guideFollowGateV2Ids(env.GUIDE_COVER_DELIVERY_RESOURCE_IDS),
  rolloutPercent: () => flags.percent("GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT"),
});
