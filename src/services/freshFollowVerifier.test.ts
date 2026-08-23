import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findUnique = vi.fn();
const graphGet = vi.fn();
const warn = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { igUser: { upsert, findUnique } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../meta/graphClient.js", () => ({ graph: { get: graphGet } }));

const {
  FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES,
  resolveFollowStatusFresh,
} = await import("./freshFollowVerifier.js");

const IG_USER_ID = "ig-user-1";

function safeObservedOutput(result: unknown): string {
  return JSON.stringify({ result, logs: warn.mock.calls });
}

beforeEach(() => {
  for (const fn of [upsert, findUnique, graphGet, warn]) fn.mockReset();
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
