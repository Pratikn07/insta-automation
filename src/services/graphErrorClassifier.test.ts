import { describe, expect, it } from "vitest";
import type { GraphErrorMetadata } from "./eventLogger.js";
import {
  classifyPrivateGateFailure,
  classifyPublicReplyFailure,
  parseGraphSignatures,
} from "./graphErrorClassifier.js";

function graphMetadata(overrides: Partial<GraphErrorMetadata> = {}): GraphErrorMetadata {
  return {
    category: overrides.httpStatus !== undefined && overrides.httpStatus === null ? "graph_transport" : "graph_response",
    httpStatus: overrides.httpStatus ?? 400,
    graphCode: overrides.graphCode ?? null,
    graphSubcode: overrides.graphSubcode ?? null,
    traceId: overrides.traceId ?? "trace-123",
    ...overrides,
  };
}

describe("graphErrorClassifier", () => {
  describe("parseGraphSignatures", () => {
    it("parses valid code:subcode strings", () => {
      const parsed = parseGraphSignatures("10:12345, 200:54321, invalid, 10:12345");
      expect(Array.from(parsed)).toEqual(["10:12345", "200:54321"]);
    });

    it("handles empty or whitespace strings", () => {
      expect(Array.from(parseGraphSignatures(""))).toEqual([]);
      expect(Array.from(parseGraphSignatures("   "))).toEqual([]);
    });
  });

  describe("classifyPrivateGateFailure", () => {
    it.each([
      [graphMetadata({ graphCode: 10, graphSubcode: 12345 }), ["10:12345"], "settings_blocked"],
      [graphMetadata({ graphCode: 10, graphSubcode: 99999 }), ["10:12345"], "permission_or_auth"],
      [graphMetadata({ graphCode: 4, graphSubcode: 2534025 }), ["4:2534025"], "rate_limited"],
      [graphMetadata({ graphCode: 4 }), [], "rate_limited"],
      [graphMetadata({ graphCode: 17 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 429 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 503, category: "graph_transport" }), [], "retryable_transport"],
      [graphMetadata({ httpStatus: 400, graphCode: 100 }), [], "permanent"],
    ])("classifies private gate failures accurately", (metadata, allowlist, expected) => {
      const allowSet = new Set(allowlist);
      expect(classifyPrivateGateFailure(metadata, allowSet)).toBe(expected);
    });

    it("never classifies HTTP 400 without allowlisted signature as settings_blocked", () => {
      expect(classifyPrivateGateFailure(graphMetadata({ httpStatus: 400 }), new Set())).not.toBe(
        "settings_blocked",
      );
    });

    it("prioritizes rate limit signatures over settings allowlist", () => {
      // Subcode 2534025 is a rate limit, even if someone mistakenly put "4:2534025" in allowlist
      expect(
        classifyPrivateGateFailure(
          graphMetadata({ graphCode: 4, graphSubcode: 2534025 }),
          new Set(["4:2534025"]),
        ),
      ).toBe("rate_limited");
    });
  });

  describe("classifyPublicReplyFailure", () => {
    it.each([
      [graphMetadata({ httpStatus: 429 }), "safe_retry"],
      [graphMetadata({ graphCode: 4 }), "safe_retry"],
      [graphMetadata({ graphCode: 17 }), "safe_retry"],
      [graphMetadata({ graphCode: 10, graphSubcode: 200 }), "open_circuit"],
      [graphMetadata({ graphCode: 190 }), "open_circuit"],
      [graphMetadata({ graphCode: 100 }), "permanent"],
      [graphMetadata({ httpStatus: 404 }), "permanent"],
      [graphMetadata({ category: "graph_transport", httpStatus: null }), "uncertain"],
      [graphMetadata({ httpStatus: 500 }), "uncertain"],
    ])("classifies public reply failures", (metadata, expected) => {
      expect(classifyPublicReplyFailure(metadata)).toBe(expected);
    });
  });
});
