import { describe, expect, it } from "vitest";
import { summarizeDropOff, type DropOffCounts, type DropOffRow } from "./dropOff.js";

function counts(over: Partial<DropOffCounts> = {}): DropOffCounts {
  return {
    total: 0,
    expired: 0,
    stillOpen: 0,
    confirmedSeen: 0,
    trackedNeverConfirmed: 0,
    noReadData: 0,
    reminderSent: 0,
    reminderSuppressed: 0,
    inControlArm: 0,
    ...over,
  };
}

const NO_ROWS: DropOffRow[] = [];

describe("summarizeDropOff", () => {
  it("keeps read evidence three-way instead of calling unknowns unseen", () => {
    // The distinction decides the fix. "Never seen" points at deliverability;
    // "seen and ignored" points at the copy. Folding noReadData into unseen
    // would manufacture evidence for the first.
    const s = summarizeDropOff(
      "no-reply",
      counts({ total: 1727, confirmedSeen: 64, trackedNeverConfirmed: 556, noReadData: 1107 }),
      NO_ROWS,
      5,
    );
    expect(s.readEvidence.confirmedSeen).toBe(64);
    expect(s.readEvidence.trackedNeverConfirmed).toBe(556);
    expect(s.readEvidence.noReadData).toBe(1107);
    // Denominator is only what we can actually judge — 620, not 1,727.
    expect(s.readEvidence.confirmedSeenOfTracked.denominator).toBe(620);
    expect(s.readEvidence.confirmedSeenOfTracked.pct).toBe(10.3);
  });

  it("suppresses the read rate when almost nothing was tracked", () => {
    const s = summarizeDropOff(
      "no-reply",
      counts({ total: 400, confirmedSeen: 1, trackedNeverConfirmed: 2, noReadData: 397 }),
      NO_ROWS,
      5,
    );
    expect(s.readEvidence.confirmedSeenOfTracked.denominator).toBe(3);
    expect(s.readEvidence.confirmedSeenOfTracked.pct).toBeNull();
    expect(s.readEvidence.confirmedSeenOfTracked.belowMinSample).toBe(true);
  });

  it("reports zero tracked without dividing by zero", () => {
    const s = summarizeDropOff("no-reply", counts({ total: 10, noReadData: 10 }), NO_ROWS, 5);
    expect(s.readEvidence.confirmedSeenOfTracked.pct).toBeNull();
    expect(s.total).toBe(10);
  });

  it("carries the bucket's label and definition so the UI never invents wording", () => {
    const wall = summarizeDropOff("stuck-at-wall", counts({ total: 68 }), NO_ROWS, 5);
    expect(wall.bucket).toBe("stuck-at-wall");
    expect(wall.label).toBe("Asked to follow, never did");
    expect(wall.definition).toContain("follow");
  });

  it("splits conversation state so 'still open' is not read as lost", () => {
    const s = summarizeDropOff(
      "no-reply",
      counts({ total: 1727, expired: 1636, stillOpen: 81 }),
      NO_ROWS,
      5,
    );
    expect(s.byState).toEqual({ expired: 1636, stillOpen: 81 });
  });

  it("passes rows through for the actionable list", () => {
    const rows: DropOffRow[] = [
      {
        conversationId: "c1",
        igUserId: "ig1",
        username: "someone",
        enteredAt: new Date("2026-08-13T23:58:55.979Z"),
        state: "awaiting_done",
        keyword: "PROTEIN",
        wallAsks: 0,
        recoveryStatus: "suppressed",
        recoveryArm: "treatment",
        seenAt: null,
        suppressionReason: "audience_out_of_market",
      },
    ];
    const s = summarizeDropOff("no-reply", counts({ total: 1 }), rows, 5);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].suppressionReason).toBe("audience_out_of_market");
  });
});
