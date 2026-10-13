// src/services/guideOwner.test.ts
import { describe, expect, it, vi } from "vitest";
import { guideOwnerFor } from "./guideOwner.js";

describe("guideOwnerFor", () => {
  it("routes a link guide to the link path without asking the strict-gate selector", () => {
    const select = vi.fn(() => "v2" as const);
    expect(guideOwnerFor({ deliveryMode: "link", igUserId: "ig-1", resourceId: "res-1" }, select)).toBe("link");
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["gated", undefined] as const)("leaves a %s guide to the selector", (deliveryMode) => {
    expect(guideOwnerFor({ deliveryMode, igUserId: "ig-1", resourceId: "res-1" }, () => "v2")).toBe("v2");
  });

  it("lets a selector failure reach the caller, which falls back to V1 and logs it", () => {
    expect(() =>
      guideOwnerFor({ deliveryMode: "gated", igUserId: "ig-1", resourceId: "res-1" }, () => {
        throw new Error("flag_read_failed");
      }),
    ).toThrow("flag_read_failed");
  });
});
