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
 * Only a structurally valid current Western verdict may authorize during the
 * transition. South Asian remains a terminal block; every other provenance is
 * deferred for segment-aware callers rather than treated as an allowed audience.
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
  if (input.origin === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" };
  }
  if (input.origin === "us_western") return { kind: "allow" };
  return { kind: "stale", reason: "origin_not_current_gemini" };
}
