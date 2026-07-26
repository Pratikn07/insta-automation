// ISO country code → audience region, for bucketing Meta's follower geography.
// Kept separate from originInference's name-based Origin taxonomy on purpose:
// that "us_western" bucket includes UK/CA/AU, while `us` here is US-only, so
// sharing names would make the two features silently disagree.
export type FollowerRegion = "us" | "southAsian" | "anglosphere" | "other";

// South Asia beyond the codes seen live today (IN/PK/LK) so a first appearance
// of e.g. BD lands in the right bucket instead of silently joining "other".
const SOUTH_ASIAN = new Set(["IN", "PK", "BD", "LK", "NP", "BT", "MV", "AF"]);

// English-speaking non-US markets — tracked apart from "other" because they are
// the account's second-largest audience block after US and South Asia.
export const ANGLOSPHERE = new Set(["GB", "CA", "AU", "NZ", "IE"]);

export function regionOf(countryCode: string): FollowerRegion {
  const code = countryCode.trim().toUpperCase();
  if (code === "US") return "us";
  if (SOUTH_ASIAN.has(code)) return "southAsian";
  if (ANGLOSPHERE.has(code)) return "anglosphere";
  return "other";
}
