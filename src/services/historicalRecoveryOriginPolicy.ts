import { CURRENT_ORIGIN_METHOD } from "./historicalAudienceSegment.js";

export {
  AUDIENCE_SEGMENTS,
  CURRENT_ORIGIN_METHOD,
  deriveAudienceSegment,
  evaluateHistoricalAudience,
  GEMINI_CUE_ASSESSMENTS,
  GEMINI_CUE_KINDS,
} from "./historicalAudienceSegment.js";
export type {
  AudienceSegment,
  GeminiCueAssessment,
  GeminiCueKind,
  HistoricalAudienceDecision,
} from "./historicalAudienceSegment.js";

export type HistoricalOriginDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: "audience_south_asian" }
  | { kind: "stale"; reason: "origin_not_current_gemini" };

/**
 * Compatibility policy for callers not yet migrated to persisted segments.
 * It preserves the binding rule during the transition: only a current South
 * Asian origin blocks; incomplete provenance defers for re-enrichment.
 */
export function evaluateHistoricalOrigin(input: {
  origin: string | null;
  confidence: string | null;
  method: string | null;
}): HistoricalOriginDecision {
  if (input.method !== CURRENT_ORIGIN_METHOD) {
    return { kind: "stale", reason: "origin_not_current_gemini" };
  }
  if (input.confidence !== "high" && input.confidence !== "low") {
    return { kind: "stale", reason: "origin_not_current_gemini" };
  }
  if (input.origin !== "us_western"
    && input.origin !== "south_asian"
    && input.origin !== "other"
    && input.origin !== "unknown") {
    return { kind: "stale", reason: "origin_not_current_gemini" };
  }
  if (input.origin === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" };
  }
  return { kind: "allow" };
}
