import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const summarize = vi.fn();
const snapshot = vi.fn();
const lifecycle = vi.fn();
const ownedFlagKeys = vi.fn();

vi.mock("../services/experimentSummary.js", () => ({
  summarizeExperiment: (key: string) => summarize(key),
}));
vi.mock("../services/flagService.js", () => ({
  flags: { snapshot: () => snapshot() },
}));
vi.mock("../services/experimentLifecycle.js", () => ({
  configuredExperimentState: (key: string, declared: string) => lifecycle(key, declared),
  configuredExperimentOwnedFlagKeys: (key: string, declared: string[]) =>
    ownedFlagKeys(key, declared),
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

const ENDED = {
  kind: "ended",
  arms: [
    { key: "treatment", label: "10 hours", people: 594 },
    { key: "control", label: "No reminder", people: 395 },
  ],
  notCounted: [],
  endedAt: "2026-08-21T16:00:00.000Z",
  conclusion: "This experiment concluded and was replaced by the 2 vs 6 hour test.",
};

const TIMING_RUNNING = {
  kind: "running",
  arms: [
    { key: "two_hour", label: "2 hours", people: 450 },
    { key: "six_hour", label: "6 hours", people: 450 },
    { key: "no_reminder", label: "No reminder", people: 100 },
  ],
  notCounted: [],
  endsAt: "2026-10-02T16:00:00.000Z",
  whenItEnds: "When the window closes, reminders stop and wait for your decision.",
};

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockReturnValue([]);
  lifecycle.mockImplementation((_key: string, declared: string) => declared);
  ownedFlagKeys.mockImplementation((_key: string, declared: string[]) => declared);
  summarize.mockImplementation((key: string) => {
    if (key === "recovery-reminder-timing") return Promise.resolve(ENDED);
    if (key === "recovery-reminder-timing-v2") return Promise.resolve(TIMING_RUNNING);
    return Promise.resolve(NOT_STARTED);
  });
});

describe("experiments API", () => {
  it("uses the configured lifecycle instead of showing the cutover early", async () => {
    lifecycle.mockImplementation((key: string, declared: string) => {
      if (key === "recovery-reminder-timing") return "running";
      if (key === "recovery-reminder-timing-v2") return "not_started";
      return declared;
    });

    const response = await request(app()).get("/api/experiments").expect(200);
    const byKey = new Map(
      response.body.experiments.map((row: { key: string; state: string }) => [row.key, row.state]),
    );
    expect(byKey.get("recovery-reminder-timing")).toBe("running");
    expect(byKey.get("recovery-reminder-timing-v2")).toBe("not_started");
  });

  it("lists the concluded V1 and active V2 as separate experiments", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    expect(response.body.experiments).toHaveLength(4);
    const concluded = response.body.experiments.find(
      (e: { key: string }) => e.key === "recovery-reminder-timing",
    );
    const active = response.body.experiments.find(
      (e: { key: string }) => e.key === "recovery-reminder-timing-v2",
    );
    expect(concluded).toMatchObject({
      name: "Recovery reminder — 10 hours vs none",
      state: "ended",
    });
    expect(active).toMatchObject({
      name: "Recovery reminder — 2 vs 6 hours",
      state: "running",
      armCount: 3,
    });
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
      (e: { key: string }) => e.key === "recovery-reminder-timing-v2",
    );
    expect(recovery.summary).toMatchObject({
      kind: "running",
      arms: [
        { key: "two_hour", label: "2 hours", people: 450 },
        { key: "six_hour", label: "6 hours", people: 450 },
        { key: "no_reminder", label: "No reminder", people: 100 },
      ],
      endsAt: "2026-10-02T16:00:00.000Z",
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
      .get("/api/experiments/recovery-reminder-timing-v2")
      .expect(200);

    expect(response.body).toMatchObject({
      key: "recovery-reminder-timing-v2",
      state: "running",
      summary: { kind: "running" },
    });
    expect(response.body.arms).toHaveLength(3);
    expect(response.body.ownedFlags.map((f: { key: string }) => f.key)).toEqual([
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
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
      .get("/api/experiments/recovery-reminder-timing-v2")
      .expect(200);

    expect(response.body.ownedFlags).toHaveLength(3);
  });

  it("shows no live controls on V2 before the scheduled cutover", async () => {
    lifecycle.mockImplementation((key: string, declared: string) =>
      key === "recovery-reminder-timing-v2" ? "not_started" : declared,
    );
    ownedFlagKeys.mockImplementation((key: string, declared: string[]) =>
      key === "recovery-reminder-timing-v2" ? [] : declared,
    );

    const response = await request(app())
      .get("/api/experiments/recovery-reminder-timing-v2")
      .expect(200);

    expect(response.body.state).toBe("not_started");
    expect(response.body.ownedFlags).toEqual([]);
  });

  it("404s an unknown experiment", async () => {
    await request(app()).get("/api/experiments/nope").expect(404);
  });
});
