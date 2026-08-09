import type { Origin } from "./originInference.js";

/** Method identifier for the current Gemini origin classifier. */
export const CURRENT_ORIGIN_METHOD = "llm_v1";

export type GeminiOriginVerdict = {
  id: string;
  origin: Origin;
  confidence: "high" | "low";
  evidence: string;
};

// Gemini sometimes returns a Western label while its evidence admits that the
// name is generic or has no usable cue. Those are contradictory, so keep the
// auditable evidence but make the verdict an honest abstention. Word boundaries
// prevent fragments inside unrelated words from triggering the downgrade.
const CONTRADICTORY_WESTERN_EVIDENCE = [
  /\bgeneric\b/i,
  /\bno\s+(?:(?:strong|clear|recognizable|distinctive)\s+)?(?:(?:name|username)\s+)?cue\b/i,
  /\bnothing\s+to\s+go\s+on\b/i,
];

export function normalizeGeminiVerdict(verdict: GeminiOriginVerdict): GeminiOriginVerdict {
  if (
    verdict.origin === "us_western"
    && CONTRADICTORY_WESTERN_EVIDENCE.some((pattern) => pattern.test(verdict.evidence))
  ) {
    return { ...verdict, origin: "unknown", confidence: "low" };
  }
  return verdict;
}

export type HistoricalOriginDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: "audience_south_asian" | "audience_other" | "audience_unknown" }
  | { kind: "stale"; reason: "origin_not_current_gemini" };

export function evaluateHistoricalOrigin(input: {
  origin: string | null;
  confidence: string | null;
  method: string | null;
}): HistoricalOriginDecision {
  if (input.method !== CURRENT_ORIGIN_METHOD) {
    return { kind: "stale", reason: "origin_not_current_gemini" };
  }
  if (input.origin === "us_western") return { kind: "allow" };
  if (input.origin === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" };
  }
  if (input.origin === "other") return { kind: "block", reason: "audience_other" };
  return { kind: "block", reason: "audience_unknown" };
}
