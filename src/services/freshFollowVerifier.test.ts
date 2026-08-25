import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findUnique = vi.fn();
const graphGet = vi.fn();
const warn = vi.fn();
// Captured, not anonymous: a credential failure is logged at error level, so the
// no-leak assertions have to see error calls or they prove nothing.
const error = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { igUser: { upsert, findUnique } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { error, warn, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../meta/graphClient.js", () => ({ graph: { get: graphGet } }));

const {
  FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES,
  resolveFollowStatusFresh,
} = await import("./freshFollowVerifier.js");

const IG_USER_ID = "ig-user-1";

function safeObservedOutput(result: unknown): string {
  return JSON.stringify({ result, logs: [...warn.mock.calls, ...error.mock.calls] });
}

beforeEach(() => {
  for (const fn of [upsert, findUnique, graphGet, warn, error]) fn.mockReset();
  upsert.mockResolvedValue(undefined);
  // A cached value is deliberately available to the mocked database, but the
  // authorization verifier must never read it as a fallback.
  findUnique.mockResolvedValue({ id: IG_USER_ID, isFollower: true });
});

describe("resolveFollowStatusFresh", () => {
  it("returns live true only after reading Meta and persisting that same observation", async () => {
    graphGet.mockResolvedValue({ data: { is_user_follow_business: true } });

    const result = await resolveFollowStatusFresh(IG_USER_ID);

    expect(result).toEqual({
      source: "meta_live",
      isFollower: true,
      checkedAt: expect.any(Date),
    });
    expect(graphGet).toHaveBeenCalledWith(`/${IG_USER_ID}`, {
      params: { fields: "is_user_follow_business" },
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { id: IG_USER_ID },
      create: {
        id: IG_USER_ID,
        isFollower: true,
        followCheckedAt: result.checkedAt,
      },
      update: {
        isFollower: true,
        followCheckedAt: result.checkedAt,
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns live false only after reading Meta and persisting that same observation", async () => {
    graphGet.mockResolvedValue({ data: { is_user_follow_business: false } });

    const result = await resolveFollowStatusFresh(IG_USER_ID);

    expect(result).toEqual({
      source: "meta_live",
      isFollower: false,
      checkedAt: expect.any(Date),
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ isFollower: false }),
      }),
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("fails closed when Meta omits the follow Boolean", async () => {
    graphGet.mockResolvedValue({ data: {} });

    const result = await resolveFollowStatusFresh(IG_USER_ID);

    expect(result).toMatchObject({
      source: "unavailable",
      isFollower: null,
      errorCode: "fresh_follow_invalid_response",
    });
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(upsert).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a consent error", "fresh_follow_read_failed", () => Promise.reject({ response: { status: 400 }, config: { params: { access_token: "meta-token-secret" } } })],
    ["a transport error", "fresh_follow_read_failed", () => Promise.reject({ code: "ECONNRESET", config: { headers: { Authorization: "Bearer meta-token-secret" } } })],
    ["a malformed follow response", "fresh_follow_invalid_response", () => Promise.resolve({ data: { is_user_follow_business: "true" } })],
    ["a cache-write failure", "fresh_follow_cache_write_failed", () => {
      upsert.mockRejectedValue({ message: "write-secret", config: { params: { access_token: "meta-token-secret" } } });
      return Promise.resolve({ data: { is_user_follow_business: true } });
    }],
  ])("fails closed for %s without exposing raw provider details", async (_failure, errorCode, arrange) => {
    graphGet.mockImplementation(arrange);

    const result = await resolveFollowStatusFresh(IG_USER_ID);

    expect(result).toMatchObject({ source: "unavailable", isFollower: null, errorCode });
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES).toContain(result.errorCode);
    expect(findUnique).not.toHaveBeenCalled();
    expect(safeObservedOutput(result)).not.toContain("meta-token-secret");
    expect(safeObservedOutput(result)).not.toContain("write-secret");
  });

  // A dead access token and a flaky Instagram both used to surface as the single code
  // `fresh_follow_read_failed`. They demand opposite responses: one is an operator
  // emergency affecting EVERY parent at once, the other is noise that resolves itself.
  // Telling them apart is what makes a mass credential failure visible in minutes
  // instead of whenever somebody notices the review queue filling up. The routing is
  // deliberately unchanged -- both still fail closed to `unavailable`.
  describe("credential failures", () => {
    // A real AxiosError, because describeGraphError only inspects err via axios's
    // isAxiosError guard — a plain object would slip through as graphCode: null and
    // give a false green. This mirrors how the Graph client actually rejects.
    function graphError(code: number, message = "graph failure"): AxiosError {
      const config = { params: { access_token: "meta-token-secret" }, headers: new AxiosHeaders() };
      return new AxiosError(message, "ERR_BAD_REQUEST", config as never, undefined, {
        status: 400,
        statusText: "Bad Request",
        headers: new AxiosHeaders(),
        config: config as never,
        data: { error: { code, message } },
      });
    }

    const authFailure = graphError(
      190,
      "Error validating access token: the session has been invalidated",
    );

    it("names a Graph code 190 as a credential failure, not a generic read failure", async () => {
      graphGet.mockRejectedValue(authFailure);

      const result = await resolveFollowStatusFresh(IG_USER_ID);

      expect(result).toMatchObject({
        source: "unavailable",
        isFollower: null,
        errorCode: "fresh_follow_auth_failed",
      });
      expect(FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES).toContain(result.errorCode);
    });

    // Same allowlist-only discipline as every other boundary here: the config of a
    // rejected Graph call carries the access token, and the message can carry account
    // detail. Neither may reach a log.
    it("reports a credential failure without exposing the token or provider prose", async () => {
      graphGet.mockRejectedValue(authFailure);

      const result = await resolveFollowStatusFresh(IG_USER_ID);

      const observed = safeObservedOutput(result);
      expect(observed).not.toContain("meta-token-secret");
      expect(observed).not.toContain("the session has been invalidated");
    });

    it("leaves a non-credential Graph error as a generic read failure", async () => {
      graphGet.mockRejectedValue(graphError(100, "unsupported metric"));

      const result = await resolveFollowStatusFresh(IG_USER_ID);

      expect(result).toMatchObject({ errorCode: "fresh_follow_read_failed" });
    });

    it("leaves a transport error with no provider code as a generic read failure", async () => {
      graphGet.mockRejectedValue(new AxiosError("socket hang up", "ECONNRESET"));

      const result = await resolveFollowStatusFresh(IG_USER_ID);

      expect(result).toMatchObject({ errorCode: "fresh_follow_read_failed" });
    });
  });

  it.each([true, false])(
    "does not authorize from a cached %s when every live-check failure occurs",
    async (cachedIsFollower) => {
      const failures = [
        () => graphGet.mockRejectedValueOnce({ config: { params: { access_token: "meta-token-secret" } } }),
        () => graphGet.mockRejectedValueOnce({ response: { status: 400 }, config: { params: { access_token: "meta-token-secret" } } }),
        () => graphGet.mockResolvedValueOnce({ data: {} }),
        () => graphGet.mockResolvedValueOnce({ data: { is_user_follow_business: "true" } }),
        () => {
          upsert.mockRejectedValueOnce(new Error("write failed"));
          graphGet.mockResolvedValueOnce({ data: { is_user_follow_business: true } });
        },
      ];

      findUnique.mockResolvedValue({ id: IG_USER_ID, isFollower: cachedIsFollower });

      for (const arrange of failures) {
        arrange();
        const result = await resolveFollowStatusFresh(IG_USER_ID);
        expect(result).toMatchObject({ source: "unavailable", isFollower: null });
        expect(FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES).toContain(result.errorCode);
      }

      expect(findUnique).not.toHaveBeenCalled();
    },
  );
});
