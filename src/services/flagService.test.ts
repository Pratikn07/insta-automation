import { describe, expect, it, vi } from "vitest";
import { FLAG_REGISTRY } from "../config/flagRegistry.js";
import { createFlagService } from "./flagService.js";

type Row = {
  key: string;
  valueBool: boolean | null;
  valuePercent: number | null;
  updatedBy?: string;
  updatedAt?: Date;
};

function make(rows: Row[], envValues: Record<string, boolean | number> = {}) {
  const findOverrides = vi.fn().mockResolvedValue(rows);
  const onReadFailure = vi.fn();
  const service = createFlagService({
    findOverrides,
    envBool: (key) => Boolean(envValues[key] ?? false),
    envPercent: (key) => Number(envValues[key] ?? 0),
    onReadFailure,
  });
  return { service, findOverrides, onReadFailure };
}

function boolRow(key: string, valueBool: boolean): Row {
  return { key, valueBool, valuePercent: null, updatedBy: "owner@example.com" };
}

describe("flagService", () => {
  it("serves the environment before any refresh has happened", () => {
    const { service } = make([], { AI_DRAFTS_ENABLED: true });

    // A cold cache must behave exactly like production does today.
    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(true);
  });

  it("prefers a stored value after refreshing", async () => {
    const { service } = make([boolRow("AI_DRAFTS_ENABLED", false)], {
      AI_DRAFTS_ENABLED: true,
    });

    await service.refresh();

    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(false);
  });

  it("resolves a percentage the same way", async () => {
    const { service } = make(
      [{ key: "GUIDE_DELIVERY_ROLLOUT_PERCENT", valueBool: null, valuePercent: 100 }],
      { GUIDE_DELIVERY_ROLLOUT_PERCENT: 45 },
    );

    expect(service.percent("GUIDE_DELIVERY_ROLLOUT_PERCENT")).toBe(45);
    await service.refresh();
    expect(service.percent("GUIDE_DELIVERY_ROLLOUT_PERCENT")).toBe(100);
  });

  // The fail-closed rule. A database problem must not change behaviour, and must
  // never grant more than the environment already granted.
  it("keeps serving the environment value when the read fails", async () => {
    const { service, findOverrides, onReadFailure } = make([], { DM_RECOVERY_ENABLED: true });
    findOverrides.mockRejectedValue(new Error("connection refused"));

    await service.refresh();

    expect(service.bool("DM_RECOVERY_ENABLED")).toBe(true);
    expect(onReadFailure).toHaveBeenCalledTimes(1);
  });

  // Clearing the cache on a failed read would silently revert every override at
  // once, which is a bigger change than the failure itself.
  it("keeps the values it already had when a later read fails", async () => {
    const { service, findOverrides } = make([boolRow("AI_DRAFTS_ENABLED", false)], {
      AI_DRAFTS_ENABLED: true,
    });

    await service.refresh();
    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(false);

    findOverrides.mockRejectedValue(new Error("gone"));
    await service.refresh();

    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(false);
  });

  it("does not obey a row enabling a flag the console may not enable", async () => {
    const { service } = make([boolRow("AI_SEND_ENABLED", true)], { AI_SEND_ENABLED: false });

    await service.refresh();

    expect(service.bool("AI_SEND_ENABLED")).toBe(false);
  });

  it("obeys a row disabling that same flag", async () => {
    const { service } = make([boolRow("AI_SEND_ENABLED", false)], { AI_SEND_ENABLED: true });

    await service.refresh();

    expect(service.bool("AI_SEND_ENABLED")).toBe(false);
  });

  it("throws on a key with no definition rather than guessing false", () => {
    const { service } = make([]);

    // Returning false would be how an outbound feature stops without anyone
    // noticing a typo.
    expect(() => service.bool("NOT_A_FLAG")).toThrow(/NOT_A_FLAG/);
    expect(() => service.percent("NOT_A_FLAG")).toThrow(/NOT_A_FLAG/);
  });

  describe("snapshot", () => {
    it("reports every flag in the registry", async () => {
      const { service } = make([]);
      await service.refresh();

      expect(service.snapshot()).toHaveLength(FLAG_REGISTRY.length);
    });

    it("says a value came from the console, and that a restart would revert it", async () => {
      const { service } = make([boolRow("AI_DRAFTS_ENABLED", false)], {
        AI_DRAFTS_ENABLED: true,
      });
      await service.refresh();

      expect(service.snapshot().find((r) => r.key === "AI_DRAFTS_ENABLED")).toMatchObject({
        valueBool: false,
        source: "override",
        driftsFromEnv: true,
        updatedBy: "owner@example.com",
      });
    });

    it("says a value came from the environment when nothing is stored", async () => {
      const { service } = make([], { AI_DRAFTS_ENABLED: true });
      await service.refresh();

      expect(service.snapshot().find((r) => r.key === "AI_DRAFTS_ENABLED")).toMatchObject({
        valueBool: true,
        source: "environment",
        driftsFromEnv: false,
        updatedBy: null,
      });
    });

    // An override the safety rule threw away is not the source of anything. Saying
    // "override" here would tell the operator a row is in force when it is not.
    it("does not credit an override that was ignored", async () => {
      const { service } = make([boolRow("AI_SEND_ENABLED", true)], { AI_SEND_ENABLED: false });
      await service.refresh();

      expect(service.snapshot().find((r) => r.key === "AI_SEND_ENABLED")).toMatchObject({
        valueBool: false,
        source: "environment",
        driftsFromEnv: false,
      });
    });

    it("does not credit an ignored percentage either", async () => {
      const { service } = make(
        [{ key: "DM_RECOVERY_FAILURE_RATE_PERCENT", valueBool: null, valuePercent: 90 }],
        { DM_RECOVERY_FAILURE_RATE_PERCENT: 50 },
      );
      await service.refresh();

      expect(
        service.snapshot().find((r) => r.key === "DM_RECOVERY_FAILURE_RATE_PERCENT"),
      ).toMatchObject({ valuePercent: 50, source: "environment", driftsFromEnv: false });
    });
  });
});
