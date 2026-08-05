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
  // Meta answered, so the message was NOT delivered — retrying is safe.
  it.each([400, 401, 403, 429, 500, 502])("treats an HTTP %i response as a definite failure", (status) => {
    expect(classifySendError(graphResponse(status))).toEqual({
      outcome: "failed",
      errorCode: `graph_${status}`,
    });
  });

  // No response: the message may already be in someone's inbox. Never retry blind.
  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"])(
    "treats %s with no response as uncertain",
    (code) => {
      expect(classifySendError(noResponse(code))).toEqual({
        outcome: "uncertain",
        errorCode: code,
      });
    },
  );

  it("falls back to no_response when Axios gives no code", () => {
    const err = new AxiosError("socket hang up");
    err.response = undefined;
    expect(classifySendError(err)).toEqual({ outcome: "uncertain", errorCode: "no_response" });
  });

  it("treats a non-Axios throw as a definite failure", () => {
    // A bug in our own send path never reached Instagram.
    expect(classifySendError(new TypeError("undefined is not a function"))).toEqual({
      outcome: "failed",
      errorCode: "send_error",
    });
  });

  it("never reports uncertain for an error carrying a status", () => {
    // The costly mistake would be marking a definite rejection as uncertain and
    // making the owner check Instagram for a message that was never sent.
    for (const status of [400, 404, 429, 503]) {
      expect(classifySendError(graphResponse(status)).outcome).toBe("failed");
    }
  });
});
