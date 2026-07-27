import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";
import {
  detectSpikes,
  rankCandidates,
  type ReelSnapshot,
} from "./spikeCore.js";

function point(
  day: string,
  total: number | null,
  overrides: Partial<FollowerDailyAddsPoint> = {},
): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: total,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
    ...overrides,
  };
}

/** N days of steady `net` adds ending the day before `fromDay` offset. */
function steady(count: number, net: number, startDay = 1): FollowerDailyAddsPoint[] {
  return Array.from({ length: count }, (_, i) =>
    point(`2026-07-${String(startDay + i).padStart(2, "0")}`, net),
  );
}

describe("detectSpikes", () => {
  it("flags a day well above the trailing median", () => {
    // 10 quiet days at +40, then +200 (5x the median, over the floor).
    const points = [...steady(10, 40), point("2026-07-11", 200)];
    const spikes = detectSpikes(points);
    expect(spikes.map((s) => s.day)).toEqual(["2026-07-11"]);
    expect(spikes[0]!.multiple).toBeCloseTo(5, 1);
    expect(spikes[0]!.net).toBe(200);
    expect(spikes[0]!.baselineMedian).toBe(40);
  });

  it("ignores a day that clears the ratio but not the absolute floor", () => {
    // Quiet period: median 4, so +30 is 7.5x — but 30 < the 40 floor.
    const points = [...steady(10, 4), point("2026-07-11", 30)];
    expect(detectSpikes(points)).toEqual([]);
  });

  it("ignores a day that clears the floor but not the ratio", () => {
    // median 40, +80 is only 2.0x — below the 2.5x bar.
    const points = [...steady(10, 40), point("2026-07-11", 80)];
    expect(detectSpikes(points)).toEqual([]);
  });

  it("treats the thresholds as inclusive at the exact boundary", () => {
    // median 40 -> 2.5x is exactly 100, which is also over the floor.
    const points = [...steady(10, 40), point("2026-07-11", 100)];
    expect(detectSpikes(points).map((s) => s.day)).toEqual(["2026-07-11"]);
  });

  it("stays silent until enough history exists to have a baseline", () => {
    // Only 5 prior days — cannot judge what "usual" is yet.
    const points = [...steady(5, 40), point("2026-07-06", 500)];
    expect(detectSpikes(points)).toEqual([]);
  });

  it("uses the median so one huge day cannot inflate its own baseline", () => {
    // A mean would be dragged up by the +900; the median stays at 40.
    const points = [...steady(9, 40), point("2026-07-10", 900), point("2026-07-11", 150)];
    const spikes = detectSpikes(points);
    expect(spikes.map((s) => s.day)).toEqual(["2026-07-10", "2026-07-11"]);
    expect(spikes[1]!.baselineMedian).toBe(40);
  });

  it("never flags gap, stale or pending days — they have no measured total", () => {
    const points = [
      ...steady(10, 40),
      point("2026-07-11", null, { basis: "stale", total: null, spanDays: null }),
      point("2026-07-12", null, { basis: "no_snapshot", total: null, spanDays: null }),
      point("2026-07-13", null, { basis: "pending", total: null, spanDays: null }),
      point("2026-07-14", null, { basis: "no_prior_day", total: null, spanDays: null }),
    ];
    expect(detectSpikes(points)).toEqual([]);
  });

  it("can flag a multi_day_span day, which is a real measurement", () => {
    const points = [
      ...steady(10, 40),
      point("2026-07-11", 200, { basis: "multi_day_span", spanDays: 2 }),
    ];
    expect(detectSpikes(points).map((s) => s.day)).toEqual(["2026-07-11"]);
  });

  it("ignores negative and zero days rather than reading them as spikes", () => {
    const points = [...steady(10, 40), point("2026-07-11", -80), point("2026-07-12", 0)];
    expect(detectSpikes(points)).toEqual([]);
  });

  it("returns an empty list for an empty series", () => {
    expect(detectSpikes([])).toEqual([]);
  });
});

describe("rankCandidates", () => {
  const WINDOW_START = Date.parse("2026-07-22T00:00:00Z");
  const WINDOW_END = Date.parse("2026-07-24T23:59:59Z");

  function snap(mediaId: string, iso: string, reach: number): ReelSnapshot {
    return { mediaId, capturedAt: Date.parse(iso), reach };
  }

  it("ranks reels by reach gained inside the window and shares out the total", () => {
    const got = rankCandidates(
      [
        snap("a", "2026-07-21T18:00:00Z", 1000), // baseline
        snap("a", "2026-07-24T18:00:00Z", 5000), // +4000
        snap("b", "2026-07-21T18:00:00Z", 500),
        snap("b", "2026-07-24T18:00:00Z", 1500), // +1000
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates.map((c) => c.mediaId)).toEqual(["a", "b"]);
    expect(got.candidates[0]!.reachGained).toBe(4000);
    expect(got.candidates[0]!.sharePct).toBe(80);
    expect(got.candidates[1]!.sharePct).toBe(20);
    expect(got.totalReachGained).toBe(5000);
  });

  it("keeps at most three candidates", () => {
    const snaps: ReelSnapshot[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) {
      snaps.push(snap(id, "2026-07-21T18:00:00Z", 0));
      snaps.push(snap(id, "2026-07-24T18:00:00Z", 100));
    }
    expect(rankCandidates(snaps, WINDOW_START, WINDOW_END).candidates).toHaveLength(3);
  });

  it("measures growth from the pre-window baseline, not the first in-window reading", () => {
    // The bug this guards: using the first in-window snapshot as the baseline
    // credits a reel with its whole lifetime reach. Here the reel was already at
    // 100000 before the window and only gained 200 during it.
    const got = rankCandidates(
      [
        snap("viral", "2026-07-21T20:00:00Z", 100000),
        snap("viral", "2026-07-23T00:00:00Z", 100100),
        snap("viral", "2026-07-24T00:00:00Z", 100200),
        snap("small", "2026-07-21T20:00:00Z", 10),
        snap("small", "2026-07-24T00:00:00Z", 5010),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates[0]!.mediaId).toBe("small");
    expect(got.candidates.find((c) => c.mediaId === "viral")!.reachGained).toBe(200);
  });

  it("excludes a reel whose snapshots all predate the window", () => {
    const got = rankCandidates(
      [
        snap("stalled", "2026-07-13T01:00:00Z", 2000),
        snap("stalled", "2026-07-13T13:00:00Z", 113000),
        snap("live", "2026-07-21T18:00:00Z", 100),
        snap("live", "2026-07-24T18:00:00Z", 900),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates.map((c) => c.mediaId)).toEqual(["live"]);
  });

  it("accepts a baseline captured just after the window opens", () => {
    // A reel posted the evening before gets its first snapshot minutes past
    // midnight. A strict at-or-before rule dropped the real top candidate.
    const got = rankCandidates(
      [
        snap("fresh", "2026-07-22T00:11:00Z", 105),
        snap("fresh", "2026-07-24T18:00:00Z", 50105),
        snap("other", "2026-07-21T18:00:00Z", 10),
        snap("other", "2026-07-24T18:00:00Z", 110),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates[0]!.mediaId).toBe("fresh");
    expect(got.candidates[0]!.reachGained).toBe(50000);
  });

  it("does not treat a large first in-window reading as a zero baseline", () => {
    // Inside the grace period but already at 40000 — that is an existing reel
    // being re-snapshotted, not a fresh post, so it must be skipped.
    const got = rankCandidates(
      [
        snap("ambiguous", "2026-07-22T02:00:00Z", 40000),
        snap("ambiguous", "2026-07-24T18:00:00Z", 41000),
        snap("clean", "2026-07-21T18:00:00Z", 10),
        snap("clean", "2026-07-24T18:00:00Z", 110),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates.map((c) => c.mediaId)).toEqual(["clean"]);
  });

  it("labels confidence from the top reel's share of window reach", () => {
    // Confidence keys on whichever reel LEADS, so these are split across three
    // reels to control the leader's share precisely.
    const split = (a: number, b: number, c: number) =>
      rankCandidates(
        [
          snap("a", "2026-07-21T18:00:00Z", 0),
          snap("a", "2026-07-24T18:00:00Z", a),
          snap("b", "2026-07-21T18:00:00Z", 0),
          snap("b", "2026-07-24T18:00:00Z", b),
          snap("c", "2026-07-21T18:00:00Z", 0),
          snap("c", "2026-07-24T18:00:00Z", c),
        ],
        WINDOW_START,
        WINDOW_END,
      ).confidence;

    expect(split(800, 100, 100)).toBe("high"); // leader 80%
    expect(split(500, 300, 200)).toBe("high"); // leader exactly 50% — inclusive
    expect(split(400, 300, 300)).toBe("medium"); // leader 40%
    expect(split(250, 250, 500)).toBe("high"); // c leads at 50%
    expect(split(200, 200, 200)).toBe("medium"); // three-way tie, leader 33%
    expect(split(100, 100, 100)).toBe("medium"); // still 33% each
  });

  it("reports low confidence when no reel owns even a quarter of the window", () => {
    // Five reels at 20% each — nothing is isolable, which is the honest answer.
    const snaps: ReelSnapshot[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) {
      snaps.push(snap(id, "2026-07-21T18:00:00Z", 0));
      snaps.push(snap(id, "2026-07-24T18:00:00Z", 100));
    }
    expect(rankCandidates(snaps, WINDOW_START, WINDOW_END).confidence).toBe("low");
  });

  it("reports low confidence and no candidates when nothing is attributable", () => {
    const got = rankCandidates([], WINDOW_START, WINDOW_END);
    expect(got.candidates).toEqual([]);
    expect(got.confidence).toBe("low");
    expect(got.totalReachGained).toBe(0);
  });

  it("ignores reels that lost reach rather than showing negative shares", () => {
    const got = rankCandidates(
      [
        snap("down", "2026-07-21T18:00:00Z", 500),
        snap("down", "2026-07-24T18:00:00Z", 400),
        snap("up", "2026-07-21T18:00:00Z", 10),
        snap("up", "2026-07-24T18:00:00Z", 110),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates.map((c) => c.mediaId)).toEqual(["up"]);
    expect(got.candidates[0]!.sharePct).toBe(100);
  });

  it("treats a null reach as unusable rather than zero", () => {
    const got = rankCandidates(
      [
        { mediaId: "n", capturedAt: Date.parse("2026-07-21T18:00:00Z"), reach: null },
        { mediaId: "n", capturedAt: Date.parse("2026-07-24T18:00:00Z"), reach: 900 },
        snap("ok", "2026-07-21T18:00:00Z", 10),
        snap("ok", "2026-07-24T18:00:00Z", 110),
      ],
      WINDOW_START,
      WINDOW_END,
    );
    expect(got.candidates.map((c) => c.mediaId)).toEqual(["ok"]);
  });
});
