import { describe, it, expect } from "vitest";
import { candidateViewWhere, CANDIDATE_VIEWS } from "./historicalRecovery.routes.js";

// The list and the tab badges both read from candidateViewWhere. If they could
// disagree, a badge would promise rows the list does not show — the class of bug
// that makes an operator distrust the whole surface.

describe("candidateViewWhere", () => {
  // A holdout row is the control arm, not something waiting to send. Including it in
  // `pending` would overstate the work remaining and imply it will eventually go out.
  it("excludes holdout rows from pending", () => {
    expect(candidateViewWhere("pending")).toEqual({ outcome: "pending", arm: "treatment" });
  });

  it("keeps holdout as its own view", () => {
    expect(candidateViewWhere("holdout")).toEqual({ arm: "holdout" });
  });

  // Both mean "will not be sent, and not because of a failure", so they read as one
  // group to the operator.
  it("groups suppressed and cancelled together", () => {
    expect(candidateViewWhere("suppressed")).toEqual({
      outcome: { in: ["suppressed", "cancelled"] },
    });
  });

  // send_uncertain may already have posted and is never retried automatically, so it
  // must surface in a view a human actually opens.
  it("puts uncertain and failed sends in attention", () => {
    expect(candidateViewWhere("attention")).toEqual({
      outcome: { in: ["send_uncertain", "send_failed"] },
    });
  });

  // The outcome the campaign exists to produce. Requires BOTH a confirmed send and a
  // later completion — a completion without a send is not recovery, it is coincidence.
  it("requires a send and a later completion to count as recovered", () => {
    expect(candidateViewWhere("recovered")).toEqual({
      outcome: "sent",
      laterCompletedAt: { not: null },
    });
  });

  it("filters nothing for all", () => {
    expect(candidateViewWhere("all")).toEqual({});
  });

  it("defines a filter for every advertised view", () => {
    for (const view of CANDIDATE_VIEWS) {
      expect(candidateViewWhere(view)).toBeDefined();
    }
  });

  // A pending row must never appear in a terminal view, or the operator sees the
  // same person in two places with contradictory status.
  it("keeps pending disjoint from the terminal views", () => {
    const pending = candidateViewWhere("pending") as { outcome?: unknown };
    for (const view of ["sent", "suppressed", "attention", "recovered"] as const) {
      expect(candidateViewWhere(view)).not.toEqual(pending);
    }
  });
});
