import { describe, it, expect } from "vitest";
import {
  partitionIntoWindows,
  reconcileWindow,
  describeCanonicalChoice,
  type ReconcileCandidate,
} from "./journeyReconciliationCore.js";

// These rules decide which of ~805 historical conversations owns a request. A
// mistake silently rewrites that history, so the partitioning and precedence are
// tested as pure functions rather than only through the script.

const HOUR = 60 * 60 * 1000;
const at = (hoursFromEpoch: number) => new Date(Date.UTC(2026, 7, 1) + hoursFromEpoch * HOUR);

function candidate(overrides: Partial<ReconcileCandidate> & { id: string }): ReconcileCandidate {
  return {
    createdAt: at(0),
    completed: false,
    hasSentGate: false,
    completedAt: null,
    ...overrides,
  };
}

describe("partitionIntoWindows", () => {
  it("returns nothing for no journeys", () => {
    expect(partitionIntoWindows([])).toEqual([]);
  });

  it("keeps journeys inside 48 hours in one window", () => {
    const rows = [{ createdAt: at(0) }, { createdAt: at(6) }, { createdAt: at(47) }];
    expect(partitionIntoWindows(rows)).toHaveLength(1);
  });

  // The boundary is strict, matching the live resolver: at exactly 48 hours a new
  // window opens. Reconciled history and future behaviour must agree, or a
  // reconciled row would behave differently from a fresh one.
  it("splits at exactly 48 hours", () => {
    const windows = partitionIntoWindows([{ createdAt: at(0) }, { createdAt: at(48) }]);
    expect(windows).toHaveLength(2);
  });

  it("keeps 47h59m together", () => {
    const rows = [{ createdAt: at(0) }, { createdAt: new Date(at(48).getTime() - 60_000) }];
    expect(partitionIntoWindows(rows)).toHaveLength(1);
  });

  // Measured gap-to-gap, not from the window's start. Someone asking daily would
  // otherwise collapse into one endless intent that never expires.
  it("chains a rolling series into one window rather than splitting on total span", () => {
    const rows = [{ createdAt: at(0) }, { createdAt: at(40) }, { createdAt: at(80) }];
    const windows = partitionIntoWindows(rows);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(3);
  });

  it("opens a fresh window after a long silence", () => {
    const rows = [{ createdAt: at(0) }, { createdAt: at(10) }, { createdAt: at(200) }];
    const windows = partitionIntoWindows(rows);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toHaveLength(2);
    expect(windows[1]).toHaveLength(1);
  });
});

describe("reconcileWindow precedence", () => {
  // Tier 1. A completed journey demonstrably delivered the guide, so it owns the
  // request regardless of order.
  it("prefers the completed journey even when it is not the earliest", () => {
    const window = [
      candidate({ id: "first", createdAt: at(0) }),
      candidate({ id: "completed", createdAt: at(1), completed: true, completedAt: at(2) }),
    ];

    const result = reconcileWindow(window);

    expect(result.canonicalId).toBe("completed");
    expect(describeCanonicalChoice(window)).toBe("completed");
  });

  // Tier 2. Meta confirmed it accepted this journey's gate DM, so this is the one
  // the person actually heard from.
  it("prefers a confirmed gate when nothing completed", () => {
    const window = [
      candidate({ id: "first", createdAt: at(0) }),
      candidate({ id: "gated", createdAt: at(1), hasSentGate: true }),
    ];

    const result = reconcileWindow(window);

    expect(result.canonicalId).toBe("gated");
    expect(describeCanonicalChoice(window)).toBe("confirmed_gate");
  });

  it("falls back to the earliest journey", () => {
    const window = [
      candidate({ id: "second", createdAt: at(5) }),
      candidate({ id: "earliest", createdAt: at(0) }),
    ];

    const result = reconcileWindow(window);

    expect(result.canonicalId).toBe("earliest");
    expect(describeCanonicalChoice(window)).toBe("earliest");
  });

  it("outranks a confirmed gate with a completion", () => {
    const window = [
      candidate({ id: "gated", createdAt: at(0), hasSentGate: true }),
      candidate({ id: "completed", createdAt: at(1), completed: true, completedAt: at(1) }),
    ];

    expect(reconcileWindow(window).canonicalId).toBe("completed");
  });
});

describe("reconcileWindow alias labelling", () => {
  // The distinction that carries the reporting value: `recovered` rows are
  // satisfied requests currently counted as failures.
  it("marks aliases recovered when a sibling completed", () => {
    const result = reconcileWindow([
      candidate({ id: "done", createdAt: at(0), completed: true, completedAt: at(1) }),
      candidate({ id: "alias", createdAt: at(2) }),
    ]);

    expect(result.aliases).toEqual([
      expect.objectContaining({ id: "alias", state: "recovered" }),
    ]);
  });

  it("marks aliases superseded when none completed", () => {
    const result = reconcileWindow([
      candidate({ id: "first", createdAt: at(0) }),
      candidate({ id: "second", createdAt: at(1) }),
    ]);

    expect(result.aliases).toEqual([
      expect.objectContaining({ id: "second", state: "superseded" }),
    ]);
  });

  it("leaves a single-journey window with no aliases", () => {
    const result = reconcileWindow([candidate({ id: "only", createdAt: at(0) })]);
    expect(result.aliases).toEqual([]);
    expect(result.canonicalId).toBe("only");
  });

  it("never lists the canonical journey as its own alias", () => {
    const result = reconcileWindow([
      candidate({ id: "a", createdAt: at(0) }),
      candidate({ id: "b", createdAt: at(1) }),
      candidate({ id: "c", createdAt: at(2) }),
    ]);

    expect(result.aliases.map((a) => a.id)).not.toContain(result.canonicalId);
    expect(result.aliases).toHaveLength(2);
  });
});

describe("reconcileWindow window bounds", () => {
  it("spans first trigger to last, expiring 48h after the last", () => {
    const result = reconcileWindow([
      candidate({ id: "a", createdAt: at(0) }),
      candidate({ id: "b", createdAt: at(10) }),
    ]);

    expect(result.windowStartedAt).toEqual(at(0));
    expect(result.lastTriggerAt).toEqual(at(10));
    expect(result.windowExpiresAt).toEqual(at(58));
  });

  // The EARLIEST completion, so a later trigger inside the window reads as
  // already-completed rather than re-gating someone who has the guide.
  it("takes the earliest completion in the window", () => {
    const result = reconcileWindow([
      candidate({ id: "late", createdAt: at(2), completed: true, completedAt: at(9) }),
      candidate({ id: "early", createdAt: at(0), completed: true, completedAt: at(3) }),
    ]);

    expect(result.completedAt).toEqual(at(3));
  });

  it("reports no completion when nothing completed", () => {
    const result = reconcileWindow([candidate({ id: "a", createdAt: at(0) })]);
    expect(result.completedAt).toBeNull();
  });

  // Callers sort in SQL, but the function must not depend on it: an unsorted
  // window would otherwise produce a backwards range that violates the
  // window_expires_at >= last_trigger_at constraint.
  it("tolerates an unsorted window", () => {
    const result = reconcileWindow([
      candidate({ id: "b", createdAt: at(10) }),
      candidate({ id: "a", createdAt: at(0) }),
    ]);

    expect(result.windowStartedAt).toEqual(at(0));
    expect(result.lastTriggerAt).toEqual(at(10));
  });

  it("refuses an empty window rather than inventing one", () => {
    expect(() => reconcileWindow([])).toThrow("empty window");
  });
});
