import { env, parseIdentifierSet } from "../config/env.js";
import { flags } from "./flagService.js";

export type GuideFollowGateOwner = "v1" | "v2";

export interface GuideFollowGateV2SelectorDependencies {
  /** Read on every parent action; never capture the result at construction. */
  isEnabled(): boolean;
  cohortIgUserIds: ReadonlySet<string>;
  resourceIds: ReadonlySet<string>;
}

export interface GuideFollowGateV2SelectionInput {
  igUserId: string;
  resourceId: string;
}

function exactMember(set: ReadonlySet<string>, value: string): boolean | null {
  try {
    const has = set?.has;
    if (typeof has !== "function") return null;
    const result = has.call(set, value);
    return typeof result === "boolean" ? result : null;
  } catch {
    return null;
  }
}

/**
 * Stable allowlist-first rollout. There is intentionally no percentage input:
 * broad assignment comes only after the controlled account/guide pilot.
 */
export function createGuideFollowGateV2Selector(
  dependencies: GuideFollowGateV2SelectorDependencies,
) {
  return {
    owner(input: GuideFollowGateV2SelectionInput): GuideFollowGateOwner {
      if (input === null || typeof input !== "object") return "v1";
      if (
        typeof input.igUserId !== "string" ||
        input.igUserId.length === 0 ||
        typeof input.resourceId !== "string" ||
        input.resourceId.length === 0
      ) {
        return "v1";
      }

      let enabled: boolean;
      try {
        enabled = dependencies.isEnabled() === true;
      } catch {
        return "v1";
      }
      if (!enabled) return "v1";

      const accountMatch = exactMember(dependencies.cohortIgUserIds, input.igUserId);
      if (accountMatch === null) return "v1";
      if (accountMatch) return "v2";

      const guideMatch = exactMember(dependencies.resourceIds, input.resourceId);
      if (guideMatch === null) return "v1";
      return guideMatch ? "v2" : "v1";
    },
  };
}

/** Runtime selector consumed by Task 7 handler branches. */
export const guideFollowGateV2Selector = createGuideFollowGateV2Selector({
  isEnabled: () => flags.bool("GUIDE_FOLLOW_GATE_V2_ENABLED"),
  cohortIgUserIds: parseIdentifierSet(env.GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS),
  resourceIds: parseIdentifierSet(env.GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS),
});

/** Rich controls are also read per outbound action, so the stop is immediate. */
export function guideRichGateEnabled(): boolean {
  return flags.bool("GUIDE_RICH_GATE_ENABLED");
}
