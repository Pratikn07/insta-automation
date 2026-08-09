import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const loggerError = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { $queryRaw: queryRaw },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError },
}));
vi.mock("./eventLogger.js", () => ({ logEvent: vi.fn() }));
vi.mock("./recoveryCampaignControl.js", () => ({ completeCampaignIfDrained: vi.fn() }));

const { reconcileHistoricalRecoveryAttributionSafely } =
  await import("./historicalRecoveryAttribution.js");

describe("durable historical attribution reconciliation", () => {
  beforeEach(() => {
    queryRaw.mockReset();
    loggerError.mockReset();
  });

  it("logs a transient database failure and succeeds when the next tick replays it", async () => {
    queryRaw.mockRejectedValueOnce(new Error("temporary database failure"));

    await expect(reconcileHistoricalRecoveryAttributionSafely())
      .resolves.toEqual({ inbound: 0, completed: 0 });
    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "historical_recovery_attribution_reconciliation_failed" },
      "Could not reconcile durable historical recovery attribution",
    );

    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(reconcileHistoricalRecoveryAttributionSafely())
      .resolves.toEqual({ inbound: 0, completed: 0 });
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });
});
