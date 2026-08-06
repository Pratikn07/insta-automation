import { describe, expect, it } from "vitest";
import { compareInboundOrder } from "./dmOrdering.js";

describe("compareInboundOrder", () => {
  it("orders a later Meta timestamp after an earlier one", () => {
    expect(
      compareInboundOrder(
        { at: new Date("2026-08-05T10:00:01.000Z"), id: "mid-a" },
        { at: new Date("2026-08-05T10:00:00.000Z"), id: "mid-z" },
      ),
    ).toBeGreaterThan(0);
  });

  it("breaks equal-timestamp ties with the unique Instagram message ID", () => {
    expect(
      compareInboundOrder(
        { at: new Date("2026-08-05T10:00:00.000Z"), id: "mid-b" },
        { at: new Date("2026-08-05T10:00:00.000Z"), id: "mid-a" },
      ),
    ).toBeGreaterThan(0);
  });

  it("returns zero for the same timestamp and Instagram message ID", () => {
    const order = { at: new Date("2026-08-05T10:00:00.000Z"), id: "mid-a" };
    expect(compareInboundOrder(order, order)).toBe(0);
  });
});
