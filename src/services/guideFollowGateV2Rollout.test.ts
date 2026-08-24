import { describe, expect, it, vi } from "vitest";
import { createGuideFollowGateV2Selector } from "./guideFollowGateV2Rollout.js";

function selector(overrides: Partial<Parameters<typeof createGuideFollowGateV2Selector>[0]> = {}) {
  return createGuideFollowGateV2Selector({
    isEnabled: () => true,
    // Off by default so the allowlist behaviour below is what is actually under test. The
    // "every guide" mode is exercised explicitly in its own cases.
    isAllGuides: () => false,
    cohortIgUserIds: new Set<string>(),
    resourceIds: new Set<string>(),
    ...overrides,
  });
}

describe("strict follower-gate V2 rollout fence", () => {
  it("keeps everyone on V1 when the flag is off, even if both IDs are allowlisted", () => {
    const rollout = selector({
      isEnabled: () => false,
      cohortIgUserIds: new Set(["account-1"]),
      resourceIds: new Set(["guide-1"]),
    });

    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
  });

  it("keeps everyone on V1 when both allowlists are absent", () => {
    expect(selector().owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
  });

  /**
   * The graduation from the pilot.
   *
   * An allowlist can only ever name guides that exist when an operator pastes it in, so a
   * keyword attached next week silently stayed on V1 — no error, no log, nothing to notice. This
   * is the switch that covers guides which do not exist yet.
   */
  describe("every guide", () => {
    it("selects V2 for any guide and any account, with both allowlists empty", () => {
      const rollout = selector({ isAllGuides: () => true });

      expect(rollout.owner({ igUserId: "someone-new", resourceId: "guide-added-later" })).toBe(
        "v2",
      );
      expect(rollout.owner({ igUserId: "another", resourceId: "different-guide" })).toBe("v2");
    });

    it("still obeys the kill switch, so one flag stops everything", () => {
      const rollout = selector({ isEnabled: () => false, isAllGuides: () => true });

      expect(rollout.owner({ igUserId: "someone-new", resourceId: "guide-1" })).toBe("v1");
    });

    it("does nothing on its own when strict access itself is off", () => {
      // Two switches on purpose: breadth cannot turn on a flow that is off.
      const rollout = selector({
        isEnabled: () => false,
        isAllGuides: () => true,
        cohortIgUserIds: new Set(["account-1"]),
      });

      expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
    });

    it("falls back to V1 when the breadth flag cannot be read", () => {
      // A flag-store problem must never be the reason a parent's journey changes shape.
      const rollout = selector({
        isAllGuides: () => {
          throw new Error("flag store unavailable");
        },
      });

      expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
    });

    it("still rejects an empty account or guide id", () => {
      const rollout = selector({ isAllGuides: () => true });

      expect(rollout.owner({ igUserId: "", resourceId: "guide-1" })).toBe("v1");
      expect(rollout.owner({ igUserId: "account-1", resourceId: "" })).toBe("v1");
    });

    it("is re-read for every action, so a stop applies to the next one", () => {
      let all = true;
      const isAllGuides = vi.fn(() => all);
      const rollout = selector({ isAllGuides });

      expect(rollout.owner({ igUserId: "a", resourceId: "g" })).toBe("v2");
      all = false;
      expect(rollout.owner({ igUserId: "a", resourceId: "g" })).toBe("v1");
      expect(isAllGuides).toHaveBeenCalledTimes(2);
    });
  });

  it("selects an exact allowlisted controlled account", () => {
    const rollout = selector({ cohortIgUserIds: new Set(["account-1"]) });

    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v2");
    expect(rollout.owner({ igUserId: "ACCOUNT-1", resourceId: "guide-1" })).toBe("v1");
    expect(rollout.owner({ igUserId: " account-1", resourceId: "guide-1" })).toBe("v1");
  });

  it("selects an exact allowlisted guide", () => {
    const rollout = selector({ resourceIds: new Set(["guide-1"]) });

    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v2");
    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-10" })).toBe("v1");
  });

  it("fails closed for malformed inputs and malformed allowlists", () => {
    const throwing = {
      has: () => {
        throw new Error("bad allowlist");
      },
    } as unknown as ReadonlySet<string>;

    expect(
      selector({ cohortIgUserIds: throwing }).owner({
        igUserId: "account-1",
        resourceId: "guide-1",
      }),
    ).toBe("v1");
    expect(
      selector({ resourceIds: throwing }).owner({
        igUserId: "account-1",
        resourceId: "guide-1",
      }),
    ).toBe("v1");
    expect(selector().owner({ igUserId: "", resourceId: "guide-1" })).toBe("v1");
    expect(selector().owner(null as never)).toBe("v1");
  });

  it("re-reads the kill switch for every action", () => {
    let enabled = true;
    const isEnabled = vi.fn(() => enabled);
    const rollout = selector({
      isEnabled,
      cohortIgUserIds: new Set(["account-1"]),
    });

    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v2");
    enabled = false;
    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
    expect(isEnabled).toHaveBeenCalledTimes(2);
  });

  it("fails closed when reading the kill switch fails", () => {
    const rollout = selector({
      isEnabled: () => {
        throw new Error("flag unavailable");
      },
      resourceIds: new Set(["guide-1"]),
    });

    expect(rollout.owner({ igUserId: "account-1", resourceId: "guide-1" })).toBe("v1");
  });
});
