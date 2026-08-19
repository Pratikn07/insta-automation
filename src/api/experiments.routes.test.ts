import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const summarize = vi.fn();
const snapshot = vi.fn();

vi.mock("../services/experimentSummary.js", () => ({
  summarizeExperiment: (key: string) => summarize(key),
}));
vi.mock("../services/flagService.js", () => ({
  flags: { snapshot: () => snapshot() },
}));

const { experimentsRouter } = await import("./experiments.routes.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/experiments", experimentsRouter);
  return a;
}

const NOT_STARTED = {
  kind: "not_started",
  wouldCompare: "the new path versus the old one",
  blocker: "The rollout is at zero.",
};

const RUNNING = {
  kind: "running",
  arms: [
    { key: "treatment", label: "Got a reminder", people: 594 },
    { key: "control", label: "Got nothing", people: 395 },
  ],
  notCounted: [{ reason: "They opened it themselves", people: 531 }],
  endsAt: "2026-08-21T21:45:00.000Z",
  whenItEnds: "When the window closes, reminders stop and wait for your decision.",
};

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockReturnValue([]);
  summarize.mockImplementation((key: string) =>
    Promise.resolve(key === "recovery-reminder-timing" ? RUNNING : NOT_STARTED),
  );
});

describe("experiments API", () => {
  it("lists all three with their state", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    expect(response.body.experiments).toHaveLength(3);
    const recovery = response.body.experiments.find(
      (e: { key: string }) => e.key === "recovery-reminder-timing",
    );
    expect(recovery).toMatchObject({ name: "Recovery reminder timing", state: "running" });
  });

  /**
   * The list carries the one number that matters, so a row can read
   * "594 v 395 · ends in 2 days" without a second request.
   *
   * This costs exactly one query, not three: a not-started summary is computed from
   * the registry alone and touches no table — asserted in experimentSummary.test.ts.
   */
  it("gives the running experiment its arm counts", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    const recovery = response.body.experiments.find(
      (e: { key: string }) => e.key === "recovery-reminder-timing",
    );
    expect(recovery.summary).toMatchObject({
      kind: "running",
      arms: [
        { key: "treatment", label: "Got a reminder", people: 594 },
        { key: "control", label: "Got nothing", people: 395 },
      ],
      endsAt: "2026-08-21T21:45:00.000Z",
    });
  });

  // A zero on this line would read as "we tried and nobody converted".
  it("gives a not-started experiment its blocker and no counts at all", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    const cold = response.body.experiments.find(
      (e: { key: string }) => e.key === "cold-message-test",
    );
    expect(cold.summary).toEqual(NOT_STARTED);
    expect(cold.summary.arms).toBeUndefined();
  });

  // The list is a list. Three paragraphs per row is what made the old page a wall.
  it("keeps the descriptions off the list", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    for (const item of response.body.experiments) {
      expect(item.doesWhat).toBeUndefined();
      expect(item.affectsWho).toBeUndefined();
      expect(item.arms).toBeUndefined();
    }
  });

  it("returns one experiment with its summary and its flags", async () => {
    snapshot.mockReturnValue([
      {
        key: "DM_RECOVERY_ENABLED",
        valueBool: true,
        valuePercent: null,
        source: "environment",
        driftsFromEnv: false,
        updatedBy: null,
        updatedAt: null,
      },
    ]);

    const response = await request(app())
      .get("/api/experiments/recovery-reminder-timing")
      .expect(200);

    expect(response.body).toMatchObject({
      key: "recovery-reminder-timing",
      state: "running",
      summary: { kind: "running" },
    });
    expect(response.body.arms).toHaveLength(2);
    expect(response.body.ownedFlags.map((f: { key: string }) => f.key)).toEqual([
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_HOLDOUT_PERCENT",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
      "DM_RECOVERY_POST_EXPERIMENT_ENABLED",
    ]);
    // Descriptions come along, so the page needs one request.
    expect(response.body.ownedFlags[0].doesWhat.length).toBeGreaterThan(20);
    // And the value in force, merged from the snapshot.
    expect(response.body.ownedFlags[0]).toMatchObject({ valueBool: true, source: "environment" });
  });

  // A flag with no stored override row must still appear, or a switch becomes
  // invisible exactly when nobody has touched it.
  it("includes an owned flag that has no stored value", async () => {
    snapshot.mockReturnValue([]);

    const response = await request(app())
      .get("/api/experiments/recovery-reminder-timing")
      .expect(200);

    expect(response.body.ownedFlags).toHaveLength(5);
  });

  it("404s an unknown experiment", async () => {
    await request(app()).get("/api/experiments/nope").expect(404);
  });
});
