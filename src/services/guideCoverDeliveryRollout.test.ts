import { describe, expect, it, vi } from "vitest";
import { createGuideCoverDeliverySelector } from "./guideCoverDeliveryRollout.js";

const RESOURCE = "30000000-0000-4000-8000-000000000003";
const OTHER_RESOURCE = "40000000-0000-4000-8000-000000000004";
const TRIGGER = "50000000-0000-4000-8000-000000000005";

function selector(over: {
  enabled?: boolean | (() => boolean);
  resourceIds?: Iterable<string> | unknown;
  percent?: number | (() => number);
} = {}) {
  const enabled = over.enabled ?? true;
  const percent = over.percent ?? 0;
  return createGuideCoverDeliverySelector({
    isEnabled: typeof enabled === "function" ? enabled : () => enabled,
    resourceIds: () =>
      (over.resourceIds === undefined
        ? new Set<string>()
        : over.resourceIds) as ReadonlySet<string>,
    rolloutPercent: typeof percent === "function" ? percent : () => percent,
  });
}

describe("guide cover delivery selector", () => {
  it("selects nobody by default", () => {
    // An enabled switch with an empty allowlist and no percentage must still omit.
    expect(selector().decide({ resourceId: RESOURCE, triggerId: TRIGGER })).toBe("omit");
  });

  it("omits everything while the switch is off", () => {
    expect(
      selector({ enabled: false, resourceIds: new Set([RESOURCE]), percent: 100 }).decide({
        resourceId: RESOURCE,
        triggerId: TRIGGER,
      }),
    ).toBe("omit");
  });

  it("includes an explicitly allowlisted guide regardless of percentage", () => {
    expect(
      selector({ resourceIds: new Set([RESOURCE]), percent: 0 }).decide({
        resourceId: RESOURCE,
        triggerId: TRIGGER,
      }),
    ).toBe("include");
  });

  it("omits a guide outside the allowlist at 0 percent", () => {
    expect(
      selector({ resourceIds: new Set([OTHER_RESOURCE]) }).decide({
        resourceId: RESOURCE,
        triggerId: TRIGGER,
      }),
    ).toBe("omit");
  });

  it("includes everyone at 100 percent", () => {
    expect(selector({ percent: 100 }).decide({ resourceId: RESOURCE, triggerId: TRIGGER })).toBe(
      "include",
    );
  });

  it("is stable for one trigger across repeated decisions", () => {
    const stable = selector({ percent: 50 });
    const first = stable.decide({ resourceId: RESOURCE, triggerId: TRIGGER });

    for (let i = 0; i < 20; i += 1) {
      expect(stable.decide({ resourceId: RESOURCE, triggerId: TRIGGER })).toBe(first);
    }
  });

  it("buckets on the trigger, not the guide", () => {
    const half = selector({ percent: 50 });

    // Same trigger, different guides: the decision must not move, or a retry that resolved
    // a different resource could flip a journey mid-flight.
    expect(half.decide({ resourceId: RESOURCE, triggerId: TRIGGER })).toBe(
      half.decide({ resourceId: OTHER_RESOURCE, triggerId: TRIGGER }),
    );
  });

  it("spreads roughly evenly across triggers at 50 percent", () => {
    const half = selector({ percent: 50 });
    let included = 0;
    for (let i = 0; i < 400; i += 1) {
      if (half.decide({ resourceId: RESOURCE, triggerId: `trigger-${i}` }) === "include") {
        included += 1;
      }
    }

    // A hash that ignored its input would give 0 or 400.
    expect(included).toBeGreaterThan(140);
    expect(included).toBeLessThan(260);
  });

  // `percent: 100` on the non-percent cases is load-bearing. With the helper default of 0
  // these would return `omit` from the `percent <= 0` guard even with the guard under test
  // deleted, so they would pass against a broken selector.
  it.each([
    {
      label: "a throwing switch",
      over: { percent: 100, enabled: () => { throw new Error("flag"); } },
    },
    { label: "a throwing percent", over: { percent: () => { throw new Error("percent"); } } },
    { label: "a malformed id set", over: { percent: 100, resourceIds: { has: "nope" } } },
    { label: "an absent id set", over: { percent: 100, resourceIds: null as never } },
    { label: "a fractional percent", over: { percent: 12.5 } },
    { label: "a negative percent", over: { percent: -1 } },
    { label: "an over-100 percent", over: { percent: 101 } },
  ])("fails closed on $label", ({ over }) => {
    expect(
      selector(over as never).decide({ resourceId: RESOURCE, triggerId: TRIGGER }),
    ).toBe("omit");
  });

  it.each([
    { resourceId: "", triggerId: TRIGGER },
    { resourceId: RESOURCE, triggerId: "" },
    { resourceId: null as unknown as string, triggerId: TRIGGER },
  ])("fails closed on malformed input %o", (input) => {
    expect(selector({ percent: 100 }).decide(input)).toBe("omit");
  });

  it("reads the switch on every decision so a stop is immediate", () => {
    const isEnabled = vi.fn(() => true);
    const live = createGuideCoverDeliverySelector({
      isEnabled,
      resourceIds: () => new Set([RESOURCE]),
      rolloutPercent: () => 0,
    });

    live.decide({ resourceId: RESOURCE, triggerId: TRIGGER });
    isEnabled.mockReturnValue(false);

    expect(live.decide({ resourceId: RESOURCE, triggerId: TRIGGER })).toBe("omit");
    expect(isEnabled).toHaveBeenCalledTimes(2);
  });
});
