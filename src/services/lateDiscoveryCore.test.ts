import { describe, expect, it } from "vitest";
import {
  computeLateDiscovery,
  summarizeLateDiscovery,
  type LateDiscoveryResult,
  type LateDiscoverySnapshot,
} from "./lateDiscoveryCore.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const POSTED = Date.parse("2026-07-01T12:00:00.000Z");
const NOW = POSTED + 40 * DAY;

function snap(
  offsetFromPost: number,
  views: number | null,
  overrides: Partial<LateDiscoverySnapshot> = {},
): LateDiscoverySnapshot {
  return {
    capturedAt: POSTED + offsetFromPost,
    views,
    reach: 10_000,
    shares: null,
    saved: null,
    ...overrides,
  };
}

/** A healthy series: a reading at day seven and a much later lifetime reading. */
function healthySeries(daySevenViews: number, lifetimeViews: number): LateDiscoverySnapshot[] {
  return [
    snap(1 * DAY, Math.round(daySevenViews * 0.6)),
    snap(7 * DAY, daySevenViews),
    snap(30 * DAY, lifetimeViews),
  ];
}

describe("computeLateDiscovery", () => {
  it("reports the share of lifetime views accrued after day seven", () => {
    const result = computeLateDiscovery("m1", POSTED, healthySeries(8_000, 10_000), NOW);

    expect(result.gap).toBeNull();
    expect(result.ldsPct).toBe(20); // (10000 - 8000) / 10000
    expect(result.daySevenViews).toBe(8_000);
    expect(result.lifetimeViews).toBe(10_000);
    expect(result.daySevenGapHours).toBe(0);
  });

  it("takes lifetime from the newest snapshot regardless of array order", () => {
    const outOfOrder = [snap(30 * DAY, 10_000), snap(7 * DAY, 8_000), snap(1 * DAY, 4_000)];
    const result = computeLateDiscovery("m1", POSTED, outOfOrder, NOW);

    expect(result.lifetimeViews).toBe(10_000);
    expect(result.ldsPct).toBe(20);
  });

  it("uses the nearest real snapshot and never interpolates between two", () => {
    // Nothing lands on day seven exactly; day 6 is nearer than day 9.
    const series = [snap(6 * DAY, 8_000), snap(9 * DAY, 9_000), snap(30 * DAY, 10_000)];
    const result = computeLateDiscovery("m1", POSTED, series, NOW);

    expect(result.daySevenViews).toBe(8_000); // the day-6 reading, not a blend
    expect(result.daySevenGapHours).toBe(24);
  });

  it("accepts a snapshot exactly at the 36h tolerance and rejects one past it", () => {
    const atLimit = [snap(7 * DAY + 36 * HOUR, 8_000), snap(30 * DAY, 10_000)];
    expect(computeLateDiscovery("m1", POSTED, atLimit, NOW).gap).toBeNull();

    const pastLimit = [snap(7 * DAY + 37 * HOUR, 8_000), snap(30 * DAY, 10_000)];
    expect(computeLateDiscovery("m1", POSTED, pastLimit, NOW).gap).toBe("no_day_seven_snapshot");
  });

  it("withholds a reading for a reel too young to have a tail", () => {
    const result = computeLateDiscovery("m1", POSTED, healthySeries(8_000, 10_000), POSTED + 9 * DAY);

    expect(result.gap).toBe("too_young");
    expect(result.ldsPct).toBeNull();
  });

  it("withholds when no snapshot ever carried a views figure", () => {
    const series = [snap(7 * DAY, null), snap(30 * DAY, null)];
    const result = computeLateDiscovery("m1", POSTED, series, NOW);

    expect(result.gap).toBe("no_lifetime_snapshot");
  });

  it("withholds when there are no snapshots at all", () => {
    expect(computeLateDiscovery("m1", POSTED, [], NOW).gap).toBe("no_lifetime_snapshot");
  });

  it("ignores snapshots with null views when choosing the day-seven reading", () => {
    const series = [snap(7 * DAY, null), snap(6 * DAY, 8_000), snap(30 * DAY, 10_000)];
    const result = computeLateDiscovery("m1", POSTED, series, NOW);

    expect(result.daySevenViews).toBe(8_000);
    expect(result.daySevenGapHours).toBe(24);
  });

  it("suppresses below the reach floor and admits a reel exactly on it", () => {
    const thin = [
      snap(7 * DAY, 800, { reach: 499 }),
      snap(30 * DAY, 1_000, { reach: 499 }),
    ];
    expect(computeLateDiscovery("m1", POSTED, thin, NOW).gap).toBe("below_reach_floor");

    const onFloor = [
      snap(7 * DAY, 800, { reach: 500 }),
      snap(30 * DAY, 1_000, { reach: 500 }),
    ];
    expect(computeLateDiscovery("m1", POSTED, onFloor, NOW).ldsPct).toBe(20);
  });

  it("suppresses when the lifetime snapshot reports no reach at all", () => {
    const series = [snap(7 * DAY, 800, { reach: null }), snap(30 * DAY, 1_000, { reach: null })];
    expect(computeLateDiscovery("m1", POSTED, series, NOW).gap).toBe("below_reach_floor");
  });

  it("withholds rather than clamping when Meta revises lifetime views downward", () => {
    const regressed = [snap(7 * DAY, 10_000), snap(30 * DAY, 9_000)];
    const result = computeLateDiscovery("m1", POSTED, regressed, NOW);

    // A negative share is invalid data, not a small negative signal. Clamping to
    // zero would mix "no tail" with "bad reading".
    expect(result.gap).toBe("views_regressed");
    expect(result.ldsPct).toBeNull();
  });

  it("reads zero late discovery when the curve is flat after day seven", () => {
    const flat = [snap(7 * DAY, 10_000), snap(30 * DAY, 10_000)];
    const result = computeLateDiscovery("m1", POSTED, flat, NOW);

    expect(result.gap).toBeNull();
    expect(result.ldsPct).toBe(0);
  });

  it("computes sends and saves per reach, and leaves them null when unmeasured", () => {
    const series = [
      snap(7 * DAY, 8_000),
      snap(30 * DAY, 10_000, { reach: 10_000, shares: 26, saved: 34 }),
    ];
    const result = computeLateDiscovery("m1", POSTED, series, NOW);

    expect(result.sendsPerReachPct).toBe(0.26);
    expect(result.savesPerReachPct).toBe(0.34);

    const unmeasured = computeLateDiscovery("m1", POSTED, healthySeries(8_000, 10_000), NOW);
    expect(unmeasured.sendsPerReachPct).toBeNull();
    expect(unmeasured.savesPerReachPct).toBeNull();
  });

  it("understates a reel whose snapshots stopped early — the silent one-way error", () => {
    // 35 of 185 live reels had gone stale on 2026-08-23, one posted only nine
    // days earlier. A stale lifetime reading understates the tail, so LDS reads
    // LOW. The reading still carries lifetimeAt so a caller can see its age and
    // refuse to trust it.
    const stale = [snap(7 * DAY, 8_000), snap(8 * DAY, 8_100)];
    const result = computeLateDiscovery("m1", POSTED, stale, NOW);

    expect(result.ldsPct).toBe(1.2);
    expect(result.lifetimeAt).toBe(POSTED + 8 * DAY);
    expect(NOW - result.lifetimeAt!).toBeGreaterThan(30 * DAY);
  });
});

describe("summarizeLateDiscovery", () => {
  function reading(ldsPct: number): LateDiscoveryResult {
    return {
      mediaId: `m${ldsPct}`,
      ldsPct,
      gap: null,
      daySevenViews: 8_000,
      daySevenAt: POSTED + 7 * DAY,
      daySevenGapHours: 0,
      lifetimeViews: 10_000,
      lifetimeReach: 10_000,
      lifetimeAt: POSTED + 30 * DAY,
      sendsPerReachPct: null,
      savesPerReachPct: null,
    };
  }

  function gap(kind: LateDiscoveryResult["gap"]): LateDiscoveryResult {
    return { ...reading(0), ldsPct: null, gap: kind };
  }

  it("summarizes the distribution once enough readings survive", () => {
    const results = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(reading);
    const { summary } = summarizeLateDiscovery(results);

    expect(summary).not.toBeNull();
    expect(summary!.n).toBe(10);
    expect(summary!.medianPct).toBe(5.5);
    expect(summary!.p10Pct).toBe(1);
    expect(summary!.p90Pct).toBe(9);
  });

  it("withholds the summary below the minimum sample, still reporting the gaps", () => {
    const results = [
      reading(10),
      reading(20),
      gap("too_young"),
      gap("too_young"),
      gap("below_reach_floor"),
    ];
    const { summary, gaps } = summarizeLateDiscovery(results);

    expect(summary).toBeNull();
    expect(gaps.too_young).toBe(2);
    expect(gaps.below_reach_floor).toBe(1);
    expect(gaps.no_day_seven_snapshot).toBe(0);
  });

  it("counts every gap reason separately so the cost of the sample is visible", () => {
    const results = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(reading),
      gap("no_day_seven_snapshot"),
      gap("no_lifetime_snapshot"),
      gap("views_regressed"),
    ];
    const { summary, gaps } = summarizeLateDiscovery(results);

    expect(summary!.n).toBe(8);
    expect(gaps.no_day_seven_snapshot).toBe(1);
    expect(gaps.no_lifetime_snapshot).toBe(1);
    expect(gaps.views_regressed).toBe(1);
  });

  it("returns no summary when every reel is gapped", () => {
    const { summary, gaps } = summarizeLateDiscovery([gap("too_young"), gap("too_young")]);

    expect(summary).toBeNull();
    expect(gaps.too_young).toBe(2);
  });
});

// Real snapshot series from the live account, read 2026-08-23 over the read-only
// Supabase connection. Each expectation is the figure an independent SQL
// implementation produced across all 79 measurable reels, so these pin the TS
// selection rules (nearest-within-tolerance, newest-lifetime) to the same answer
// the baseline was computed with. Snapshots either side of the day-seven target
// are included so the nearest-pick is genuinely exercised; the full series run to
// ~190 rows each.
describe("verified against live snapshot series (2026-08-23)", () => {
  const LIVE_NOW = 1787492701722;

  function live(rows: Array<[number, number, number]>): LateDiscoverySnapshot[] {
    return rows.map(([capturedAt, views, reach]) => ({
      capturedAt,
      views,
      reach,
      shares: null,
      saved: null,
    }));
  }

  it("matches SQL on the account's strongest tail (41.8%)", () => {
    const result = computeLateDiscovery(
      "18141916180533282",
      1782266413000,
      live([
        [1782789137689, 169207, 78412], // first snapshot, ~day 6.0
        [1782857330885, 172280, 79821], // day 6.84 — the nearer-but-earlier candidate
        [1782878933062, 173110, 80191], // day 7.09 — the pick
        [1787492701722, 297509, 128407], // lifetime
      ]),
      LIVE_NOW,
    );

    expect(result.ldsPct).toBe(41.8);
    expect(result.daySevenViews).toBe(173110);
    expect(result.daySevenGapHours).toBe(2.1);
    expect(result.lifetimeReach).toBe(128407);
  });

  it("matches SQL on a reel at the account median (8.9%)", () => {
    const result = computeLateDiscovery(
      "18342885586221177",
      1784157001000,
      live([
        [1784164016550, 397, 207],
        [1784747232817, 4020, 1928], // day 6.83
        [1784768831929, 4081, 1972], // day 7.08 — the pick
        [1787492638218, 4479, 2193], // lifetime
      ]),
      LIVE_NOW,
    );

    expect(result.ldsPct).toBe(8.9);
    expect(result.daySevenViews).toBe(4081);
  });

  it("matches SQL on a reel with no tail at all (0.0%)", () => {
    // Views plateau at 1370 within three days of posting and never move again.
    // This is the shape a purely recommended reel makes, and it must read as a
    // measured zero — not as a gap.
    const result = computeLateDiscovery(
      "18121552463499034",
      1786572009000,
      live([
        [1786592890216, 954, 548],
        [1787139642326, 1370, 846], // day 6.57
        [1787178375461, 1370, 846], // day 7.02 — the pick
        [1787492528739, 1370, 846], // lifetime
      ]),
      LIVE_NOW,
    );

    expect(result.gap).toBeNull();
    expect(result.ldsPct).toBe(0);
    expect(result.lifetimeReach).toBe(846);
  });
});
