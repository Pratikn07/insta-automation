import { describe, expect, it } from "vitest";
import { hasExactHistoricalAudienceShape } from "../../scripts/expanded-recovery-audit.js";

describe("expanded recovery audit parity", () => {
  it("uses the production JS no-name normalization rather than SQL trim emulation", () => {
    expect(hasExactHistoricalAudienceShape({ username: " - ", name: "\t", segment: "unknown_no_name", origin: "unknown", confidence: "low", method: "llm_v3" })).toBe(true);
    expect(hasExactHistoricalAudienceShape({ username: " — ", name: "\t", segment: "unknown_no_name", origin: "unknown", confidence: "low", method: "llm_v3" })).toBe(false);
  });
});
