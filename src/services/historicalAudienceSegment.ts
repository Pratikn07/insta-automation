import type { Origin } from "./originInference.js";

export const AUDIENCE_SEGMENTS = [
  "western", "other", "unknown_cue", "unknown_generic", "unknown_no_name", "south_asian",
] as const;
export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number];

export const CURRENT_ORIGIN_METHOD = "llm_v3";

export const GEMINI_CUE_ASSESSMENTS = ["positive_cue", "no_meaningful_cue"] as const;
export type GeminiCueAssessment = (typeof GEMINI_CUE_ASSESSMENTS)[number];

export const GEMINI_CUE_KINDS = [
  "distinctive_cultural", "ambiguous_cultural", "generic_or_no_cue",
] as const;
export type GeminiCueKind = (typeof GEMINI_CUE_KINDS)[number];

const AUDIENCE_SEGMENT_BY_GEMINI_RESPONSE = new Map<string, AudienceSegment>([
  ["us_western/positive_cue/distinctive_cultural", "western"],
  ["other/positive_cue/distinctive_cultural", "other"],
  ["unknown/positive_cue/ambiguous_cultural", "unknown_cue"],
  ["unknown/no_meaningful_cue/generic_or_no_cue", "unknown_generic"],
  ["south_asian/positive_cue/distinctive_cultural", "south_asian"],
]);

const ORIGIN_BY_AUDIENCE_SEGMENT: Record<AudienceSegment, Origin> = {
  western: "us_western",
  other: "other",
  unknown_cue: "unknown",
  unknown_generic: "unknown",
  unknown_no_name: "unknown",
  south_asian: "south_asian",
};

/**
 * Derive the audience segment from Gemini's structured enums only. Audit
 * evidence is intentionally not accepted here, so it cannot authorize a send.
 */
export function deriveAudienceSegment(input: {
  origin: string | null;
  cueAssessment: string | null;
  cueKind: string | null;
}): AudienceSegment | null {
  return AUDIENCE_SEGMENT_BY_GEMINI_RESPONSE.get(
    `${input.origin}/${input.cueAssessment}/${input.cueKind}`,
  ) ?? null;
}

export type HistoricalAudienceDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: "audience_south_asian" }
  | {
      kind: "defer";
      reason: "origin_not_current_gemini" | "audience_segment_invalid";
    };

/**
 * Authorize only current, internally consistent audience classifications.
 * `unknown_no_name` is a deterministic non-Gemini segment but uses the same
 * current-method provenance once persisted by the enrichment worker.
 */
export function evaluateHistoricalAudience(input: {
  segment: string | null;
  origin: string | null;
  confidence: string | null;
  method: string | null;
}): HistoricalAudienceDecision {
  if (input.method !== CURRENT_ORIGIN_METHOD) {
    return { kind: "defer", reason: "origin_not_current_gemini" };
  }
  if (input.confidence !== "high" && input.confidence !== "low") {
    return { kind: "defer", reason: "audience_segment_invalid" };
  }
  if (!isValidAudienceSegmentOriginPair(input.segment, input.origin)) {
    return { kind: "defer", reason: "audience_segment_invalid" };
  }
  if (input.segment === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" };
  }
  return { kind: "allow" };
}

function isValidAudienceSegmentOriginPair(
  segment: string | null,
  origin: string | null,
): segment is AudienceSegment {
  return segment !== null
    && origin !== null
    && Object.hasOwn(ORIGIN_BY_AUDIENCE_SEGMENT, segment)
    && ORIGIN_BY_AUDIENCE_SEGMENT[segment as AudienceSegment] === origin;
}
