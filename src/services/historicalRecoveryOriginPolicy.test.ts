import { describe, expect, it } from "vitest";
import {
  CURRENT_ORIGIN_METHOD,
  evaluateHistoricalOrigin,
  normalizeGeminiVerdict,
} from "./historicalRecoveryOriginPolicy.js";

describe("normalizeGeminiVerdict", () => {
  it.each(["generic handle", "no cue", "no strong cue"])(
    "downgrades contradictory evidence %p to unknown",
    (evidence) => {
      expect(normalizeGeminiVerdict({
        id: "u1",
        origin: "us_western",
        confidence: "low",
        evidence,
      })).toEqual({
        id: "u1",
        origin: "unknown",
        confidence: "low",
        evidence,
      });
    },
  );

  it("preserves a positive Western cue alongside a generic first name", () => {
    expect(normalizeGeminiVerdict({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence: "generic first name, distinctive Western surname Robbins",
    })).toEqual({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence: "generic first name, distinctive Western surname Robbins",
    });
  });

  it("preserves legitimate positive Western evidence", () => {
    expect(normalizeGeminiVerdict({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence: "distinctive Western surname Robbins",
    })).toEqual({
      id: "u1",
      origin: "us_western",
      confidence: "low",
      evidence: "distinctive Western surname Robbins",
    });
  });

  it("downgrades no-name-cue evidence regardless of case", () => {
    expect(normalizeGeminiVerdict({
      id: "u1",
      origin: "us_western",
      confidence: "high",
      evidence: "No Name Cue",
    })).toEqual({
      id: "u1",
      origin: "unknown",
      confidence: "low",
      evidence: "No Name Cue",
    });
  });
});

describe("evaluateHistoricalOrigin", () => {
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
});
