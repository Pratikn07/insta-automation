import { describe, expect, it, vi } from "vitest";
import { createExperimentSummarizer } from "./experimentSummary.js";

type Row = {
  cohort: string;
  status: string;
  suppressionReason: string | null;
  _count: number;
};

function make(rows: Row[]) {
  return createExperimentSummarizer({
    groupRecoveryReminders: vi.fn().mockResolvedValue(rows),
    experimentEndsAt: () => "2026-08-21T21:45:00.000Z",
    postExperimentEnabled: () => false,
  });
}

/**
 * The real shape, read from production on 2026-08-18.
 *
 * Copied rather than simplified because the simplification is what hid the bug:
 * treatment reaches this table in six states beyond `sent`, and control rows carry
 * a `suppression_reason` of their own (`completed`) that must NOT be mistaken for a
 * skip. A tidy four-row fixture agreed with the code and disagreed with the table.
 */
const ROWS: Row[] = [
  { cohort: "treatment", status: "sent", suppressionReason: null, _count: 594 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "seen", _count: 531 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "inbound_reply", _count: 441 },
  {
    cohort: "treatment",
    status: "suppressed",
    suppressionReason: "audience_out_of_market",
    _count: 269,
  },
  { cohort: "control", status: "control", suppressionReason: "completed", _count: 196 },
  { cohort: "control", status: "control", suppressionReason: null, _count: 195 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "person_cooldown", _count: 56 },
  { cohort: "treatment", status: "waiting", suppressionReason: null, _count: 54 },
  { cohort: "treatment", status: "send_failed", suppressionReason: null, _count: 12 },
  { cohort: "not_applicable", status: "tracking_unavailable", suppressionReason: null, _count: 4 },
  { cohort: "control", status: "control", suppressionReason: "completed_elsewhere", _count: 4 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "attachment", _count: 2 },
  { cohort: "treatment", status: "send_uncertain", suppressionReason: null, _count: 1 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "reaction", _count: 1 },
];

const TOTAL_PEOPLE = ROWS.reduce((sum, r) => sum + r._count, 0);

describe("recovery reminder timing summary", () => {
  it("counts each arm in whole people", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");

    expect(summary.kind).toBe("running");
    if (summary.kind !== "running") throw new Error("expected running");
    expect(summary.arms).toEqual([
      { key: "treatment", label: "Got a reminder", people: 594 },
      { key: "control", label: "Got nothing", people: 395 },
    ]);
  });

  // A control row's own suppression_reason ("completed") records that they got the
  // guide anyway. That is the outcome, not a reason they were skipped — counting it
  // as a skip would delete most of the control arm.
  it("keeps every control person in the control arm whatever their reason says", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.arms[1]).toEqual({ key: "control", label: "Got nothing", people: 395 });
    const skipReasons = summary.notCounted.map((n) => n.reason);
    expect(skipReasons).not.toContain("completed");
    expect(skipReasons).not.toContain("completed_elsewhere");
  });

  // Suppressed people are neither arm: they were never reminded and were never a
  // control. Folding them in either direction would overstate that side.
  it("reports the skipped separately, with why, biggest first", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.notCounted).toEqual([
      { reason: "They opened it themselves", people: 531 },
      { reason: "They replied, so they saw it", people: 441 },
      { reason: "Outside your audience", people: 269 },
      { reason: "Reminded too recently", people: 56 },
      { reason: "Waiting to be posted", people: 54 },
      { reason: "The reminder could not be posted", people: 12 },
      { reason: "We could not track it", people: 4 },
      { reason: "They sent something back", people: 2 },
      { reason: "We could not confirm it posted", people: 1 },
      { reason: "They reacted to it", people: 1 },
    ]);
  });

  /**
   * The guard that matters most.
   *
   * An earlier version of this counted only `sent` as treatment and only
   * `suppressed` as skipped, which silently dropped 67 real people — the ones
   * waiting, the twelve that failed, the one we could not confirm — plus four whose
   * tracking was unavailable. The page then showed 594 and 1,300 out of 2,360 and
   * looked complete. Every person is in exactly one bucket or this fails.
   */
  it("accounts for every person, in exactly one bucket", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    const inArms = summary.arms.reduce((sum, a) => sum + a.people, 0);
    const skipped = summary.notCounted.reduce((sum, n) => sum + n.people, 0);
    expect(inArms + skipped).toBe(TOTAL_PEOPLE);
  });

  // A status nobody has produced yet must still be nameable, or the first one that
  // appears in production disappears from the arithmetic instead of being seen.
  it("names an unfamiliar status rather than dropping it", async () => {
    const summary = await make([
      { cohort: "treatment", status: "sent", suppressionReason: null, _count: 10 },
      { cohort: "treatment", status: "cancelled", suppressionReason: null, _count: 3 },
      { cohort: "treatment", status: "sending", suppressionReason: null, _count: 2 },
    ]).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    const skipped = summary.notCounted.reduce((sum, n) => sum + n.people, 0);
    expect(skipped).toBe(5);
    expect(summary.notCounted.map((n) => n.reason)).toEqual([
      "Cancelled before posting",
      "Being posted now",
    ]);
  });

  it("says when it ends and what happens then", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.endsAt).toBe("2026-08-21T21:45:00.000Z");
    expect(summary.whenItEnds).toMatch(/reminders stop/i);
  });

  it("says the opposite when post-experiment sending is on", async () => {
    const s = createExperimentSummarizer({
      groupRecoveryReminders: vi.fn().mockResolvedValue(ROWS),
      experimentEndsAt: () => "2026-08-21T21:45:00.000Z",
      postExperimentEnabled: () => true,
    });
    const summary = await s.summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.whenItEnds).toMatch(/keep going/i);
  });

  it("renders no percentage anywhere", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");

    expect(JSON.stringify(summary)).not.toMatch(/%/);
  });
});

describe("a not-started experiment", () => {
  it("returns what it would compare and what is blocking it, not zeroes", async () => {
    const summary = await make([]).summarize("guide-delivery-rollout");

    expect(summary).toEqual({
      kind: "not_started",
      wouldCompare:
        "Served by the newer delivery path, which tracks each step separately. versus Served by the older path, which is what everyone gets today.",
      blocker:
        "The rollout is at zero, so nobody is on the newer path yet. Raising it starts the comparison.",
    });
  });

  it("does not query anything for an experiment that never ran", async () => {
    const summarizer = make([]);
    await summarizer.summarize("cold-message-test");

    expect(summarizer.deps.groupRecoveryReminders).not.toHaveBeenCalled();
  });
});

describe("an unknown key", () => {
  it("throws rather than returning an empty summary", async () => {
    await expect(make([]).summarize("nope")).rejects.toThrow(/nope/);
  });
});
