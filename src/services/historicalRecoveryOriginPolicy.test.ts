import { describe, expect, it } from "vitest";
import {
  CURRENT_ORIGIN_METHOD,
  evaluateHistoricalOrigin,
} from "./historicalRecoveryOriginPolicy.js";

describe("historical recovery origin-policy compatibility", () => {
  it("moves the shared Gemini method revision to llm_v3", () => {
    expect(CURRENT_ORIGIN_METHOD).toBe("llm_v3");
  });

  it("keeps legacy origin callers fail-closed until segment-aware checks replace them", () => {
    expect(evaluateHistoricalOrigin({
      origin: "us_western",
      confidence: "low",
      method: "llm_v2",
    })).toEqual({ kind: "stale", reason: "origin_not_current_gemini" });
  });
});
