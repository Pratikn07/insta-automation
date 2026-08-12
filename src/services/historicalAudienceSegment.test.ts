import { describe, expect, it } from "vitest";
import {
  CURRENT_ORIGIN_METHOD,
  deriveAudienceSegment,
  evaluateHistoricalAudience,
} from "./historicalAudienceSegment.js";

describe("deriveAudienceSegment", () => {
  it.each([
    ["us_western", "positive_cue", "distinctive_cultural", "western"],
    ["other", "positive_cue", "distinctive_cultural", "other"],
    ["unknown", "positive_cue", "ambiguous_cultural", "unknown_cue"],
    ["unknown", "no_meaningful_cue", "generic_or_no_cue", "unknown_generic"],
    ["south_asian", "positive_cue", "distinctive_cultural", "south_asian"],
  ] as const)("derives %s/%s/%s as %s", (origin, cueAssessment, cueKind, expected) => {
    expect(deriveAudienceSegment({ origin, cueAssessment, cueKind })).toBe(expected);
  });

  it.each([
    ["us_western", "no_meaningful_cue", "generic_or_no_cue"],
    ["unknown", "positive_cue", "generic_or_no_cue"],
    ["south_asian", "positive_cue", "ambiguous_cultural"],
    ["other", "positive_cue", "ambiguous_cultural"],
    ["unknown", "no_meaningful_cue", "ambiguous_cultural"],
    ["unknown", "positive_cue", "distinctive_cultural"],
  ])("rejects contradictory %s/%s/%s combinations", (origin, cueAssessment, cueKind) => {
    expect(deriveAudienceSegment({ origin, cueAssessment, cueKind })).toBeNull();
  });

  it("does not derive the no-name segment from Gemini fields", () => {
    expect(deriveAudienceSegment({
      origin: "unknown",
      cueAssessment: "no_meaningful_cue",
      cueKind: "unknown_no_name",
    })).toBeNull();
  });
});

describe("evaluateHistoricalAudience", () => {
  it.each([
    ["western", "us_western"],
    ["other", "other"],
    ["unknown_cue", "unknown"],
    ["unknown_generic", "unknown"],
    ["unknown_no_name", "unknown"],
  ] as const)("allows the current %s segment", (segment, origin) => {
    expect(evaluateHistoricalAudience({
      segment,
      origin,
      confidence: "low",
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "allow" });
  });

  it.each(["high", "low"] as const)("blocks %s-confidence South Asian", (confidence) => {
    expect(evaluateHistoricalAudience({
      segment: "south_asian",
      origin: "south_asian",
      confidence,
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "block", reason: "audience_south_asian" });
  });

  it("defers an invalid confidence instead of authorizing", () => {
    expect(evaluateHistoricalAudience({
      segment: "western",
      origin: "us_western",
      confidence: "medium",
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "defer", reason: "audience_segment_invalid" });
  });

  it("defers a contradictory segment and origin pairing", () => {
    expect(evaluateHistoricalAudience({
      segment: "western",
      origin: "other",
      confidence: "low",
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "defer", reason: "audience_segment_invalid" });
  });

  it("defers an llm_v2 verdict as stale", () => {
    expect(evaluateHistoricalAudience({
      segment: "western",
      origin: "us_western",
      confidence: "low",
      method: "llm_v2",
    })).toEqual({ kind: "defer", reason: "origin_not_current_gemini" });
  });
});
