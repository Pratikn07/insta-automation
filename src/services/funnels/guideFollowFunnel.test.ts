import { describe, expect, it } from "vitest";
import {
  COHORT_SQL,
  GUIDE_FOLLOW_MIN_SAMPLE,
  summarizeGuideFollow,
  type GuideFollowRow,
} from "./guideFollowFunnel.js";

const WINDOW = { from: "2026-07-15T00:00:00.000Z", to: "2026-08-14T00:00:00.000Z" };

function row(over: Partial<GuideFollowRow> = {}): GuideFollowRow {
  return {
    conversationId: Math.random().toString(36).slice(2),
    igUserId: "ig_1",
    enteredAt: new Date("2026-07-20T00:00:00.000Z"),
    entryPath: "comment",
    state: "completed",
    gateSent: true,
    doneReceived: false,
    followRequiredCount: 0,
    guideDelivered: false,
    deliveredToNonFollower: false,
    wasRedelivery: false,
    rechecked: false,
    followsNow: null,
    followThrough: null,
    ...over,
  };
}

function summarize(rows: GuideFollowRow[], minSample = GUIDE_FOLLOW_MIN_SAMPLE) {
  return summarizeGuideFollow(rows, WINDOW, minSample);
}

describe("summarizeGuideFollow", () => {
  it("counts an empty cohort without dividing by zero", () => {
    const s = summarize([]);
    expect(s.cohortSize).toBe(0);
    expect(s.stages[0].count).toBe(0);
    expect(s.stages[0].ofEntryPct).toBeNull();
    expect(s.followGateConversion.pct).toBeNull();
  });

  it("counts each conversation once no matter how many times we asked them to follow", () => {
    // The whole reason stages are booleans: markGated re-arms on every reply, so
    // one stubborn non-follower emits follow_required repeatedly. Counting
    // events instead of conversations would show 4 people where there is one.
    const s = summarize([row({ followRequiredCount: 4, guideDelivered: false })]);
    expect(s.cohortSize).toBe(1);
    expect(s.stages.find((x) => x.key === "replied")?.count).toBe(1);
    expect(s.followGateConversion.denominator).toBe(1);
  });

  it("reports follow-gate conversion over wall-hitters only", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ followRequiredCount: 1, guideDelivered: true })),
      ...Array.from({ length: 7 }, () => row({ followRequiredCount: 1, guideDelivered: false })),
      // Express lane — already following, never saw the wall. Must not dilute.
      ...Array.from({ length: 5 }, () => row({ guideDelivered: true, doneReceived: true })),
    ];
    const s = summarize(rows);
    expect(s.followGateConversion.numerator).toBe(3);
    expect(s.followGateConversion.denominator).toBe(10);
    expect(s.followGateConversion.pct).toBe(30);
    expect(s.stuckAtWall).toBe(7);
    expect(s.expressLane).toBe(5);
  });

  it("leads with the reply step, which is where the funnel actually loses people", () => {
    // The funnel was built assuming the follow gate was the story. The first
    // real run said otherwise, so the headline is declared per funnel and
    // points at gateSent -> replied.
    const rows = [
      ...Array.from({ length: 6 }, () => row({ gateSent: true, doneReceived: true, guideDelivered: true })),
      ...Array.from({ length: 14 }, () => row({ gateSent: true, doneReceived: false })),
    ];
    const s = summarize(rows);
    expect(s.headline.label).toBe("Reply rate");
    expect(s.headline.rate.numerator).toBe(6);
    expect(s.headline.rate.denominator).toBe(20);
    expect(s.headline.rate.pct).toBe(30);
  });

  it("suppresses a rate below the minimum sample and says so", () => {
    const rows = [
      row({ followRequiredCount: 1, guideDelivered: true }),
      row({ followRequiredCount: 1, guideDelivered: false }),
      row({ followRequiredCount: 1, guideDelivered: false }),
    ];
    const s = summarize(rows);
    expect(s.followGateConversion.denominator).toBe(3);
    expect(s.followGateConversion.belowMinSample).toBe(true);
    // 1-of-3 must never render as "33%".
    expect(s.followGateConversion.pct).toBeNull();
    expect(s.followGateConversion.numerator).toBe(1);
  });

  it("computes step conversion against the previous stage, not the entry stage", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({ gateSent: true, doneReceived: true, guideDelivered: true })),
      ...Array.from({ length: 10 }, () => row({ gateSent: true, doneReceived: false })),
    ];
    const s = summarize(rows);
    const replied = s.stages.find((x) => x.key === "replied")!;
    expect(replied.count).toBe(10);
    // 10 of the 20 who got a gate — the step — even though it is also 50% of entry.
    expect(replied.ofPrevPct).toBe(50);
    expect(replied.ofEntryPct).toBe(50);
  });

  it("never reports a step conversion across a stage people can skip", () => {
    // Someone already following goes straight to the guide without a gate or a
    // reply. Dividing "got the guide" by "replied" would print 150%, which is
    // the kind of number that makes a marketer stop trusting the whole page.
    const rows = [
      ...Array.from({ length: 4 }, () => row({ gateSent: false, doneReceived: false, guideDelivered: true })),
      row({ gateSent: true, doneReceived: true, guideDelivered: true }),
    ];
    const s = summarize(rows);
    const replied = s.stages.find((x) => x.key === "replied")!;
    const delivered = s.stages.find((x) => x.key === "guideDelivered")!;
    expect(replied.count).toBe(1);
    expect(delivered.count).toBe(5);
    // Would have been 500%. Suppressed instead, with the reason in `definition`.
    expect(delivered.ofPrevPct).toBeNull();
    expect(delivered.ofEntryPct).toBe(100);
    expect(delivered.bypassable).toBe(true);
  });

  it("only counts a follow as measured when the guide actually went out", () => {
    // Someone who never got the guide cannot be a guide-attributed follow, even
    // if they happen to follow us now.
    const rows = [
      row({ guideDelivered: false, rechecked: true, followsNow: true }),
      row({ guideDelivered: true, rechecked: true, followsNow: true }),
    ];
    const s = summarize(rows);
    expect(s.stages.find((x) => x.key === "followingMeasured")?.count).toBe(1);
  });

  it("scopes retention to conversations that got a second reading", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row({ guideDelivered: true, followThrough: true })),
      row({ guideDelivered: true, followThrough: false }),
      // Not yet re-measured — must not count as churn.
      ...Array.from({ length: 20 }, () => row({ guideDelivered: true, followThrough: null })),
    ];
    const s = summarize(rows);
    expect(s.retention.denominator).toBe(7);
    expect(s.retention.numerator).toBe(6);
    expect(s.retention.pct).toBe(85.7);
  });

  it("splits by entry path so the DM express lane cannot hide the comment funnel", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => row({ entryPath: "comment", guideDelivered: false })),
      ...Array.from({ length: 6 }, () => row({ entryPath: "dm", guideDelivered: true })),
    ];
    const s = summarize(rows);
    const comment = s.byEntryPath.find((p) => p.entryPath === "comment")!;
    const dm = s.byEntryPath.find((p) => p.entryPath === "dm")!;
    expect(comment.entered).toBe(8);
    expect(comment.deliveryRate.pct).toBe(0);
    expect(dm.entered).toBe(6);
    expect(dm.deliveryRate.pct).toBe(100);
  });

  it("buckets wall-hitters by how many times they were asked", () => {
    const rows = [
      row({ followRequiredCount: 1, guideDelivered: true }),
      row({ followRequiredCount: 1, guideDelivered: false }),
      row({ followRequiredCount: 3, guideDelivered: false }),
      row({ followRequiredCount: 2, guideDelivered: true }),
    ];
    const s = summarize(rows);
    expect(s.askDistribution).toEqual([
      { asks: 1, conversations: 2, cleared: 1 },
      { asks: 2, conversations: 1, cleared: 1 },
      { asks: 3, conversations: 1, cleared: 0 },
    ]);
  });

  it("exposes the Home tile's cohort and how much of it is redelivery", () => {
    // The claim under test: post-follow-gate, a delivery to a confirmed
    // non-follower can essentially only be a redelivery. This surfaces the
    // composition instead of asserting it.
    const rows = [
      row({ guideDelivered: true, deliveredToNonFollower: true, wasRedelivery: true }),
      row({ guideDelivered: true, deliveredToNonFollower: true, wasRedelivery: true }),
      row({ guideDelivered: true, deliveredToNonFollower: false }),
    ];
    const s = summarize(rows);
    expect(s.homeTileCohort).toEqual({ deliveredToNonFollower: 2, ofWhichRedelivery: 2 });
  });

  it("clamps a numerator that exceeds its denominator instead of reporting >100%", () => {
    const s = summarize([]);
    expect(s.retention.numerator).toBeLessThanOrEqual(s.retention.denominator);
  });
});

describe("guide-follow cohort", () => {
  it("leaves link guides out of the gated funnel", () => {
    expect(COHORT_SQL).toContain("COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'");
  });
});
