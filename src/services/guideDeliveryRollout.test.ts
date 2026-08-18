import { describe, expect, it } from "vitest";
import { guideDeliveryOwner } from "./guideDeliveryRollout.js";

const EMPTY_COHORT = new Set<string>();

function owner(
  overrides: Partial<Parameters<typeof guideDeliveryOwner>[0]> = {},
) {
  return guideDeliveryOwner({
    enabled: true,
    rolloutPercent: 0,
    cohortIgUserIds: EMPTY_COHORT,
    igUserId: "ig-user-1",
    triggerId: "trigger-0",
    ...overrides,
  });
}

describe("guideDeliveryOwner", () => {
  it.each([null, undefined])("fails closed for a missing runtime input: %s", (input) => {
    expect(guideDeliveryOwner(input as never)).toBe("legacy");
  });

  it("keeps every trigger on legacy while durable delivery is disabled", () => {
    expect(
      owner({
        enabled: false,
        rolloutPercent: 100,
        cohortIgUserIds: new Set(["ig-user-1"]),
      }),
    ).toBe("legacy");
  });

  it("does not inspect the controlled cohort while durable delivery is disabled", () => {
    const cohortIgUserIds = {
      has: () => {
        throw new Error("cohort must not be inspected");
      },
    } as unknown as ReadonlySet<string>;

    expect(owner({ enabled: false, cohortIgUserIds })).toBe("legacy");
  });

  it.each([null, 0, 1, "false", "true", {}])(
    "fails closed unless enabled is the literal boolean true: %j",
    (enabled) => {
      expect(
        owner({
          enabled: enabled as never,
          rolloutPercent: 100,
          cohortIgUserIds: new Set(["ig-user-1"]),
        }),
      ).toBe("legacy");
    },
  );

  it.each([
    ["blank recipient", { igUserId: "" }],
    ["whitespace recipient", { igUserId: "   " }],
    ["blank trigger", { triggerId: "" }],
    ["whitespace trigger", { triggerId: "\t\n" }],
  ] as const)("fails closed for a %s", (_label, overrides) => {
    expect(owner({ rolloutPercent: 100, ...overrides })).toBe("legacy");
  });

  it("fails closed when a malformed cohort throws during membership lookup", () => {
    const cohortIgUserIds = {
      has: () => {
        throw new Error("malformed runtime cohort");
      },
    } as unknown as ReadonlySet<string>;

    expect(owner({ cohortIgUserIds, rolloutPercent: 100 })).toBe("legacy");
  });

  it("fails closed when a malformed cohort throws while exposing membership lookup", () => {
    const cohortIgUserIds = Object.defineProperty({}, "has", {
      get() {
        throw new Error("malformed runtime cohort accessor");
      },
    }) as ReadonlySet<string>;

    expect(owner({ cohortIgUserIds, rolloutPercent: 100 })).toBe("legacy");
  });

  it("assigns an exact controlled recipient to the ledger even at zero percent", () => {
    expect(
      owner({
        cohortIgUserIds: new Set(["ig-user-1"]),
        rolloutPercent: 0,
      }),
    ).toBe("ledger");
  });

  it("does not widen the controlled recipient match", () => {
    const cohortIgUserIds = new Set(["ig-user-1"]);

    expect(owner({ cohortIgUserIds, igUserId: "IG-USER-1" })).toBe("legacy");
    expect(owner({ cohortIgUserIds, igUserId: " ig-user-1" })).toBe("legacy");
  });

  it("keeps a non-controlled recipient on legacy at zero percent", () => {
    expect(
      owner({
        cohortIgUserIds: new Set(["someone-else"]),
        rolloutPercent: 0,
      }),
    ).toBe("legacy");
  });

  it("uses the exact percentage boundaries", () => {
    expect(owner({ rolloutPercent: 0 })).toBe("legacy");
    expect(owner({ rolloutPercent: 100 })).toBe("ledger");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 101])(
    "fails closed to legacy for invalid rollout percent %s",
    (rolloutPercent) => {
      expect(owner({ rolloutPercent })).toBe("legacy");
    },
  );

  it("keeps the same trigger with the same owner across calls", () => {
    const inputs = {
      rolloutPercent: 25,
      triggerId: "stable-trigger",
    };

    expect(owner(inputs)).toBe(owner(inputs));
  });

  it("uses the SHA-256 trigger bucket for a partial cohort", () => {
    // Hand-checked SHA-256 unsigned-prefix buckets:
    // trigger-0 -> 22, trigger-1 -> 47, trigger-4 -> 2, trigger-11 -> 93.
    expect(owner({ rolloutPercent: 25, triggerId: "trigger-0" })).toBe("ledger");
    expect(owner({ rolloutPercent: 25, triggerId: "trigger-1" })).toBe("legacy");
    expect(owner({ rolloutPercent: 25, triggerId: "trigger-4" })).toBe("ledger");
    expect(owner({ rolloutPercent: 25, triggerId: "trigger-11" })).toBe("legacy");
  });

  it("always returns one concrete owner", () => {
    for (const triggerId of ["trigger-0", "trigger-1", "trigger-2", "trigger-3"]) {
      const result = owner({ rolloutPercent: 50, triggerId });
      expect(result === "legacy" || result === "ledger").toBe(true);
      expect(Array.isArray(result)).toBe(false);
      expect(result).not.toBeNull();
    }
  });
});
