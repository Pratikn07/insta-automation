import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { describeGraphError, type GraphErrorMetadata } from "./eventLogger.js";
import {
  classifyPrivateGateFailure,
  classifyPublicReplyFailure,
  parseGraphSignatures,
} from "./graphErrorClassifier.js";

// No defaults that can silently satisfy an assertion: every field is explicit
// unless the case overrides it. The previous helper defaulted httpStatus to
// 400, so most cases rode the "400 -> permanent" fallthrough rather than the
// branch they claimed to test.
function graphMetadata(overrides: Partial<GraphErrorMetadata> = {}): GraphErrorMetadata {
  return {
    category: "graph_response",
    httpStatus: null,
    graphCode: null,
    graphSubcode: null,
    traceId: "trace-123",
    transportCode: null,
    ...overrides,
  };
}

// A response-less failure always has httpStatus null — describeGraphError only
// sets category "graph_transport" when there is no response at all. Building
// it through a factory keeps impossible states (503 + graph_transport) out of
// the suite.
function transportMetadata(transportCode: string | null): GraphErrorMetadata {
  return graphMetadata({ category: "graph_transport", transportCode });
}

// ── End-to-end fixtures: real axios errors, parsed by the real parser ──────

function graphResponseError(status: number, code: number, subcode?: number): AxiosError {
  const config = { headers: new AxiosHeaders() } as never;
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", config, {}, {
    status,
    statusText: "",
    headers: {},
    config,
    data: { error: { code, error_subcode: subcode, fbtrace_id: "Abc123" } },
  } as never);
}

function transportError(code: string): AxiosError {
  return new AxiosError("network", code, { headers: new AxiosHeaders() } as never, {});
}

describe("graphErrorClassifier", () => {
  describe("parseGraphSignatures", () => {
    it("parses valid code:subcode strings and de-duplicates", () => {
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
      // Rate limits are matched by error code, never by a bare subcode.
      [graphMetadata({ httpStatus: 429 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 400, graphCode: 4 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 400, graphCode: 17 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 400, graphCode: 32 }), [], "rate_limited"],
      [graphMetadata({ httpStatus: 400, graphCode: 613 }), [], "rate_limited"],
      // Allowlisted settings signature.
      [graphMetadata({ httpStatus: 400, graphCode: 10, graphSubcode: 12345 }), ["10:12345"], "settings_blocked"],
      // Same code, unlisted subcode: never settings_blocked.
      [graphMetadata({ httpStatus: 400, graphCode: 10, graphSubcode: 99999 }), ["10:12345"], "permission_or_auth"],
      [graphMetadata({ httpStatus: 401 }), [], "permission_or_auth"],
      [graphMetadata({ httpStatus: 403 }), [], "permission_or_auth"],
      [graphMetadata({ httpStatus: 503 }), [], "retryable_transport"],
      [graphMetadata({ httpStatus: 502 }), [], "retryable_transport"],
      [graphMetadata({ httpStatus: 400 }), [], "permanent"],
      [graphMetadata({ httpStatus: 404 }), [], "permanent"],
      [graphMetadata({ httpStatus: 500 }), [], "uncertain"],
    ])("classifies %#", (metadata, allowlist, expected) => {
      expect(classifyPrivateGateFailure(metadata, new Set(allowlist))).toBe(expected);
    });

    it("never classifies a bare 400 without an allowlisted signature as settings_blocked", () => {
      expect(classifyPrivateGateFailure(graphMetadata({ httpStatus: 400 }), new Set())).not.toBe(
        "settings_blocked",
      );
    });

    it("lets a rate-limit code win over a misconfigured settings allowlist", () => {
      // Guards the plan's requirement that a bad allowlist cannot turn a rate
      // limit into a public comment.
      expect(
        classifyPrivateGateFailure(
          graphMetadata({ httpStatus: 400, graphCode: 4, graphSubcode: 12345 }),
          new Set(["4:12345"]),
        ),
      ).toBe("rate_limited");
    });

    // Subcode 2534025 belongs to error code 100 ("the comment is invalid for a
    // private reply"), not to any rate limit. Matching it as a bare subcode
    // made the settings path unreachable and retried a permanent failure.
    it("treats code 100 / subcode 2534025 as permanent, not rate limited", () => {
      expect(
        classifyPrivateGateFailure(
          graphMetadata({ httpStatus: 400, graphCode: 100, graphSubcode: 2534025 }),
          new Set(),
        ),
      ).toBe("permanent");
    });

    it("lets an operator allowlist 100:2534025 through to settings_blocked", () => {
      expect(
        classifyPrivateGateFailure(
          graphMetadata({ httpStatus: 400, graphCode: 100, graphSubcode: 2534025 }),
          new Set(["100:2534025"]),
        ),
      ).toBe("settings_blocked");
    });

    // A response-less failure may or may not have reached Meta. Retrying an
    // ambiguous one can deliver the gate DM twice, so only provably
    // undelivered transports are retryable.
    it.each([
      ["ECONNREFUSED", "retryable_transport"],
      ["ENOTFOUND", "retryable_transport"],
      ["EAI_AGAIN", "retryable_transport"],
      ["ECONNABORTED", "transport_uncertain"],
      ["ETIMEDOUT", "transport_uncertain"],
      ["ECONNRESET", "transport_uncertain"],
    ])("classifies transport failure %s", (code, expected) => {
      expect(classifyPrivateGateFailure(transportMetadata(code), new Set())).toBe(expected);
    });

    it("defaults an unrecognised transport failure to transport_uncertain", () => {
      expect(classifyPrivateGateFailure(transportMetadata(null), new Set())).toBe(
        "transport_uncertain",
      );
    });
  });

  describe("classifyPublicReplyFailure", () => {
    it.each([
      [graphMetadata({ httpStatus: 429 }), "safe_retry"],
      [graphMetadata({ httpStatus: 400, graphCode: 4 }), "safe_retry"],
      [graphMetadata({ httpStatus: 400, graphCode: 17 }), "safe_retry"],
      [graphMetadata({ httpStatus: 403, graphCode: 10 }), "open_circuit"],
      [graphMetadata({ httpStatus: 401, graphCode: 190 }), "open_circuit"],
      [graphMetadata({ httpStatus: 400, graphCode: 100 }), "permanent"],
      [graphMetadata({ httpStatus: 404 }), "permanent"],
      [graphMetadata({ httpStatus: 500 }), "uncertain"],
      [transportMetadata("ETIMEDOUT"), "uncertain"],
      [transportMetadata("ECONNREFUSED"), "uncertain"],
    ])("classifies %#", (metadata, expected) => {
      expect(classifyPublicReplyFailure(metadata)).toBe(expected);
    });
  });

  // The unit cases above use synthetic metadata. These prove the same verdicts
  // survive the real parser, which is where the previous suite's impossible
  // fixtures hid the defects.
  describe("end to end through describeGraphError", () => {
    it.each([
      ["comment invalid for private reply", graphResponseError(400, 100, 2534025), "permanent"],
      ["app rate limit", graphResponseError(400, 4), "rate_limited"],
      ["outside allowed window", graphResponseError(400, 10, 2534022), "permission_or_auth"],
      ["socket timeout after send", transportError("ECONNABORTED"), "transport_uncertain"],
      ["connection refused", transportError("ECONNREFUSED"), "retryable_transport"],
    ])("classifies a real %s", (_label, error, expected) => {
      expect(classifyPrivateGateFailure(describeGraphError(error), new Set())).toBe(expected);
    });

    it("distinguishes an ambiguous timeout from a refused connection", () => {
      const timedOut = classifyPrivateGateFailure(
        describeGraphError(transportError("ETIMEDOUT")),
        new Set(),
      );
      const refused = classifyPrivateGateFailure(
        describeGraphError(transportError("ECONNREFUSED")),
        new Set(),
      );
      expect(timedOut).not.toBe(refused);
    });
  });
});
