import { describe, expect, it } from "vitest";
import { originVerdictWriteData, readStoredOrigin } from "./originVerdictStore.js";

const row = (over: Partial<NonNullable<Parameters<typeof readStoredOrigin>[0]>> = {}) => ({
  username: "someone",
  name: "Some One",
  inferredOrigin: "south_asian",
  originConfidence: "high",
  originMethod: "llm_v3",
  ...over,
});

describe("readStoredOrigin", () => {
  it("returns a current-method verdict", () => {
    expect(readStoredOrigin(row())).toEqual({ origin: "south_asian", confidence: "high" });
  });

  it("returns null for a null person", () => {
    expect(readStoredOrigin(null)).toBeNull();
  });

  it("returns null when the method is not the current prompt version", () => {
    expect(readStoredOrigin(row({ originMethod: "name" }))).toBeNull();
  });

  it("returns null when the stored origin is not a known value", () => {
    expect(readStoredOrigin(row({ inferredOrigin: "martian" }))).toBeNull();
  });

  it('reads anything that is not exactly "high" as low', () => {
    expect(readStoredOrigin(row({ originConfidence: "HIGH" }))).toEqual({
      origin: "south_asian",
      confidence: "low",
    });
  });
});

describe("originVerdictWriteData", () => {
  it("stamps every field the cached read requires", () => {
    const now = new Date("2026-09-27T00:00:00.000Z");
    expect(
      originVerdictWriteData(
        {
          id: "1",
          origin: "us_western",
          confidence: "high",
          cueKind: "distinctive_cultural",
          audienceSegment: "western",
          evidence: "anglophone given name",
        },
        now,
      ),
    ).toEqual({
      inferredOrigin: "us_western",
      originConfidence: "high",
      originMethod: "llm_v3",
      originEvidence: "anglophone given name",
      audienceSegment: "western",
      originCheckedAt: now,
    });
  });
});
