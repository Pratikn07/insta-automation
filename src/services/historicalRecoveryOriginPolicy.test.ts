import { describe, expect, it } from "vitest";
import {
  CURRENT_ORIGIN_METHOD,
  evaluateHistoricalOrigin,
} from "./historicalRecoveryOriginPolicy.js";

describe("historical recovery origin-policy compatibility", () => {
  it("moves the shared Gemini method revision to llm_v3", () => {
    expect(CURRENT_ORIGIN_METHOD).toBe("llm_v3");
  });

  it.each(["us_western", "other", "unknown"] as const)(
    "allows current non-South-Asian %s provenance during migration",
    (origin) => {
      expect(evaluateHistoricalOrigin({
        origin,
        confidence: "low",
        method: CURRENT_ORIGIN_METHOD,
      })).toEqual({ kind: "allow" });
    },
  );

  it.each(["high", "low"] as const)("blocks current %s-confidence South Asian provenance", (confidence) => {
    expect(evaluateHistoricalOrigin({
      origin: "south_asian",
      confidence,
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "block", reason: "audience_south_asian" });
  });

  it.each([
    ["missing origin", { origin: null, confidence: "low", method: CURRENT_ORIGIN_METHOD }],
    ["missing confidence", { origin: "unknown", confidence: null, method: CURRENT_ORIGIN_METHOD }],
    ["missing method", { origin: "unknown", confidence: "low", method: null }],
  ])("defers incomplete current provenance: %s", (_label, input) => {
    expect(evaluateHistoricalOrigin(input)).toEqual({
      kind: "stale",
      reason: "origin_not_current_gemini",
    });
  });

  it("defers a previous Gemini revision", () => {
    expect(evaluateHistoricalOrigin({
      origin: "us_western",
      confidence: "low",
      method: "llm_v2",
    })).toEqual({ kind: "stale", reason: "origin_not_current_gemini" });
  });
});
