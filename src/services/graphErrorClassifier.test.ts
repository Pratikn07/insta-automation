import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { describeGraphError, type GraphErrorMetadata } from "./eventLogger.js";
import {
  classifyPrivateGateFailure,
  classifyPublicReplyFailure,
  classifySourceReadFailure,
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

    // The classifier is a pure function of the allowlist it is handed, so it
    // WILL honour this pair. That is exactly why the pair must never reach it:
    // 100:2534025 is the invalid-comment family, not a settings rejection, and
    // it is 1,347 of the 1,356 dm_failed events in production history.
    //
    // The refusal therefore lives at the config boundary — see
    // `refuses the invalid-comment signature` in src/config/env.test.ts. This
    // case documents the mechanism, not a supported configuration.
    it("would honour 100:2534025 if configured, which is why env refuses it", () => {
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

// QA-09. The worker read the source comment with `.catch(() => null)`, so EVERY read
// failure became "the comment is gone" — terminal. A timeout, a 429, a Meta 5xx, an
// expired token, or a permission regression permanently suppressed candidates whose
// comments were fine, and each one was counted as a deletion.
//
// The property under test is asymmetric on purpose: a wrong `deferred` costs one tick,
// a wrong `missing` costs the candidate forever. So everything unrecognised must defer.
describe("classifySourceReadFailure", () => {
  // Meta answered, and the answer was that the object is not there.
  it.each([
    ["code 803, object does not exist", { graphCode: 803 }],
    ["code 100 subcode 33, unresolvable id", { graphCode: 100, graphSubcode: 33 }],
    ["HTTP 404", { httpStatus: 404 }],
  ])("treats %s as missing", (_label, overrides) => {
    expect(classifySourceReadFailure(graphMetadata(overrides))).toBe("missing");
  });

  // Credentials or permissions. Suppressing here would burn the whole remaining pool
  // on one expired token, so it is reported separately and opens the circuit.
  it.each([
    ["HTTP 401", { httpStatus: 401 }],
    ["HTTP 403", { httpStatus: 403 }],
    ["code 190, invalid token", { graphCode: 190 }],
    ["code 10, permission denied", { graphCode: 10 }],
    ["code 200, insufficient permission", { graphCode: 200 }],
  ])("treats %s as auth", (_label, overrides) => {
    expect(classifySourceReadFailure(graphMetadata(overrides))).toBe("auth");
  });

  // Everything that says nothing about whether the comment exists.
  it.each([
    ["HTTP 429", { httpStatus: 429 }],
    ["code 4, application rate limit", { graphCode: 4 }],
    ["code 613, calls-per-hour limit", { graphCode: 613 }],
    ["HTTP 500", { httpStatus: 500 }],
    ["HTTP 503", { httpStatus: 503 }],
    ["an empty response with no signature", {}],
  ])("defers on %s", (_label, overrides) => {
    expect(classifySourceReadFailure(graphMetadata(overrides))).toBe("deferred");
  });

  // A timeout produces no response at all, which is exactly the case the old
  // `.catch(() => null)` mislabelled as a deletion.
  it("defers on a transport failure such as a timeout", () => {
    expect(classifySourceReadFailure(transportMetadata("ETIMEDOUT"))).toBe("deferred");
    expect(classifySourceReadFailure(transportMetadata("ECONNRESET"))).toBe("deferred");
    expect(classifySourceReadFailure(transportMetadata(null))).toBe("deferred");
  });

  // Bare code 100 also covers "older than seven days" and "already replied to" on the
  // private-reply path, so on its own it is not proof the object is gone.
  it("does not treat a bare code 100 as missing", () => {
    expect(classifySourceReadFailure(graphMetadata({ graphCode: 100 }))).toBe("deferred");
  });

  // An expired token can 400 on some endpoints. Auth is checked first so that does not
  // read as a deletion.
  it("prefers auth over missing when both signatures are present", () => {
    expect(
      classifySourceReadFailure(graphMetadata({ httpStatus: 404, graphCode: 190 })),
    ).toBe("auth");
  });

  // A transport failure carries no HTTP status, so a `missing` signature can only come
  // from a real response. Pinned so a future edit cannot let a dropped connection
  // suppress a candidate.
  it("never reports missing without a response from Meta", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", null]) {
      expect(classifySourceReadFailure(transportMetadata(code))).not.toBe("missing");
    }
  });
});
