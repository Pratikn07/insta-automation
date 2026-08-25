import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, create, eventLogFindFirst, loggerWarn, loggerError, envMock } = vi.hoisted(
  () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
    eventLogFindFirst: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    envMock: { IG_ACCESS_TOKEN: "ENV-SEED-LONG-DEAD" as string | undefined },
  }),
);

vi.mock("../lib/prisma.js", () => ({
  prisma: { igToken: { findUnique, create }, eventLog: { findFirst: eventLogFindFirst } },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: loggerWarn, error: loggerError, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({ env: envMock }));

const { resolveAccessToken, getAccessToken, seedTokenFromEnv, readTokenHealth, __resetTokenCache } =
  await import("./tokenStore.js");

const LIVE_ROW = {
  accessToken: "DB-LIVE-TOKEN",
  expiresAt: new Date("2026-10-23T12:16:03.008Z"),
  refreshedAt: new Date("2026-08-24T12:16:03.008Z"),
};

describe("resolveAccessToken", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
    envMock.IG_ACCESS_TOKEN = "ENV-SEED-LONG-DEAD";
    __resetTokenCache();
  });

  // The regression this exists for. A one-off script's very first Graph call used to
  // authenticate with env.IG_ACCESS_TOKEN, because the cache warm was fire-and-forget.
  // On any machine whose .env holds an older seed -- the normal case, since the live
  // token lives in ig_token and rotates itself -- that first call fails with code 190.
  // In the guide-access flow a failed follow read becomes `follow_check_unavailable`,
  // which parks the parent in needs_review after their action token was already
  // consumed, so a retry dedupes and the parent is unrecoverable.
  it("waits for the token table on a cold cache instead of serving the env seed", async () => {
    findUnique.mockResolvedValue(LIVE_ROW);

    await expect(resolveAccessToken()).resolves.toBe("DB-LIVE-TOKEN");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("serves a warm cache without re-reading the table", async () => {
    findUnique.mockResolvedValue(LIVE_ROW);

    await resolveAccessToken();
    await expect(resolveAccessToken()).resolves.toBe("DB-LIVE-TOKEN");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  // Resilience is deliberate and must survive the fix: a server that cannot read its
  // own token table still has to serve Instagram traffic. What changes is that the
  // fallback is no longer silent.
  it("falls back to the env seed when the table is unreachable, and says so", async () => {
    findUnique.mockRejectedValue(new Error("token table unreachable"));

    await expect(resolveAccessToken()).resolves.toBe("ENV-SEED-LONG-DEAD");
    expect(loggerWarn).toHaveBeenCalledWith(
      { errorCode: "ig_token_seed_fallback_served" },
      expect.stringContaining("env seed"),
    );
  });

  it("falls back to the env seed when no row exists yet, and says so", async () => {
    findUnique.mockResolvedValue(null);

    await expect(resolveAccessToken()).resolves.toBe("ENV-SEED-LONG-DEAD");
    expect(loggerWarn).toHaveBeenCalledWith(
      { errorCode: "ig_token_seed_fallback_served" },
      expect.stringContaining("env seed"),
    );
  });

  it("collapses concurrent cold reads into a single table read", async () => {
    findUnique.mockResolvedValue(LIVE_ROW);

    const [a, b, c] = await Promise.all([
      resolveAccessToken(),
      resolveAccessToken(),
      resolveAccessToken(),
    ]);

    expect([a, b, c]).toEqual(["DB-LIVE-TOKEN", "DB-LIVE-TOKEN", "DB-LIVE-TOKEN"]);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("getAccessToken", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    loggerWarn.mockReset();
    envMock.IG_ACCESS_TOKEN = "ENV-SEED-LONG-DEAD";
    __resetTokenCache();
  });

  // Kept synchronous on purpose: it is the hot read for a warm process. It is NOT safe
  // for a short-lived script, which is why the Graph interceptors use the awaited form.
  it("returns the cached token once warm", async () => {
    findUnique.mockResolvedValue(LIVE_ROW);
    await resolveAccessToken();

    expect(getAccessToken()).toBe("DB-LIVE-TOKEN");
  });

  it("throws instead of returning nothing when the cache is cold and no seed is set", () => {
    envMock.IG_ACCESS_TOKEN = undefined;
    findUnique.mockResolvedValue(LIVE_ROW);

    expect(() => getAccessToken()).toThrow(/no instagram access token/i);
  });
});

// IG_ACCESS_TOKEN is optional: the live token lives in ig_token and rotates itself, so a
// local checkout should not need to keep a copy. Production still sets it in Railway as the
// documented rescue path for a token that has actually died.
describe("with no env seed configured", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
    envMock.IG_ACCESS_TOKEN = undefined;
    __resetTokenCache();
  });

  it("still serves the db token", async () => {
    findUnique.mockResolvedValue(LIVE_ROW);

    await expect(resolveAccessToken()).resolves.toBe("DB-LIVE-TOKEN");
  });

  // Better a loud throw than `access_token=undefined`, which Meta answers with a generic
  // 400 that reads like a malformed request rather than "this deploy has no credentials".
  it("throws rather than authenticating with nothing", async () => {
    findUnique.mockResolvedValue(null);

    await expect(resolveAccessToken()).rejects.toThrow(/no instagram access token/i);
  });

  it("does not try to seed a missing row from an absent seed", async () => {
    findUnique.mockResolvedValue(null);

    await seedTokenFromEnv();

    expect(create).not.toHaveBeenCalled();
  });
});

describe("readTokenHealth", () => {
  // now is well inside LIVE_ROW's runway (expires 2026-10-23), so expiry-based health
  // is "healthy" and any red state must come from the invalidation signal.
  const NOW = Date.parse("2026-08-25T00:00:00.000Z");

  beforeEach(() => {
    findUnique.mockReset();
    eventLogFindFirst.mockReset();
    __resetTokenCache();
    findUnique.mockResolvedValue(LIVE_ROW);
  });

  it("reports expiry-based health when no invalidation has been recorded", async () => {
    eventLogFindFirst.mockResolvedValue(null);

    const health = await readTokenHealth(NOW);

    expect(health?.status).toBe("healthy");
  });

  // The whole point: a token killed early reads red even though expires_at is far off.
  it("reports red when an invalidation is newer than the last good mint", async () => {
    eventLogFindFirst.mockResolvedValue({
      createdAt: new Date("2026-08-24T18:00:00.000Z"), // after refreshedAt 12:16
    });

    const health = await readTokenHealth(NOW);

    expect(health?.status).toBe("expired");
  });

  // A re-mint advances refreshedAt past the old invalidation, so a resolved incident
  // must not keep the dashboard red forever.
  it("clears back to expiry-based health once the token is re-minted", async () => {
    eventLogFindFirst.mockResolvedValue({
      createdAt: new Date("2026-08-24T06:00:00.000Z"), // before refreshedAt 12:16
    });

    const health = await readTokenHealth(NOW);

    expect(health?.status).toBe("healthy");
  });

  it("returns null when there is no token row at all", async () => {
    findUnique.mockResolvedValue(null);

    await expect(readTokenHealth(NOW)).resolves.toBeNull();
  });
});
