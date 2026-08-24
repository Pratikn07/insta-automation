import { env, parseIdentifierSet } from "../config/env.js";
import { flags } from "./flagService.js";

export type GuideFollowGateOwner = "v1" | "v2";

export interface GuideFollowGateV2SelectorDependencies {
  /** Read on every parent action; never capture the result at construction. */
  isEnabled(): boolean;
  /**
   * Every guide, past and future — the graduation from the pilot.
   *
   * Read per action like `isEnabled`, and deliberately a FLAG rather than a wider allowlist.
   * The allowlists below can only ever name guides that exist when an operator pastes them in,
   * so a keyword attached next week silently stayed on V1: no error, no log, nothing to notice.
   * That is the gap this closes.
   *
   * Checked before the allowlists, so turning it on makes them irrelevant rather than requiring
   * them to be emptied — and emptying them would DISABLE V2, not widen it.
   */
  isAllGuides(): boolean;
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
 * Stable allowlist-first rollout, with an explicit graduation to every guide.
 *
 * There is still no PERCENTAGE input, and that remains deliberate: a percentage would split
 * one guide's parents into two different experiences for no reason anyone could explain. The
 * pilot this comment used to gate on has now happened — one account, then 46 guides, verified
 * end to end on a real device with zero send errors — so `isAllGuides` is the switch that
 * broadens it, covering guides that do not exist yet.
 *
 * Everything still fails closed to `"v1"`: a bad input, an unreadable flag, a thrown set
 * membership check. V1 is the path that has been converting all along, so it is the safe
 * answer to every question this function cannot answer.
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

      // Before the allowlists, so broadening does not require emptying them — and emptying them
      // would disable V2 rather than widen it. Wrapped because an unreadable flag must not be
      // the reason a parent's journey changes.
      try {
        if (dependencies.isAllGuides() === true) return "v2";
      } catch {
        return "v1";
      }

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
  isAllGuides: () => flags.bool("GUIDE_FOLLOW_GATE_V2_ALL"),
  cohortIgUserIds: parseIdentifierSet(env.GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS),
  resourceIds: parseIdentifierSet(env.GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS),
});

/** Rich controls are also read per outbound action, so the stop is immediate. */
export function guideRichGateEnabled(): boolean {
  return flags.bool("GUIDE_RICH_GATE_ENABLED");
}
