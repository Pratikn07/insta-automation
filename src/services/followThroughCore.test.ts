import { describe, expect, it } from "vitest";
import {
  FOLLOW_THROUGH_MIN_DAYS,
  MIN_RETENTION_SAMPLE,
  isFollowThroughDue,
  summarizeRetention,
} from "./followThroughCore.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-29T12:00:00.000Z");

const daysAgo = (n: number) => new Date(NOW - n * DAY);

describe("isFollowThroughDue", () => {
  it("waits until the conversation is old enough for a follow to have decayed", () => {
    // A follow measured 3 days after delivery says nothing about whether it
    // sticks. The whole point is letting time pass.
    expect(isFollowThroughDue(daysAgo(5), true, null, NOW)).toBe(false);
  });

  it("is due once past the minimum age", () => {
    expect(isFollowThroughDue(daysAgo(FOLLOW_THROUGH_MIN_DAYS + 1), true, null, NOW)).toBe(true);
  });

  it("treats the exact boundary as not yet due", () => {
    // Same conservative choice as the token refresher's 24h floor: one extra
    // tick costs nothing, a premature reading is misleading.
    expect(isFollowThroughDue(daysAgo(FOLLOW_THROUGH_MIN_DAYS), true, null, NOW)).toBe(false);
  });

  it("only follows up on users who actually converted", () => {
    // Someone who never followed has nothing to un-follow. Re-checking them
    // would burn Graph calls to learn nothing.
    expect(isFollowThroughDue(daysAgo(40), false, null, NOW)).toBe(false);
    expect(isFollowThroughDue(daysAgo(40), null, null, NOW)).toBe(false);
  });

  it("does not re-check someone already followed up on", () => {
    expect(isFollowThroughDue(daysAgo(40), true, daysAgo(2), NOW)).toBe(false);
  });

  it("is not due when the conversation has no completion timestamp", () => {
    // Legacy rows predate completedAt; without it there is no clock to measure.
    expect(isFollowThroughDue(null, true, null, NOW)).toBe(false);
  });
});

describe("summarizeRetention", () => {
  it("reports the share of converts still following", () => {
    const r = summarizeRetention(23, 21);
    expect(r.retentionPct).toBe(91.3);
    expect(r.unfollowed).toBe(2);
  });

  it("stays null below the minimum sample rather than printing a loud percentage", () => {
    // With 3 checked, one unfollow reads as "33% churn" — a number that would
    // drive a decision the sample cannot support.
    const r = summarizeRetention(MIN_RETENTION_SAMPLE - 1, 2);
    expect(r.retentionPct).toBeNull();
  });

  it("reports at exactly the minimum sample", () => {
    expect(summarizeRetention(MIN_RETENTION_SAMPLE, MIN_RETENTION_SAMPLE).retentionPct).toBe(100);
  });

  it("handles nobody checked yet without dividing by zero", () => {
    const r = summarizeRetention(0, 0);
    expect(r.retentionPct).toBeNull();
    expect(r.unfollowed).toBe(0);
  });

  it("never reports negative churn if the inputs disagree", () => {
    // Defensive: stillFollowing should never exceed checked, but a race between
    // two queries must not surface as "-1 unfollowed".
    expect(summarizeRetention(5, 7).unfollowed).toBe(0);
  });

  it("reports total churn honestly when everyone left", () => {
    const r = summarizeRetention(10, 0);
    expect(r.retentionPct).toBe(0);
    expect(r.unfollowed).toBe(10);
  });
});
