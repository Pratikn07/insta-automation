import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createExperiment = vi.fn();

// Only the experiment create path is exercised here; the rest of the insights
// surface is read-only and covered by its own service tests.
vi.mock("../services/experimentService.js", () => ({
  createExperiment: (...a: unknown[]) => createExperiment(...a),
  listExperiments: vi.fn(),
  updateExperiment: vi.fn(),
  getUsReachTrend: vi.fn(),
  getGeoWindowTrend: vi.fn(),
}));

const getLeaderboard = vi.fn();
vi.mock("../services/insightsService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/insightsService.js")>()),
  getLeaderboard: (...a: unknown[]) => getLeaderboard(...a),
}));

const { insightsRouter, leaderboardCache } = await import("./insights.routes.js");

const EXPERIMENT_ID = "40000000-0000-4000-8000-000000000001";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/insights", insightsRouter);
  return app;
}

const body = {
  id: EXPERIMENT_ID,
  hypothesis: "Slower hooks reach more US viewers",
  variable: "hook pacing",
  reelMediaIds: ["reel-1"],
  postedAt: "2026-08-16T09:00:00+0000",
};

const experiment = { id: EXPERIMENT_ID, baselineUsPct: 41 };

beforeEach(() => {
  createExperiment.mockReset().mockResolvedValue({ status: "created", experiment });
  getLeaderboard.mockReset().mockResolvedValue([{ mediaId: "reel-1" }]);
  leaderboardCache.invalidate();
});

describe("GET /api/insights/leaderboard", () => {
  it("serves a repeat read from cache instead of rebuilding every reel's numbers", async () => {
    const app = makeApp();
    await request(app).get("/api/insights/leaderboard").expect(200);
    const again = await request(app).get("/api/insights/leaderboard").expect(200);

    expect(again.body).toEqual({ items: [{ mediaId: "reel-1" }] });
    expect(getLeaderboard).toHaveBeenCalledOnce();
  });
});

describe("manual experiment create replay", () => {
  it("reports 201 for a genuine create", async () => {
    const response = await request(makeApp())
      .post("/api/insights/experiments")
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({ id: EXPERIMENT_ID });
    expect(createExperiment).toHaveBeenCalledWith(expect.objectContaining({ id: EXPERIMENT_ID }));
  });

  it("reports 200 and the original experiment for a replay", async () => {
    createExperiment.mockResolvedValue({ status: "replayed", experiment });

    const response = await request(makeApp())
      .post("/api/insights/experiments")
      .send(body)
      .expect(200);

    expect(response.body).toMatchObject({ id: EXPERIMENT_ID, baselineUsPct: 41 });
  });

  it("reports 409 for the same UUID with a different intent", async () => {
    createExperiment.mockResolvedValue({ status: "conflict" });

    const response = await request(makeApp())
      .post("/api/insights/experiments")
      .send(body)
      .expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
  });

  it("requires the UUID", async () => {
    const { id: _id, ...withoutId } = body;

    await request(makeApp()).post("/api/insights/experiments").send(withoutId).expect(400);

    expect(createExperiment).not.toHaveBeenCalled();
  });

  it("rejects a mismatched header before reaching the service", async () => {
    const response = await request(makeApp())
      .post("/api/insights/experiments")
      .set("idempotency-key", "40000000-0000-4000-8000-000000000009")
      .send(body)
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(createExperiment).not.toHaveBeenCalled();
  });
});
