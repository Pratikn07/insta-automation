import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawUnsafe = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { $queryRawUnsafe: queryRawUnsafe },
}));

const { funnelsRouter, funnelCache } = await import("./funnels.routes.js");

function makeApp() {
  const app = express();
  app.use("/api/funnels", funnelsRouter);
  return app;
}

beforeEach(() => {
  queryRawUnsafe.mockReset().mockResolvedValue([]);
  // The route cache is module state, so without this a test's query-count
  // assertion would depend on which earlier test warmed which window.
  funnelCache.invalidate();
});

describe("GET /api/funnels", () => {
  it("lists the registry so the client never hardcodes the funnel list", async () => {
    const res = await request(makeApp()).get("/api/funnels");
    expect(res.status).toBe(200);
    expect(res.body.items).toContainEqual(
      expect.objectContaining({ key: "guide-follow", name: "Guide → follow" }),
    );
  });
});

describe("GET /api/funnels/:key", () => {
  it("returns a funnel over the default window", async () => {
    const res = await request(makeApp()).get("/api/funnels/guide-follow");
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("guide-follow");
    expect(res.body.stages).toHaveLength(6);
    expect(res.body.headline.label).toBe("Reply rate");
    expect(queryRawUnsafe).toHaveBeenCalledOnce();
  });

  it("404s an unknown funnel rather than silently returning an empty one", async () => {
    const res = await request(makeApp()).get("/api/funnels/not-a-funnel");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_funnel");
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("passes the requested window through as cohort bounds", async () => {
    const res = await request(makeApp())
      .get("/api/funnels/guide-follow")
      .query({ from: "2026-07-01", to: "2026-08-01" });
    expect(res.status).toBe(200);
    expect(res.body.window.from).toBe("2026-07-01T00:00:00.000Z");
    expect(res.body.window.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects a malformed date instead of silently defaulting the window", async () => {
    // Silently falling back would show a 30-day funnel under a label claiming
    // some other range — the exact class of unstated-denominator bug this
    // whole layer exists to avoid.
    const res = await request(makeApp()).get("/api/funnels/guide-follow").query({ from: "last-week" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_window");
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("rejects an inverted window", async () => {
    const res = await request(makeApp())
      .get("/api/funnels/guide-follow")
      .query({ from: "2026-08-01", to: "2026-07-01" });
    expect(res.status).toBe(400);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("caps the window so one page load cannot scan years of event_log", async () => {
    const res = await request(makeApp())
      .get("/api/funnels/guide-follow")
      .query({ from: "2020-01-01", to: "2026-08-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("window_too_wide");
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("GET /api/funnels/:key caching", () => {
  it("serves a repeat read of the same window without re-running the cohort query", async () => {
    const app = makeApp();
    const window = { from: "2026-07-01", to: "2026-08-01" };
    const first = await request(app).get("/api/funnels/guide-follow").query(window);
    const second = await request(app).get("/api/funnels/guide-follow").query(window);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(queryRawUnsafe).toHaveBeenCalledOnce();
  });

  /**
   * The regression this guards is subtle and was live for a moment: defaultWindow()
   * is `now`-relative to the millisecond, so keying the cache on the raw bounds
   * missed on every request — leaving the one path Home actually loads uncached.
   */
  it("caches the default window, which is the path Home loads", async () => {
    const app = makeApp();
    await request(app).get("/api/funnels/guide-follow");
    await request(app).get("/api/funnels/guide-follow");

    expect(queryRawUnsafe).toHaveBeenCalledOnce();
  });

  it("never serves one window's numbers under another window's label", async () => {
    const app = makeApp();
    await request(app).get("/api/funnels/guide-follow").query({ from: "2026-07-01", to: "2026-08-01" });
    const other = await request(app)
      .get("/api/funnels/guide-follow")
      .query({ from: "2026-06-01", to: "2026-07-01" });

    expect(other.body.window.from).toBe("2026-06-01T00:00:00.000Z");
    expect(other.body.window.to).toBe("2026-07-01T00:00:00.000Z");
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("retries rather than caching a failed cohort query", async () => {
    const app = makeApp();
    queryRawUnsafe.mockRejectedValueOnce(new Error("db unavailable"));

    await request(app).get("/api/funnels/guide-follow");

    queryRawUnsafe.mockResolvedValue([]);
    const recovered = await request(app).get("/api/funnels/guide-follow");

    expect(recovered.status).toBe(200);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
