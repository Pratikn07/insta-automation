import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn();
const controlFindUnique = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryControl: { upsert, findUnique: controlFindUnique },
  },
}));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({
  env: {
    LOG_LEVEL: "info",
    DM_RECOVERY_HOURLY_CAP: 30,
    DM_RECOVERY_BACKLOG_ALERT_THRESHOLD: 500,
    DM_RECOVERY_HEALTH_SAMPLE_SIZE: 50,
    DM_RECOVERY_FAILURE_RATE_PERCENT: 50,
    DM_RECOVERY_DB_FAILURE_THRESHOLD: 3,
    DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE: 20,
  },
}));

const { evaluateRecoveryHealth, _resetHealthState } = await import("./dmRecoveryHealth.js");

function healthInput(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-08-06T12:00:00Z"),
    dueCount: 0,
    sentLastHour: 0,
    outcomeCount: 0,
    publicFailureCount: 0,
    acceptedCount: 0,
    seenOrEngagedCount: 0,
    recentDatabaseFailures: 0,
    ...overrides,
  };
}

beforeEach(() => {
  upsert.mockReset();
  controlFindUnique.mockReset();
  logEvent.mockReset();
  controlFindUnique.mockResolvedValue(null);
  _resetHealthState();
});

describe("evaluateRecoveryHealth", () => {
  it.each([
    ["auth_or_permission", { forcedReason: "auth_or_permission" }],
    ["webhook_signal_gap", { acceptedCount: 20, seenOrEngagedCount: 0 }],
    ["backlog_anomaly", { dueCount: 501 }],
    ["public_failure_rate", { outcomeCount: 50, publicFailureCount: 25 }],
    ["hourly_cap", { sentLastHour: 30 }],
    ["database_failures", { recentDatabaseFailures: 3 }],
  ])("opens the circuit for %s", async (reason, observations) => {
    await evaluateRecoveryHealth(healthInput(observations));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          circuitOpen: true,
          reason,
          openedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("does not open circuit when accepted count is below minimum sample", async () => {
    const snap = await evaluateRecoveryHealth(
      healthInput({ acceptedCount: 5, seenOrEngagedCount: 0 }),
    );
    expect(snap.circuitOpen).toBe(false);
  });

  it("returns healthy closed snapshot when all metrics are within limits", async () => {
    const snap = await evaluateRecoveryHealth(healthInput());
    expect(snap.circuitOpen).toBe(false);
    expect(snap.reason).toBeNull();
  });

  it("keeps auth_or_permission latched even after healthy evaluations", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "auth_or_permission",
      openedAt: new Date("2026-08-06T11:00:00Z"),
    });

    // 3 consecutive healthy evals should NOT close auth_or_permission
    for (let i = 0; i < 4; i++) {
      const snap = await evaluateRecoveryHealth(healthInput());
      expect(snap.circuitOpen).toBe(true);
      expect(snap.reason).toBe("auth_or_permission");
    }
  });

  it("auto-closes an auto-recoverable reason after 3 consecutive healthy evals", async () => {
    controlFindUnique.mockResolvedValue({
      circuitOpen: true,
      reason: "backlog_anomaly",
      openedAt: new Date("2026-08-06T11:00:00Z"),
    });

    // First two healthy evals keep circuit open
    const snap1 = await evaluateRecoveryHealth(healthInput());
    expect(snap1.circuitOpen).toBe(true);

    const snap2 = await evaluateRecoveryHealth(healthInput());
    expect(snap2.circuitOpen).toBe(true);

    // Third healthy eval closes it
    const snap3 = await evaluateRecoveryHealth(healthInput());
    expect(snap3.circuitOpen).toBe(false);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ circuitOpen: false }),
      }),
    );
  });
});
