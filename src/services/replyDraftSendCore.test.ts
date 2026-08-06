import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { classifySendError } from "./replyDraftSendCore.js";

function graphResponse(status: number): AxiosError {
  const err = new AxiosError("Request failed", "ERR_BAD_REQUEST");
  err.response = {
    status,
    statusText: "",
    data: { error: { code: 100, message: "bad request" } },
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function noResponse(code: string): AxiosError {
  const err = new AxiosError("timeout of 10000ms exceeded", code);
  err.response = undefined;
  return err;
}

describe("classifySendError", () => {
  // Deterministic client rejections mean the message was not delivered.
  it.each([400, 401, 403, 404, 409, 422, 429])(
    "treats an HTTP %i response as a definite failure",
    (status) => {
      expect(classifySendError(graphResponse(status))).toEqual({
        outcome: "failed",
        errorCode: "graph_rejected",
      });
    },
  );

  // A timeout/gateway/server response can arrive after Graph accepted the
  // message. Retrying those blindly can duplicate a real DM.
  it.each([
    [408, "graph_timeout"],
    [500, "graph_server_error"],
    [502, "graph_server_error"],
    [503, "graph_server_error"],
    [504, "graph_server_error"],
  ] as const)("treats an HTTP %i response as uncertain", (status, errorCode) => {
    expect(classifySendError(graphResponse(status))).toEqual({
      outcome: "uncertain",
      errorCode,
    });
  });

  it.each([301])("treats an unexpected HTTP %i response as uncertain", (status) => {
    expect(classifySendError(graphResponse(status))).toEqual({
      outcome: "uncertain",
      errorCode: "graph_response_uncertain",
    });
  });

  // No response: the message may already be in someone's inbox. Never retry blind.
  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"])(
    "treats %s with no response as uncertain",
    (code) => {
      expect(classifySendError(noResponse(code))).toEqual({
        outcome: "uncertain",
        errorCode:
          code === "ECONNABORTED" || code === "ETIMEDOUT"
            ? "transport_timeout"
            : code === "ECONNRESET"
              ? "transport_connection_reset"
              : "transport_dns_failure",
      });
    },
  );

  it("falls back to no_response when Axios gives no code", () => {
    const err = new AxiosError("socket hang up");
    err.response = undefined;
    expect(classifySendError(err)).toEqual({
      outcome: "uncertain",
      errorCode: "transport_error",
    });
  });

  it("maps an arbitrary secret-bearing Axios code to one generic safe code", () => {
    const err = noResponse("SECRET-owner@example.com-private-DM");
    expect(classifySendError(err)).toEqual({
      outcome: "uncertain",
      errorCode: "transport_error",
    });
  });

  it("treats a non-Axios throw after handoff as uncertain", () => {
    // At this boundary we cannot prove whether an unknown throw happened before
    // or after Graph accepted the request.
    expect(classifySendError(new TypeError("undefined is not a function"))).toEqual({
      outcome: "uncertain",
      errorCode: "send_outcome_unknown",
    });
  });

  it("only reports definite failure for deterministic 4xx responses", () => {
    expect(classifySendError(graphResponse(400)).outcome).toBe("failed");
    for (const status of [301, 408, 500, 502, 503, 504, 599]) {
      expect(classifySendError(graphResponse(status)).outcome).toBe("uncertain");
    }
  });
});
