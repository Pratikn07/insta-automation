import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn();
const controlFindUnique = vi.fn();
const count = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryControl: { upsert, findUnique: controlFindUnique },
    dmRecoveryReminder: { count },
  },
}));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({
  env: {
    DM_RECOVERY_HOURLY_CAP: 30,
    DM_RECOVERY_BACKLOG_ALERT_THRESHOLD: 500,
    DM_RECOVERY_HEALTH_SAMPLE_SIZE: 50,
    DM_RECOVERY_FAILURE_RATE_PERCENT: 50,
    DM_RECOVERY_DB_FAILURE_THRESHOLD: 3,
    DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE: 20,
  },
}));

const {
  evaluateRecoveryHealth,
  getRecoveryHealthSnapshot,
  recordRecoveryDatabaseFailure,
  openRecoveryCircuit,
  _resetHealthState,
} = await import("./dmRecoveryHealth.js");

const NOW = new Date("2026-08-06T12:00:00Z");

/**
 * collectObservations issues its six counts in a fixed order:
 * due, sentLastHour, outcomes, publicFailures, accepted, seenOrEngaged.
 */
function observations(o: Partial<Record<string, number>> = {}) {
  const seq = [
    o.due ?? 0,
    o.sentLastHour ?? 0,
    o.outcomes ?? 0,
    o.publicFailures ?? 0,
    o.accepted ?? 0,
    o.seenOrEngaged ?? 0,
  ];
  let i = 0;
  count.mockImplementation(async () => seq[i++ % seq.length]);
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue({});
  controlFindUnique.mockReset().mockResolvedValue(null);
  count.mockReset();
  logEvent.mockReset();
  _resetHealthState();
  observations();
});

describe("evaluateRecoveryHealth", () => {
  // Each of these was unreachable while the worker passed hardcoded zeros for
  // the sample inputs: the module now gathers its own observations.
  it.each([
    ["webhook_signal_gap", { accepted: 20, seenOrEngaged: 0 }],
    ["backlog_anomaly", { due: 500 }],
    ["public_failure_rate", { outcomes: 50, publicFailures: 25 }],
    ["hourly_cap", { sentLastHour: 30 }],
  ])("opens the circuit for %s", async (reason, obs) => {
    observations(obs);

    const snapshot = await evaluateRecoveryHealth(NOW);

    expect(snapshot).toMatchObject({ circuitOpen: true, reason });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ circuitOpen: true, reason }) }),
    );
  });

  it("opens the circuit for repeated database failures", async () => {
    for (let i = 0; i < 3; i++) recordRecoveryDatabaseFailure();

    const snapshot = await evaluateRecoveryHealth(NOW);

    expect(snapshot).toMatchObject({ circuitOpen: true, reason: "database_failures" });
  });

  it("does not treat a small zero-read sample as a webhook gap", async () => {
    observations({ accepted: 19, seenOrEngaged: 0 });
    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({ circuitOpen: false });
  });

  it("does not compute a failure rate below the configured sample size", async () => {
    observations({ outcomes: 49, publicFailures: 49 });
    const snapshot = await evaluateRecoveryHealth(NOW);
    expect(snapshot.recentFailureRate).toBeNull();
    expect(snapshot.circuitOpen).toBe(false);
  });

  it("reports a healthy snapshot when nothing is wrong", async () => {
    observations({ accepted: 40, seenOrEngaged: 12, outcomes: 60, publicFailures: 3 });
    const snapshot = await evaluateRecoveryHealth(NOW);
    expect(snapshot.circuitOpen).toBe(false);
    expect(snapshot.recentFailureRate).toBeCloseTo(5);
  });

  // Anomaly selection used to run first, so a recoverable reason overwrote the
  // latch and the three-healthy rule then auto-closed a circuit that must only
  // be cleared once someone has verified the credentials.
  it("does not let a new anomaly overwrite a latched auth circuit", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "auth_or_permission",
      openedAt: NOW,
    });
    observations({ due: 500 }); // a backlog anomaly is also present

    const snapshot = await evaluateRecoveryHealth(NOW);

    expect(snapshot).toMatchObject({ circuitOpen: true, reason: "auth_or_permission" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("ignores rows still inside their retry backoff when measuring backlog", async () => {
    await evaluateRecoveryHealth(NOW);
    const dueWhere = count.mock.calls[0]![0].where;
    expect(dueWhere.OR).toEqual([
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: NOW } },
    ]);
  });

  it("keeps auth_or_permission latched no matter how healthy things look", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "auth_or_permission",
      openedAt: NOW,
    });

    for (let i = 0; i < 5; i++) {
      await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({
        circuitOpen: true,
        reason: "auth_or_permission",
      });
    }
  });

  it("clears an anomaly only after three consecutive healthy evaluations", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "backlog_anomaly",
      openedAt: NOW,
    });

    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({ circuitOpen: true });
    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({ circuitOpen: true });
    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({ circuitOpen: false });

    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          circuitOpen: false,
          resetBy: "health_auto_recovery",
          resetAt: NOW,
        }),
      }),
    );
  });

  it("restarts the proof window after a restart rather than force-closing", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "backlog_anomaly",
      openedAt: NOW,
    });

    await evaluateRecoveryHealth(NOW);
    await evaluateRecoveryHealth(NOW);
    _resetHealthState(); // process restart
    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({ circuitOpen: true });
  });
});

describe("circuit events", () => {
  // An outage lasts many ticks; logging every one buries the transition.
  it("logs opening only when the stored state changes", async () => {
    controlFindUnique.mockResolvedValue(null);
    await openRecoveryCircuit("backlog_anomaly", NOW);
    expect(logEvent).toHaveBeenCalledTimes(1);

    logEvent.mockClear();
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "backlog_anomaly",
      openedAt: NOW,
    });
    await openRecoveryCircuit("backlog_anomaly", NOW);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("logs a reason change while already open", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "backlog_anomaly",
      openedAt: NOW,
    });
    await openRecoveryCircuit("auth_or_permission", NOW);
    expect(logEvent).toHaveBeenCalledWith("dm_recovery_circuit_opened", {
      reason: "auth_or_permission",
    });
  });

  it("preserves the original openedAt across repeated opens", async () => {
    const openedAt = new Date("2026-08-06T09:00:00Z");
    controlFindUnique.mockResolvedValue({ circuitOpen: true, reason: "backlog_anomaly", openedAt });

    await openRecoveryCircuit("backlog_anomaly", NOW);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ openedAt }) }),
    );
  });
});

describe("getRecoveryHealthSnapshot", () => {
  it("reports stored circuit state alongside the observations", async () => {
    observations({ due: 7, sentLastHour: 2, outcomes: 100, publicFailures: 10, accepted: 30, seenOrEngaged: 9 });
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "public_failure_rate",
      openedAt: NOW,
    });

    await expect(getRecoveryHealthSnapshot(NOW)).resolves.toEqual({
      circuitOpen: true,
      reason: "public_failure_rate",
      openedAt: NOW,
      dueCount: 7,
      sentLastHour: 2,
      recentOutcomeCount: 100,
      recentFailureRate: 10,
      acceptedSignalSample: 30,
      positiveSignalSample: 9,
    });
  });

  // Reading a dashboard must not disarm the database-failure trip.
  it("does not consume the database failure window", async () => {
    for (let i = 0; i < 3; i++) recordRecoveryDatabaseFailure();

    await getRecoveryHealthSnapshot(NOW);

    await expect(evaluateRecoveryHealth(NOW)).resolves.toMatchObject({
      circuitOpen: true,
      reason: "database_failures",
    });
  });

  it("never writes to a recovery row", async () => {
    await getRecoveryHealthSnapshot(NOW);
    expect(upsert).not.toHaveBeenCalled();
  });
});
