import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDashboardStats = vi.fn();

vi.mock("../services/statsService.js", () => ({ getDashboardStats }));
vi.mock("../lib/prisma.js", () => ({ prisma: { eventLog: { findMany: vi.fn() } } }));
vi.mock("../services/igUserService.js", () => ({ getIgUsers: vi.fn().mockResolvedValue({}) }));

const { statsRouter, statsCache } = await import("./stats.routes.js");

function makeApp() {
  const app = express();
  app.use("/api/stats", statsRouter);
  return app;
}

beforeEach(() => {
  getDashboardStats.mockReset().mockResolvedValue({ activeKeywords: 3 });
  statsCache.invalidate();
});

describe("GET /api/stats", () => {
  it("returns the dashboard stats", async () => {
    const res = await request(makeApp()).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeKeywords: 3 });
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  /**
   * Home mounts four panels that each read on mount, and this is the most
   * expensive read in the app: twelve queries against a CPU-bound instance,
   * competing for a five-connection pool.
   */
  it("serves a repeat read from cache instead of recomputing twelve queries", async () => {
    const app = makeApp();
    const first = await request(app).get("/api/stats");
    const second = await request(app).get("/api/stats");

    expect(second.body).toEqual(first.body);
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  /**
   * Three requests, one computation — whether the later two collapse onto the
   * in-flight promise or land on the resolved entry. Single-flight itself is
   * pinned deterministically in readThroughCache.test.ts; over real HTTP the
   * arrival order cannot be forced, so this asserts the property that matters.
   */
  it("collapses simultaneous reads onto one computation", async () => {
    const app = makeApp();
    let release!: (v: unknown) => void;
    const started = new Promise<void>((loaderCalled) => {
      getDashboardStats.mockImplementation(() => {
        loaderCalled();
        return new Promise((r) => (release = r));
      });
    });

    const inflight = Promise.all([
      request(app).get("/api/stats"),
      request(app).get("/api/stats"),
      request(app).get("/api/stats"),
    ]);

    await started;
    release({ activeKeywords: 3 });

    const results = await inflight;
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  it("retries after a failure rather than serving the error for the whole TTL", async () => {
    const app = makeApp();
    getDashboardStats.mockRejectedValueOnce(new Error("db unavailable"));

    await request(app).get("/api/stats");
    const recovered = await request(app).get("/api/stats");

    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual({ activeKeywords: 3 });
    expect(getDashboardStats).toHaveBeenCalledTimes(2);
  });
});
