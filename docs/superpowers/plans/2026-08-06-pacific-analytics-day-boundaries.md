# Pacific Analytics Day Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owner-facing follower analytics use `America/Los_Angeles` calendar days so the August 5 and August 6 demographic refreshes render as separate daily bars while genuinely stale days remain combined.

**Architecture:** Add one dependency-free backend module that converts UTC instants to Pacific day keys and converts those keys back to exact, DST-safe UTC query boundaries. Apply that module to follower anchors, spike windows, feed snapshot collection, and feed attribution; keep frontend day strings as abstract calendar labels and retain UTC for raw timestamps.

**Tech Stack:** TypeScript, Node.js 22 `Intl.DateTimeFormat`, Prisma 5, PostgreSQL/Supabase, React 19, Vitest, Vite

## Global Constraints

- The analytics timezone is exactly `America/Los_Angeles`; do not use a fixed `PST` or `UTC-8` offset.
- Keep raw instants such as `captured_at`, `posted_at`, event timestamps, and worker timestamps in UTC.
- Do not change unrelated operational clocks such as Gemini spend guards, queue schedules, or event-log timestamps.
- Do not change the follower-flow source from `follower_demographics` to `follows_and_unfollows`.
- Preserve the existing top-country cutoff, stale-day, multi-day-span, provisional, and net-versus-gross caveats.
- Treat frontend `YYYY-MM-DD` values as calendar labels; formatting them through a synthetic UTC midnight is allowed only to prevent browser date shifting.
- Calendar shifts must use day keys, not fixed 24-hour instant subtraction, across daylight-saving transitions.
- Historical feed rows can preserve only retained evidence; the migration must not claim to reconstruct UTC-boundary readings that the prior upsert already overwrote.

---

### Task 1: Create the Pacific Analytics Calendar

**Files:**
- Create: `src/services/analyticsDay.ts`
- Create: `src/services/analyticsDay.test.ts`

**Interfaces:**
- Consumes: Node.js `Intl.DateTimeFormat` with IANA timezone data.
- Produces: `ANALYTICS_TIME_ZONE`, `toAnalyticsDayKey(Date)`, `isDayKey(unknown)`, `shiftDayKey(string, number)`, `calendarDaysBetween(string, string)`, `enumerateDayKeys(string, string)`, `analyticsDayBounds(string)`, `dayKeyToSqlDate(string)`, and `sqlDateToDayKey(Date)`.

- [ ] **Step 1: Write the failing timezone tests**

Create `src/services/analyticsDay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_TIME_ZONE,
  analyticsDayBounds,
  calendarDaysBetween,
  dayKeyToSqlDate,
  enumerateDayKeys,
  isDayKey,
  shiftDayKey,
  sqlDateToDayKey,
  toAnalyticsDayKey,
} from "./analyticsDay.js";

describe("Pacific analytics calendar", () => {
  it("uses the Los Angeles IANA timezone", () => {
    expect(ANALYTICS_TIME_ZONE).toBe("America/Los_Angeles");
  });

  it("places an August UTC-midnight refresh on the preceding Pacific day", () => {
    expect(toAnalyticsDayKey(new Date("2026-08-06T00:05:08Z"))).toBe("2026-08-05");
  });

  it("uses the winter UTC-8 boundary", () => {
    expect(toAnalyticsDayKey(new Date("2026-01-01T07:59:59Z"))).toBe("2025-12-31");
    expect(toAnalyticsDayKey(new Date("2026-01-01T08:00:00Z"))).toBe("2026-01-01");
  });

  it("returns a 23-hour spring-forward day", () => {
    const bounds = analyticsDayBounds("2026-03-08");
    expect(bounds.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(bounds.endExclusive.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(bounds.endExclusive.getTime() - bounds.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("returns a 25-hour fall-back day", () => {
    const bounds = analyticsDayBounds("2026-11-01");
    expect(bounds.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(bounds.endExclusive.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(bounds.endExclusive.getTime() - bounds.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("shifts abstract calendar keys across both DST transitions", () => {
    expect(shiftDayKey("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDayKey("2026-11-01", 1)).toBe("2026-11-02");
    expect(calendarDaysBetween("2026-03-07", "2026-03-10")).toBe(3);
    expect(enumerateDayKeys("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("round-trips canonical SQL date values without timezone conversion", () => {
    expect(dayKeyToSqlDate("2026-08-05")).toEqual(new Date("2026-08-05T00:00:00Z"));
    expect(sqlDateToDayKey(new Date("2026-08-05T00:00:00Z"))).toBe("2026-08-05");
  });

  it("rejects malformed and impossible day keys", () => {
    expect(isDayKey("2026-08-05")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(() => analyticsDayBounds("08/05/2026")).toThrow("invalid_analytics_day");
  });
});
```

- [ ] **Step 2: Run the timezone test and verify RED**

Run: `npm test -- --run src/services/analyticsDay.test.ts`

Expected: FAIL because `analyticsDay.ts` does not exist.

- [ ] **Step 3: Implement the timezone module**

Create `src/services/analyticsDay.ts`:

```ts
export const ANALYTICS_TIME_ZONE = "America/Los_Angeles" as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ANALYTICS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(value: Date): ZonedParts {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_analytics_instant");
  const parts = Object.fromEntries(
    zonedFormatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts as unknown as ZonedParts;
}

function dayEpoch(day: string): number {
  if (!isDayKey(day)) throw new Error("invalid_analytics_day");
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function toAnalyticsDayKey(value: Date): string {
  const parts = partsAt(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function shiftDayKey(day: string, byDays: number): string {
  if (!Number.isInteger(byDays)) throw new Error("invalid_analytics_day_shift");
  return new Date(dayEpoch(day) + byDays * DAY_MS).toISOString().slice(0, 10);
}

export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((dayEpoch(to) - dayEpoch(from)) / DAY_MS);
}

export function enumerateDayKeys(from: string, to: string): string[] {
  const distance = calendarDaysBetween(from, to);
  if (distance < 0) return [];
  return Array.from({ length: distance + 1 }, (_, index) => shiftDayKey(from, index));
}

function analyticsDayStart(day: string): Date {
  const targetLocalEpoch = dayEpoch(day);
  let candidateEpoch = targetLocalEpoch;

  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = partsAt(new Date(candidateEpoch));
    const representedLocalEpoch = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = targetLocalEpoch - representedLocalEpoch;
    if (correction === 0) return new Date(candidateEpoch);
    candidateEpoch += correction;
  }

  throw new Error("analytics_day_boundary_unresolvable");
}

export function analyticsDayBounds(day: string): { start: Date; endExclusive: Date } {
  return {
    start: analyticsDayStart(day),
    endExclusive: analyticsDayStart(shiftDayKey(day, 1)),
  };
}

export function dayKeyToSqlDate(day: string): Date {
  return new Date(dayEpoch(day));
}

export function sqlDateToDayKey(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_sql_date");
  const day = value.toISOString().slice(0, 10);
  if (!isDayKey(day)) throw new Error("invalid_sql_date");
  return day;
}
```

The UTC arithmetic in `shiftDayKey` is deliberately performed on an abstract date label, never on a capture instant or query boundary.

- [ ] **Step 4: Run the timezone test and verify GREEN**

Run: `npm test -- --run src/services/analyticsDay.test.ts`

Expected: all timezone conversion, validation, and DST tests PASS regardless of the shell's `TZ` value.

- [ ] **Step 5: Commit the calendar module**

```bash
git add src/services/analyticsDay.ts src/services/analyticsDay.test.ts
git commit -m "feat: add Pacific analytics calendar"
```

---

### Task 2: Rebucket Follower-Demographic Anchors

**Files:**
- Modify: `src/services/followerFlowService.ts`
- Modify: `src/services/followerFlowService.test.ts`
- Modify: `src/services/followerFlowCore.ts`
- Modify: `src/services/followerFlowCore.test.ts`

**Interfaces:**
- Consumes: `ANALYTICS_TIME_ZONE`, `toAnalyticsDayKey`, `analyticsDayBounds`, and `shiftDayKey` from Task 1.
- Produces: follower points keyed by Pacific day and `FollowerFlowResult.analyticsTimeZone: "America/Los_Angeles"`.

- [ ] **Step 1: Add the August and July regression tests**

Extend `src/services/followerFlowService.test.ts` with the following tests. Import both `getFollowerDailyAdds` and `getFollowerDailyAddsPointsForRange`.

```ts
it("splits the known August refresh into separate Pacific days", async () => {
  vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
    { capturedAt: new Date("2026-08-05T00:00:00Z"), counts: { US: 5_057 }, totalCounted: 5_057 },
    { capturedAt: new Date("2026-08-05T12:05:00Z"), counts: { US: 5_057 }, totalCounted: 5_057 },
    { capturedAt: new Date("2026-08-06T00:05:08Z"), counts: { US: 5_218 }, totalCounted: 5_218 },
    { capturedAt: new Date("2026-08-06T12:05:00Z"), counts: { US: 5_382 }, totalCounted: 5_382 },
  ] as never);

  const points = await getFollowerDailyAddsPointsForRange({
    from: "2026-08-05",
    to: "2026-08-06",
  });

  expect(points.map(({ day, total, reportedTotalDelta, spanDays, basis }) => ({
    day,
    total,
    reportedTotalDelta,
    spanDays,
    basis,
  }))).toEqual([
    { day: "2026-08-05", total: 161, reportedTotalDelta: 161, spanDays: 1, basis: "diff" },
    { day: "2026-08-06", total: 164, reportedTotalDelta: 164, spanDays: 1, basis: "diff" },
  ]);
});

it("keeps a truly stale Pacific day combined with the next refresh", async () => {
  vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
    { capturedAt: new Date("2026-07-21T00:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
    { capturedAt: new Date("2026-07-21T12:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
    { capturedAt: new Date("2026-07-22T00:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
    { capturedAt: new Date("2026-07-22T12:00:00Z"), counts: { US: 168 }, totalCounted: 168 },
  ] as never);

  const points = await getFollowerDailyAddsPointsForRange({
    from: "2026-07-21",
    to: "2026-07-22",
  });

  expect(points.map(({ day, total, spanDays, basis }) => ({ day, total, spanDays, basis }))).toEqual([
    { day: "2026-07-21", total: null, spanDays: null, basis: "stale" },
    { day: "2026-07-22", total: 68, spanDays: 2, basis: "multi_day_span" },
  ]);
});

it("reports the active analytics timezone", async () => {
  vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([]);
  await expect(getFollowerDailyAdds()).resolves.toMatchObject({
    analyticsTimeZone: "America/Los_Angeles",
  });
});
```

Update the existing historical-range query expectation from `2025-08-05T00:00:00Z` to `2025-08-05T07:00:00Z`, the start of that Pacific day.

In `src/services/followerFlowCore.test.ts`, rename the existing stale-day test to `absorbs a full stale analytics day into the next real diff as a 2-day span`; retain its assertions as a lower-level guard for `buildDailyPoints`.

- [ ] **Step 2: Run follower-flow tests and verify RED**

Run: `npm test -- --run src/services/followerFlowCore.test.ts src/services/followerFlowService.test.ts`

Expected: the August fixture is grouped as an August 5–6 span, the historical query ends at the UTC boundary, and `analyticsTimeZone` is absent.

- [ ] **Step 3: Use Pacific keys and boundaries in the follower service**

In `src/services/followerFlowService.ts`:

```ts
import {
  ANALYTICS_TIME_ZONE,
  analyticsDayBounds,
  shiftDayKey,
  toAnalyticsDayKey,
} from "./analyticsDay.js";
```

Make these exact behavior changes:

```ts
export interface FollowerFlowResult {
  analyticsTimeZone: typeof ANALYTICS_TIME_ZONE;
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
}

function anchorsFromRows(rows: FollowerSnapshotRow[]): AnchorSnapshot[] {
  const anchorsByDay = new Map<string, AnchorSnapshot>();
  for (const row of rows) {
    const day = toAnalyticsDayKey(row.capturedAt);
    anchorsByDay.set(day, {
      day,
      capturedAt: row.capturedAt,
      counts: asCounts(row.counts),
      totalCounted: row.totalCounted,
    });
  }
  return [...anchorsByDay.values()];
}
```

For an explicit range, replace the fixed UTC successor calculation with:

```ts
const toSuccessorExclusive = analyticsDayBounds(shiftDayKey(range.to, 3)).start;
```

Filter built points lexically because valid ISO day keys sort chronologically:

```ts
return buildDailyPoints(anchorsFromRows(rows)).filter(
  (point) => point.day >= range.from && point.day <= range.to,
);
```

For the 90-day dashboard read, derive the cutoff from the Pacific calendar:

```ts
const today = toAnalyticsDayKey(new Date());
const cutoff = analyticsDayBounds(shiftDayKey(today, -LOOKBACK_DAYS)).start;
```

Return `analyticsTimeZone: ANALYTICS_TIME_ZONE` alongside `points` and `stock`. Remove the now-unused service `DAY_MS` constant and update comments from “UTC day” to “Pacific analytics day.”

In `src/services/followerFlowCore.ts`, change the `FollowerDailyAddsPoint.day` comment to “Pacific analytics calendar day.” Keep the existing UTC-midnight arithmetic used only for abstract day-label enumeration, and add a comment beside it stating that these synthetic midnights are never capture instants or query bounds.

- [ ] **Step 4: Run follower-flow tests and verify GREEN**

Run: `npm test -- --run src/services/analyticsDay.test.ts src/services/followerFlowCore.test.ts src/services/followerFlowService.test.ts`

Expected: August produces `+161` and `+164` one-day points; July still produces a stale day and a two-day span; all existing cutoff and provisional tests PASS.

- [ ] **Step 5: Commit follower rebucketing**

```bash
git add src/services/followerFlowService.ts src/services/followerFlowService.test.ts \
  src/services/followerFlowCore.ts src/services/followerFlowCore.test.ts
git commit -m "fix: bucket follower flow by Pacific day"
```

---

### Task 3: Convert Spike Attribution Windows to Pacific Boundaries

**Files:**
- Modify: `src/services/spikeService.ts`
- Create: `src/services/spikeService.test.ts`
- Modify: `src/services/spikeCore.ts`

**Interfaces:**
- Consumes: `analyticsDayBounds` and `shiftDayKey` from Task 1; existing `detectSpikes` and `rankCandidates` behavior remains unchanged.
- Produces: `spikeAttributionWindow(day: string)` returning `{ queryStart: Date; windowStartMs: number; windowEndMs: number }` for testable Pacific query boundaries.

- [ ] **Step 1: Write failing boundary and database-query tests**

Create `src/services/spikeService.test.ts` with mocked `prisma.reelPerformanceSnapshot.findMany` and `prisma.reelMeta.findMany`. Add these assertions:

```ts
it("builds the summer query around Pacific calendar days", () => {
  expect(spikeAttributionWindow("2026-08-05")).toEqual({
    queryStart: new Date("2026-08-02T07:00:00.000Z"),
    windowStartMs: Date.parse("2026-08-04T07:00:00.000Z"),
    windowEndMs: Date.parse("2026-08-07T06:59:59.999Z"),
  });
});

it("does not assume 24-hour days across fall-back", () => {
  expect(spikeAttributionWindow("2026-11-01")).toEqual({
    queryStart: new Date("2026-10-29T07:00:00.000Z"),
    windowStartMs: Date.parse("2026-10-31T07:00:00.000Z"),
    windowEndMs: Date.parse("2026-11-03T07:59:59.999Z"),
  });
});
```

Add a service test with seven settled `+40` points followed by an August 5 `+200` point. Return one Reel baseline before `windowStartMs` and one final reading inside the window, then assert:

```ts
expect(prisma.reelPerformanceSnapshot.findMany).toHaveBeenCalledWith({
  where: {
    capturedAt: {
      gte: new Date("2026-08-02T07:00:00.000Z"),
      lte: new Date("2026-08-07T06:59:59.999Z"),
    },
  },
  orderBy: { capturedAt: "asc" },
  select: { mediaId: true, capturedAt: true, reach: true },
});
```

Also assert that the returned map remains keyed by `"2026-08-05"`.

- [ ] **Step 2: Run the spike service test and verify RED**

Run: `npm test -- --run src/services/spikeService.test.ts`

Expected: FAIL because `spikeAttributionWindow` does not exist and the service still queries UTC-midnight windows.

- [ ] **Step 3: Implement DST-safe spike windows**

In `src/services/spikeService.ts`, remove `DAY_MS`, import the shared helpers, and add:

```ts
export function spikeAttributionWindow(day: string): {
  queryStart: Date;
  windowStartMs: number;
  windowEndMs: number;
} {
  const windowStartDay = shiftDayKey(day, -WINDOW_PAD_DAYS);
  const windowEndExclusiveDay = shiftDayKey(day, WINDOW_PAD_DAYS + 1);
  const queryStartDay = shiftDayKey(windowStartDay, -BASELINE_LOOKBACK_DAYS);
  return {
    queryStart: analyticsDayBounds(queryStartDay).start,
    windowStartMs: analyticsDayBounds(windowStartDay).start.getTime(),
    windowEndMs: analyticsDayBounds(windowEndExclusiveDay).start.getTime() - 1,
  };
}
```

Within `getSpikesByDay`, replace fixed millisecond arithmetic with:

```ts
const { queryStart, windowStartMs, windowEndMs } = spikeAttributionWindow(spike.day);
```

Use `queryStart` for Prisma `gte`, `new Date(windowEndMs)` for `lte`, and pass the millisecond values unchanged to `rankCandidates`. Update `Spike.day` and service comments from UTC day to Pacific analytics day.

- [ ] **Step 4: Run spike tests and verify GREEN**

Run: `npm test -- --run src/services/analyticsDay.test.ts src/services/spikeCore.test.ts src/services/spikeService.test.ts`

Expected: pure ranking tests remain unchanged, summer boundaries use UTC-7, and the fall-back window includes the extra real hour.

- [ ] **Step 5: Commit spike-window changes**

```bash
git add src/services/spikeService.ts src/services/spikeService.test.ts src/services/spikeCore.ts
git commit -m "fix: align spike windows to Pacific days"
```

---

### Task 4: Store Feed Snapshots by Pacific Day and Rekey Existing Rows

**Files:**
- Modify: `src/services/feedFollowSnapshotWorker.ts`
- Modify: `src/services/feedFollowSnapshotWorker.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260806180000_rekey_feed_follow_snapshots_to_pacific_day/migration.sql`

**Interfaces:**
- Consumes: `toAnalyticsDayKey` and `dayKeyToSqlDate` from Task 1.
- Produces: new `FeedFollowDailySnapshot.day` values keyed to Pacific calendar days while preserving `capturedAt` as the actual UTC instant.

- [ ] **Step 1: Change the worker test to expose both UTC and Pacific midnight boundaries**

Replace the existing “crosses UTC midnight” test in `src/services/feedFollowSnapshotWorker.test.ts` with:

```ts
it("dates every media reading by its Pacific capture day", async () => {
  const memory = memoryRepository(new Date("2026-08-01T00:00:00Z"));
  const clock = vi
    .fn()
    .mockReturnValueOnce(new Date("2026-08-05T06:59:59Z"))
    .mockReturnValueOnce(new Date("2026-08-05T07:00:01Z"))
    .mockReturnValueOnce(new Date("2026-08-05T07:00:02Z"));

  await collectFeedFollowSnapshot(
    {
      repository: memory.repository,
      listPosts: async () => [post("before-midnight", null), post("after-midnight", null)],
      fetchFollowCount: async () => ({ status: "ok", follows: 2 }),
      isAuthenticationError: () => false,
      pause: async () => undefined,
      recordEvent: async () => undefined,
      describeError: () => ({}),
      clock,
    },
    new Date("2026-08-05T00:00:00Z"),
  );

  expect(memory.snapshotWrites.map(({ day, capturedAt }) => ({ day, capturedAt }))).toEqual([
    {
      day: new Date("2026-08-04T00:00:00Z"),
      capturedAt: new Date("2026-08-05T06:59:59Z"),
    },
    {
      day: new Date("2026-08-05T00:00:00Z"),
      capturedAt: new Date("2026-08-05T07:00:01Z"),
    },
  ]);
});
```

- [ ] **Step 2: Run the worker test and verify RED**

Run: `npm test -- --run src/services/feedFollowSnapshotWorker.test.ts`

Expected: the reading before 07:00 UTC is incorrectly assigned to August 5 by `utcDay`.

- [ ] **Step 3: Change new snapshot writes to Pacific day keys**

In `src/services/feedFollowSnapshotWorker.ts`, import `dayKeyToSqlDate` and `toAnalyticsDayKey`, delete `utcDay`, and calculate each row with:

```ts
const capturedAt = clock();
const day = dayKeyToSqlDate(toAnalyticsDayKey(capturedAt));
```

Update the repository and collector comments to say “same Pacific analytics day.” Do not alter `capturedAt`, lease timestamps, run timestamps, or the per-media call to `clock()`.

- [ ] **Step 4: Add the one-time data migration with executable collision verification**

Create `prisma/migrations/20260806180000_rekey_feed_follow_snapshots_to_pacific_day/migration.sql`:

```sql
-- Exercise the collision ordering before touching retained evidence: a success
-- beats a later failure, while an all-failure group keeps its latest attempt.
DO $$
DECLARE
  matched_winners integer;
BEGIN
  WITH fixture("media_id", "captured_at", "follows", "status") AS (
    VALUES
      ('success-case', '2026-08-05T18:00:00Z'::timestamptz, 7, 'ok'),
      ('success-case', '2026-08-06T00:05:00Z'::timestamptz, NULL, 'failed'),
      ('failure-case', '2026-08-05T18:00:00Z'::timestamptz, NULL, 'unavailable'),
      ('failure-case', '2026-08-06T00:05:00Z'::timestamptz, NULL, 'failed')
  ),
  ranked AS (
    SELECT DISTINCT ON (
      fixture."media_id",
      (fixture."captured_at" AT TIME ZONE 'America/Los_Angeles')::date
    )
      fixture."media_id",
      fixture."captured_at",
      fixture."status"
    FROM fixture
    ORDER BY
      fixture."media_id",
      (fixture."captured_at" AT TIME ZONE 'America/Los_Angeles')::date,
      (fixture."status" = 'ok') DESC,
      fixture."captured_at" DESC
  )
  SELECT count(*) INTO matched_winners
  FROM ranked
  WHERE
    ("media_id" = 'success-case' AND "captured_at" = '2026-08-05T18:00:00Z'::timestamptz)
    OR
    ("media_id" = 'failure-case' AND "captured_at" = '2026-08-06T00:05:00Z'::timestamptz);

  IF matched_winners <> 2 THEN
    RAISE EXCEPTION 'Pacific feed-follow collision policy verification failed';
  END IF;
END $$;

-- Historical rows contain one retained winner per former UTC day. Re-key that
-- retained evidence to America/Los_Angeles. This cannot restore readings that
-- the former UTC-day upsert already replaced.
CREATE TEMP TABLE "feed_follow_snapshot_pacific_winner" ON COMMIT DROP AS
SELECT DISTINCT ON (source."media_id", source."pacific_day")
  source."media_id",
  source."pacific_day" AS "day",
  source."captured_at",
  source."follows",
  source."status"
FROM (
  SELECT
    snapshot."media_id",
    (snapshot."captured_at" AT TIME ZONE 'America/Los_Angeles')::date AS "pacific_day",
    snapshot."captured_at",
    snapshot."follows",
    snapshot."status"
  FROM "feed_follow_daily_snapshot" AS snapshot
) AS source
ORDER BY
  source."media_id",
  source."pacific_day",
  (source."status" = 'ok') DESC,
  source."captured_at" DESC;

DELETE FROM "feed_follow_daily_snapshot";

INSERT INTO "feed_follow_daily_snapshot"
  ("media_id", "day", "captured_at", "follows", "status")
SELECT "media_id", "day", "captured_at", "follows", "status"
FROM "feed_follow_snapshot_pacific_winner";

-- Fail the migration if the copied result differs from the ranked winners.
DO $$
BEGIN
  IF
    (SELECT count(*) FROM "feed_follow_daily_snapshot") <>
      (SELECT count(*) FROM "feed_follow_snapshot_pacific_winner")
    OR EXISTS (
      SELECT 1
      FROM "feed_follow_snapshot_pacific_winner" AS expected
      LEFT JOIN "feed_follow_daily_snapshot" AS actual
        ON actual."media_id" = expected."media_id"
       AND actual."day" = expected."day"
      WHERE actual."media_id" IS NULL
         OR actual."captured_at" IS DISTINCT FROM expected."captured_at"
         OR actual."follows" IS DISTINCT FROM expected."follows"
         OR actual."status" IS DISTINCT FROM expected."status"
    )
  THEN
    RAISE EXCEPTION 'Pacific feed-follow snapshot backfill verification failed';
  END IF;
END $$;
```

The ordering implements the approved collision rule: any successful row beats any unsuccessful row; within that preferred status class, the latest capture wins. Update the `FeedFollowDailySnapshot` schema comment from “UTC day” to “Pacific analytics day.”

- [ ] **Step 5: Validate schema and run worker tests**

Run: `npx prisma validate`

Expected: the Prisma schema is valid.

Run: `npm test -- --run src/services/analyticsDay.test.ts src/services/feedFollowSnapshotWorker.test.ts`

Expected: worker and conflict-upsert tests PASS; the stored SQL `date` changes at 07:00 UTC in August while raw capture instants do not change.

- [ ] **Step 6: Commit collector and migration changes**

```bash
git add src/services/feedFollowSnapshotWorker.ts src/services/feedFollowSnapshotWorker.test.ts \
  prisma/schema.prisma \
  prisma/migrations/20260806180000_rekey_feed_follow_snapshots_to_pacific_day/migration.sql
git commit -m "fix: store feed snapshots by Pacific day"
```

---

### Task 5: Align Feed Attribution, Eligibility, and API Ranges

**Files:**
- Modify: `src/services/feedFollowAttributionCore.ts`
- Modify: `src/services/feedFollowAttributionCore.test.ts`
- Modify: `src/services/feedFollowAttributionService.ts`
- Modify: `src/services/feedFollowAttributionService.test.ts`
- Modify: `src/api/insights.routes.ts`

**Interfaces:**
- Consumes: `analyticsDayBounds`, `calendarDaysBetween`, `dayKeyToSqlDate`, `enumerateDayKeys`, `isDayKey`, `shiftDayKey`, `sqlDateToDayKey`, and `toAnalyticsDayKey` from Task 1.
- Produces: range parsing, tracking-day checks, post eligibility, snapshot deltas, and database cutoffs that all interpret a day key as Pacific.

- [ ] **Step 1: Add failing Pacific range and eligibility tests**

Make these test changes in `src/services/feedFollowAttributionCore.test.ts`:

```ts
it("marks the Pacific tracking day partial even at exact Pacific midnight", () => {
  const response = buildFeedFollowAttribution({
    from: "2026-08-02",
    to: "2026-08-02",
    trackingStartedAt: new Date("2026-08-02T07:00:00Z"),
    posts: [post({
      firstSeenAt: new Date("2026-08-02T07:05:00Z"),
      baselineFollows: 5,
      baselineCapturedAt: new Date("2026-08-02T07:05:00Z"),
    })],
    snapshots: [snapshot("2026-08-02", 5)],
    followerPoints: [followerPoint("2026-08-02", 4)],
  });

  expect(response.days[0]).toMatchObject({
    collectionStatus: "partial",
    netResidualAfterFeed: null,
    comparisonReason: "feed_tracking_partial_day",
  });
});

it("uses Pacific publication and first-seen days for eligibility", () => {
  const response = buildFeedFollowAttribution({
    from: "2026-08-04",
    to: "2026-08-04",
    trackingStartedAt: new Date("2026-08-01T07:00:00Z"),
    posts: [post({
      postedAt: new Date("2026-08-05T00:30:00Z"),
      firstSeenAt: new Date("2026-08-05T01:00:00Z"),
      baselineFollows: 0,
      baselineCapturedAt: new Date("2026-08-05T00:30:00Z"),
    })],
    snapshots: [snapshot("2026-08-04", 2)],
    followerPoints: [followerPoint("2026-08-04", 3)],
  });

  expect(response.days[0]).toMatchObject({ day: "2026-08-04", eligiblePosts: 1 });
});

it("defaults to the latest 30 inclusive Pacific days", () => {
  expect(parseFeedFollowAttributionRange({}, new Date("2026-08-05T00:05:00Z"))).toEqual({
    from: "2026-07-06",
    to: "2026-08-04",
  });
});
```

Rename every test and comment that says “UTC day” to “Pacific day.” Keep snapshot helper `day: new Date(`${day}T00:00:00Z`)` because Prisma represents a SQL `date` as canonical UTC midnight; it is not a capture instant.

In `src/services/feedFollowAttributionService.test.ts`, change the post-query cutoff expectation for an August 2 range to:

```ts
where: {
  OR: [
    { firstSeenAt: { lt: new Date("2026-08-03T07:00:00Z") } },
    { postedAt: { lt: new Date("2026-08-03T07:00:00Z") } },
  ],
},
```

Also assert the snapshot query still uses the canonical SQL date:

```ts
expect(prisma.feedFollowDailySnapshot.findMany).toHaveBeenCalledWith(
  expect.objectContaining({ where: { day: { lte: new Date("2026-08-02T00:00:00Z") } } }),
);
```

- [ ] **Step 2: Run feed-attribution tests and verify RED**

Run: `npm test -- --run src/services/feedFollowAttributionCore.test.ts src/services/feedFollowAttributionService.test.ts`

Expected: UTC-midnight instants remain assigned to the UTC day, and the service cutoff is seven hours too early in August.

- [ ] **Step 3: Replace local UTC helpers with the shared analytics calendar**

In `src/services/feedFollowAttributionCore.ts`, remove `DAY_MS`, `dayString`, `dayNumber`, local `calendarDaysBetween`, local `enumerateDays`, and local `validDay`. Import the Task 1 helpers and make these replacements:

```ts
const priorDay = post.baselineCapturedAt
  ? toAnalyticsDayKey(post.baselineCapturedAt)
  : null;

const day = sqlDateToDayKey(snapshot.day);
const trackingDay = input.trackingStartedAt
  ? toAnalyticsDayKey(input.trackingStartedAt)
  : null;
const eligibleFrom = publishedAfterTracking && post.postedAt
  ? toAnalyticsDayKey(post.postedAt)
  : toAnalyticsDayKey(post.firstSeenAt);
```

Use `enumerateDayKeys(input.from, input.to)`, the shared `calendarDaysBetween`, and this range parsing:

```ts
export function parseFeedFollowAttributionRange(
  query: { from?: unknown; to?: unknown },
  now = new Date(),
): { from: string; to: string } {
  const today = toAnalyticsDayKey(now);
  const to = query.to ?? today;
  if (!isDayKey(to)) throw new Error("invalid_date_range");
  const defaultFrom = shiftDayKey(to, -29);
  const from = query.from ?? defaultFrom;
  if (!isDayKey(from)) throw new Error("invalid_date_range");
  const span = calendarDaysBetween(from, to);
  if (span < 0 || span > 89) throw new Error("invalid_date_range");
  return { from, to };
}
```

Change the tracking-partial comment to say Pacific analytics day.

In `src/services/feedFollowAttributionService.ts`, replace the UTC end calculation with:

```ts
const toDay = dayKeyToSqlDate(range.to);
const toExclusive = analyticsDayBounds(range.to).endExclusive;
```

Convert `latestSnapshot.day` through `sqlDateToDayKey`. The snapshot `day <= toDay` query remains a SQL-date comparison; post `firstSeenAt` and `postedAt` use the exact Pacific `toExclusive` instant.

In `src/api/insights.routes.ts`, change the validation detail to:

```ts
detail: "Use inclusive Pacific dates (YYYY-MM-DD), from <= to, with at most 90 days.",
```

- [ ] **Step 4: Run feed-attribution tests and verify GREEN**

Run: `npm test -- --run src/services/analyticsDay.test.ts src/services/feedFollowAttributionCore.test.ts src/services/feedFollowAttributionService.test.ts`

Expected: tracking, publication, default ranges, database cutoffs, and follower-point joins all use the same Pacific key; invalid range behavior remains unchanged.

- [ ] **Step 5: Commit feed-attribution changes**

```bash
git add src/services/feedFollowAttributionCore.ts src/services/feedFollowAttributionCore.test.ts \
  src/services/feedFollowAttributionService.ts src/services/feedFollowAttributionService.test.ts \
  src/api/insights.routes.ts
git commit -m "fix: align feed attribution to Pacific days"
```

---

### Task 6: Update Owner-Facing Types, Dates, and Copy

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/home/FollowerFlowPanel.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`
- Modify: `web/src/lib/feedFollowAttribution.ts`
- Modify: `web/src/lib/feedFollowAttribution.test.ts`
- Modify: `web/src/components/home/FeedFollowAttributionDrawer.tsx`
- Modify: `web/src/components/home/FeedFollowAttributionDrawer.test.tsx`
- Modify: `web/src/pages/Home.tsx`
- Modify: `web/src/components/home/DailyAddsChart.tsx`
- Modify: `web/src/lib/chartTooltip.ts`
- Modify: `web/src/components/home/SpikeCandidates.tsx`

**Interfaces:**
- Consumes: backend `analyticsTimeZone` and Pacific day keys from Tasks 2 and 5.
- Produces: UI that calls the selected day Pacific, formats post publication instants in Los Angeles, and never shifts abstract chart keys in the browser.

- [ ] **Step 1: Write failing UI copy and publication-date tests**

In `web/src/components/home/HomePanels.test.tsx`, extend the main follower-panel assertion:

```ts
expect(html).toContain("bucketed by Pacific day");
expect(html).not.toContain("bucketed by UTC day");
```

In `web/src/lib/feedFollowAttribution.test.ts`, rename the path test to “selected Pacific date” and change the partial-day expected detail to:

```ts
"All 37 post readings succeeded, but tracking began partway through this Pacific day."
```

In `web/src/components/home/FeedFollowAttributionDrawer.test.tsx`, add a contributor whose `postedAt` is `2026-08-05T00:30:00Z` and assert:

```ts
expect(html).toContain("Published Aug 4, 2026 Pacific");
expect(html).not.toContain("Published Aug 5, 2026 UTC");
```

The selected day title must still render August 5 from the key `2026-08-05`; this confirms that calendar labels are not converted as instants.

- [ ] **Step 2: Run focused web tests and verify RED**

Run: `npm --prefix web test -- --run src/components/home/HomePanels.test.tsx src/lib/feedFollowAttribution.test.ts src/components/home/FeedFollowAttributionDrawer.test.tsx`

Expected: copy still says UTC and publication dates are formatted in UTC.

- [ ] **Step 3: Update response types and visible copy**

In `web/src/lib/types.ts`, change the `FollowerDailyAddsPoint.day` comment to Pacific analytics calendar day and add:

```ts
export interface FollowerFlowResponse {
  analyticsTimeZone: "America/Los_Angeles";
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
}
```

In `FollowerFlowPanel.tsx`, replace the explanatory sentence with:

```tsx
Net adds (follows minus unfollows) diffed from Meta's follower geography, bucketed by Pacific day.
```

In `feedFollowAttribution.ts`, replace “this UTC day” with “this Pacific day.”

In `FeedFollowAttributionDrawer.tsx`:

- rename `formatUtcDay` to `formatDayKey`;
- keep the selected-day formatter on UTC because it formats an abstract `YYYY-MM-DD` label;
- set only the publication-instant formatter to `timeZone: "America/Los_Angeles"`;
- render publication copy as ``Published ${publishedAt} Pacific``.

In `web/src/pages/Home.tsx`, format the `Updated ...` snapshot date with the timezone declared by the follower response:

```ts
const updatedLabel = flowStock
  ? new Date(flowStock.capturedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: flowQ.data?.analyticsTimeZone ?? "America/Los_Angeles",
    })
  : "Waiting for the next snapshot";
```

In `DailyAddsChart.tsx`, `chartTooltip.ts`, and `SpikeCandidates.tsx`, keep `timeZone: "UTC"` for synthetic midnight label formatting but add a nearby comment: “This is an abstract Pacific day key; UTC formatting prevents browser date shifting.” Do not change those keys into instants.

- [ ] **Step 4: Run all frontend tests and verify GREEN**

Run: `npm --prefix web test`

Expected: all web tests PASS, selected chart and drawer keys remain identical, and no rendered explanation claims analytics are bucketed by UTC.

- [ ] **Step 5: Commit UI and type changes**

```bash
git add web/src/lib/types.ts web/src/components/home/FollowerFlowPanel.tsx \
  web/src/components/home/HomePanels.test.tsx web/src/lib/feedFollowAttribution.ts \
  web/src/lib/feedFollowAttribution.test.ts web/src/components/home/FeedFollowAttributionDrawer.tsx \
  web/src/components/home/FeedFollowAttributionDrawer.test.tsx \
  web/src/pages/Home.tsx \
  web/src/components/home/DailyAddsChart.tsx web/src/lib/chartTooltip.ts \
  web/src/components/home/SpikeCandidates.tsx
git commit -m "fix: label follower analytics as Pacific days"
```

---

### Task 7: Verify the Full System and Known Live Cases

**Files:**
- Verify only; modify a prior task's file if a failing check exposes a defect.

**Interfaces:**
- Consumes: all backend, migration, API, and frontend behavior from Tasks 1–6.
- Produces: evidence that August is split, July remains combined, connected features agree, and both applications build.

- [ ] **Step 1: Run all backend checks**

Run: `npm test`

Expected: all backend Vitest suites PASS.

Run: `npm run build`

Expected: Prisma Client generation and TypeScript compilation succeed.

- [ ] **Step 2: Run all frontend checks**

Run: `npm --prefix web test`

Expected: all frontend Vitest suites PASS.

Run: `npm --prefix web run lint`

Expected: ESLint reports no errors.

Run: `npm --prefix web run build`

Expected: TypeScript project compilation and the Vite production build succeed.

- [ ] **Step 3: Scan for stale product semantics**

Run:

```bash
rg -n "UTC day|UTC calendar day|bucketed by UTC|this UTC day|inclusive UTC dates" \
  src/services/followerFlowCore.ts src/services/followerFlowService.ts \
  src/services/spikeCore.ts src/services/spikeService.ts \
  src/services/feedFollowSnapshotWorker.ts src/services/feedFollowAttributionCore.ts \
  src/api/insights.routes.ts prisma/schema.prisma web/src
```

Expected: no stale comments or user-facing claims. Deliberate frontend `timeZone: "UTC"` label-formatting options may remain and must carry the abstract-key comment added in Task 6.

- [ ] **Step 4: Perform the coordinated application/migration cutover**

Follow `DEPLOY.md` section **One-time Pacific analytics-day cutover** exactly.
Application startup and migration execution are separate: first deploy the
compatible application without a Railway Pre-Deploy migration command, wait
until the old UTC-key deployment and every one of its replicas are `Removed`,
then apply
`20260806180000_rekey_feed_follow_snapshots_to_pacific_day` once from the active
release image. The migration's transaction-local lock timeout must fail and roll
back cleanly rather than wait indefinitely.

Do not run `prisma migrate deploy` against production before the compatible
collector is active, and do not roll back to the UTC-key collector after the
constraint has committed.

- [ ] **Step 5: Verify the live API payload with read-only HTTP requests**

Run the exact authenticated `curl`/Node smoke commands in `DEPLOY.md`; they issue
only `GET` requests to `/api/insights/follower-daily-adds` and
`/api/insights/feed-follow-attribution?from=2026-08-05&to=2026-08-05`. For the
follower response, select its August 5 and August 6 points and confirm:

```json
{
  "analyticsTimeZone": "America/Los_Angeles",
  "points": [
    { "day": "2026-08-05", "reportedTotalDelta": 161, "spanDays": 1, "basis": "diff" },
    { "day": "2026-08-06", "reportedTotalDelta": 164, "spanDays": 1, "basis": "diff" }
  ]
}
```

Also confirm the July sequence includes a stale July 21 point followed by a July 22 `multi_day_span` with `spanDays: 2`.

- [ ] **Step 6: Browser-verify the chart and drawer**

Open the Home dashboard and verify all of the following:

1. August 5 and August 6 render as separate bars rather than an “Aug 5–6” bar.
2. The API reports `reportedTotalDelta: 161` for August 5 and `164` for August 6; tooltip region totals remain honest about any top-country rank-cutoff residual instead of forcing those subtotals to match.
3. The July stale interval remains visibly combined and says Meta did not refresh in between.
4. Clicking the August 5 bar opens a drawer titled August 5 and requests `from=2026-08-05&to=2026-08-05`.
5. Publication dates in the drawer are Pacific dates, while raw timestamps in API and database output retain their UTC `Z` representation.
6. The explanatory note says “Pacific day,” not “PST” or “UTC day.”

If a verification check fails, return to the task that owns that behavior, repeat its RED/GREEN cycle, and rerun this full verification before completion.
