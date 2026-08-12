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
  | {
      kind: "block";
      reason:
        | "audience_south_asian"
        | "audience_other"
        | "audience_unknown"
        | "audience_invalid_confidence";
    }
  | { kind: "stale"; reason: "origin_not_current_gemini" };

/**
 * Compatibility policy for legacy callers. Task 3 migrates selection and
 * dispatch callers to evaluateHistoricalAudience(), which also validates the
 * persisted segment.
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
    return { kind: "block", reason: "audience_invalid_confidence" };
  }
  if (input.origin === "us_western") return { kind: "allow" };
  if (input.origin === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" };
  }
  if (input.origin === "other") return { kind: "block", reason: "audience_other" };
  return { kind: "block", reason: "audience_unknown" };
}
