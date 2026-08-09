import type { Origin } from "./originInference.js";

/** Method identifier for the current Gemini origin classifier. */
export const CURRENT_ORIGIN_METHOD = "llm_v2";

export const GEMINI_CUE_ASSESSMENTS = ["positive_cue", "no_meaningful_cue"] as const;
export type GeminiCueAssessment = (typeof GEMINI_CUE_ASSESSMENTS)[number];

export type GeminiOriginVerdict = {
  id: string;
  origin: Origin;
  confidence: "high" | "low";
  evidence: string;
  cueAssessment: string | null;
};

export type NormalizedGeminiOriginVerdict = Omit<GeminiOriginVerdict, "cueAssessment">;

/**
 * Convert Gemini's structured cue decision into the only verdict shape that may be
 * persisted. Evidence remains free text for audit, but never controls authorization.
 */
export function normalizeGeminiVerdict(
  verdict: GeminiOriginVerdict,
): NormalizedGeminiOriginVerdict {
  const { cueAssessment, ...normalized } = verdict;
  if (cueAssessment !== "positive_cue") {
    return { ...normalized, origin: "unknown", confidence: "low" };
  }
  return normalized;
}

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
