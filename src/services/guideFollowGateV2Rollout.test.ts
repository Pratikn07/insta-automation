import { describe, expect, it, vi } from "vitest";
import { createGuideFollowGateV2Selector } from "./guideFollowGateV2Rollout.js";

function selector(overrides: Partial<Parameters<typeof createGuideFollowGateV2Selector>[0]> = {}) {
  return createGuideFollowGateV2Selector({
    isEnabled: () => true,
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
