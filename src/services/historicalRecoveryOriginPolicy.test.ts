import { describe, expect, it } from "vitest";
import {
  CURRENT_ORIGIN_METHOD,
  evaluateHistoricalOrigin,
  normalizeGeminiVerdict,
} from "./historicalRecoveryOriginPolicy.js";

describe("normalizeGeminiVerdict", () => {
  it.each(["no meaningful cue", "no clear cues", "generic handles have no cues"])(
    "downgrades a structured no-cue Western verdict with evidence %p",
    (evidence) => {
      expect(normalizeGeminiVerdict({
        id: "u1",
        origin: "us_western",
        confidence: "low",
        evidence,
        cueAssessment: "no_meaningful_cue",
      })).toEqual({
        id: "u1",
        origin: "unknown",
        confidence: "low",
        evidence,
      });
    },
  );

  it.each([
    "not a generic handle",
    "generic username, but distinctive Western surname Robbins",
    "common English given name Emily",
  ])("preserves a structured positive Western cue regardless of evidence wording %p", (evidence) => {
    expect(normalizeGeminiVerdict({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence,
      cueAssessment: "positive_cue",
    })).toEqual({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence,
    });
  });

  it.each([null, "", "maybe"])("fails closed for a malformed cue assessment %p", (cueAssessment) => {
    expect(normalizeGeminiVerdict({
      id: "u1",
      origin: "us_western",
      confidence: "high",
      evidence: "distinctive Western surname Robbins",
      cueAssessment,
    })).toEqual({
      id: "u1",
      origin: "unknown",
      confidence: "low",
      evidence: "distinctive Western surname Robbins",
    });
  });
});

describe("evaluateHistoricalOrigin", () => {
  it("uses a new method revision so pre-normalization llm_v1 rows are stale", () => {
    expect(CURRENT_ORIGIN_METHOD).toBe("llm_v2");
    expect(evaluateHistoricalOrigin({
      origin: "us_western",
      confidence: "low",
      method: "llm_v1",
    })).toEqual({ kind: "stale", reason: "origin_not_current_gemini" });
  });

  it("allows a current low-confidence Western verdict", () => {
    expect(evaluateHistoricalOrigin({
      origin: "us_western",
      confidence: "low",
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "allow" });
  });

  it("blocks a current South Asian verdict", () => {
    expect(evaluateHistoricalOrigin({
      origin: "south_asian",
      confidence: "low",
      method: CURRENT_ORIGIN_METHOD,
    })).toEqual({ kind: "block", reason: "audience_south_asian" });
  });

  it("marks a verdict from another method as stale", () => {
    expect(evaluateHistoricalOrigin({
      origin: "us_western",
      confidence: "low",
      method: "name",
    })).toEqual({ kind: "stale", reason: "origin_not_current_gemini" });
  });

  it.each([null, "", "medium", "HIGH"])(
    "blocks current Western verdicts with invalid confidence %p",
    (confidence) => {
      expect(evaluateHistoricalOrigin({
        origin: "us_western",
        confidence,
        method: CURRENT_ORIGIN_METHOD,
      })).toEqual({ kind: "block", reason: "audience_invalid_confidence" });
    },
  );
});
