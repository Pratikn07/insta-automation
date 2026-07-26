# Real Follower Total + Chart Y-Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Instagram's true follower count (4,577) on the Total-followers tile instead of Meta's 45-country subtotal (4,355), and give the daily-adds chart a readable Y-axis plus denser date ticks.

**Architecture:** Two independent changes. (1) A new Graph API call on the IG user node supplies `followers_count`, threaded through the existing follower-flow route into the KPI tile; no DB column, fetched live so it always matches Instagram. (2) The pure `chartGeometry` function gains an opt-in left gutter and a new `axisTicks` helper, so the SVG can render labelled gridlines without shifting any existing bar coordinate.

**Tech Stack:** Backend — Node/Express, TypeScript, axios, Vitest. Frontend — React 19, Vite, Tailwind v4, Vitest with `renderToStaticMarkup`.

## Global Constraints

- Two separate test suites. **Backend:** `npm test` from repo root (`vitest`, `src/**/*.test.ts`). **Frontend:** `npm test` from `web/`. Run whichever covers the code you touched; run both before the final commit.
- Measured baselines: backend **13 test files**; frontend **8 files, 72 tests**. Both green at `d1bf280`.
- Frontend component tests use `renderToStaticMarkup` and assert HTML substrings. Do NOT add jsdom or @testing-library — neither is installed.
- Pure functions in `web/src/lib/` and `src/services/followerFlowCore.ts` must never call `Date.now()` or argless `new Date()`. Time arrives as a parameter.
- `tsconfig.app.json` sets `noUnusedLocals`/`noUnusedParameters`. A stray import fails `npm run build`.
- Graph calls for analytics go through `insightsGraph` (`src/meta/insightsGraphClient.ts`, v23.0), NEVER `graphClient.ts` (v21.0, rate-limit-sensitive messaging path). Mixing them can regress the gate.
- `followers_count` is VERIFIED live: `GET /{IG_USER_ID}?fields=followers_count` on the existing `IG_ACCESS_TOKEN` returned `4577` on 2026-07-26. No new scope needed.
- A failed `followers_count` fetch must degrade to `null`, never throw — the whole Home page hangs off this one route.
- Copy rule: the 45-country number must stay visible and labelled wherever it appears. We are adding a truer number, not hiding the old one.
- Commit with explicit `git add` paths, never `-A`.

---

## File Structure

**Created:**
| Path | Responsibility |
|---|---|
| `src/meta/profileFetcher.ts` | One function: fetch `followers_count` off the IG user node. Returns null on any failure. |
| `src/meta/profileFetcher.test.ts` | Covers parse, missing field, and error→null. |

**Modified:**
| Path | Change |
|---|---|
| `src/services/followerFlowCore.ts` | Add `followersTotal: number \| null` to the `FollowerStock` interface; `stockFrom` accepts and passes it through. |
| `src/services/followerFlowCore.test.ts` | Assert `followersTotal` threads through `stockFrom`. |
| `src/services/followerFlowService.ts` | Fetch the profile total alongside the snapshot query; hand it to `stockFrom`. |
| `web/src/lib/types.ts` | Mirror `followersTotal` on the frontend `FollowerStock`. |
| `web/src/lib/followerFlow.ts` | `describeStockVsFlow` uses the true total when present; add `axisTicks()`; `chartGeometry` gains opt-in `gutterLeft`. |
| `web/src/lib/followerFlow.test.ts` | Cover `axisTicks`, the gutter, and milestone-from-true-total. |
| `web/src/components/home/FollowerKpiRow.tsx` | Tile 2 headline shows the true total; note line discloses the 45-country subtotal. |
| `web/src/components/home/FollowerKpiRow.test.tsx` | Assert true total shown + subtotal disclosed + fallback when null. |
| `web/src/components/home/DailyAddsChart.tsx` | Render Y gridlines/labels and ~every-4th-day X ticks. |
| `web/src/components/home/HomePanels.test.tsx` | Update the `flowStock` fixture for the new field. |

**Task order:** Task 1 is a self-contained backend fetcher. Task 2 threads it to the API boundary. Task 3 consumes it in the tile. Tasks 4–5 are the chart, fully independent of 1–3 — if the follower work stalls, the axes still ship.

---

### Task 1: `fetchProfileTotals` backend fetcher

**Files:**
- Create: `src/meta/profileFetcher.ts`
- Test: `src/meta/profileFetcher.test.ts`

**Interfaces:**
- Consumes: `insightsGraph` from `./insightsGraphClient.js`, `env` from `../config/env.js`, `logger`, `describeGraphError` from `../services/eventLogger.js`.
- Produces:
  ```ts
  export interface ProfileTotals { followersTotal: number | null }
  export async function fetchProfileTotals(): Promise<ProfileTotals>;
  ```
  Task 2 calls this.

- [ ] **Step 1: Write the failing test**

Create `src/meta/profileFetcher.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./insightsGraphClient.js", () => ({
  insightsGraph: { get: vi.fn() },
}));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "123", INSIGHTS_GRAPH_VERSION: "v23.0" } }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../services/eventLogger.js", () => ({ describeGraphError: () => ({ status: 400 }) }));

const { insightsGraph } = await import("./insightsGraphClient.js");
const { fetchProfileTotals } = await import("./profileFetcher.js");

describe("fetchProfileTotals", () => {
  beforeEach(() => vi.mocked(insightsGraph.get).mockReset());

  it("returns the true follower count from the user node", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValue({ data: { followers_count: 4577, id: "123" } } as never);
    expect(await fetchProfileTotals()).toEqual({ followersTotal: 4577 });
  });

  it("requests only the followers_count field", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValue({ data: { followers_count: 10 } } as never);
    await fetchProfileTotals();
    const [path, config] = vi.mocked(insightsGraph.get).mock.calls[0]!;
    expect(path).toBe("/123");
    expect((config as { params: Record<string, string> }).params.fields).toBe("followers_count");
  });

  it("returns null rather than throwing when the call fails", async () => {
    vi.mocked(insightsGraph.get).mockRejectedValue(new Error("401 bad token"));
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });
  });

  it("returns null when the field is absent or non-numeric", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValue({ data: { id: "123" } } as never);
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });

    vi.mocked(insightsGraph.get).mockResolvedValue({ data: { followers_count: "lots" } } as never);
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo root): `npm test -- profileFetcher`
Expected: FAIL — cannot resolve `./profileFetcher.js`.

- [ ] **Step 3: Implement**

Create `src/meta/profileFetcher.ts`:

```ts
import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { describeGraphError } from "../services/eventLogger.js";
import { logger } from "../lib/logger.js";

/**
 * The account's TRUE follower total — the number Instagram shows on the profile.
 *
 * Why this exists: follower_demographics (demographicsFetcher.ts) reports only
 * Meta's top ~45 countries, so summing its buckets undercounts. Verified
 * 2026-07-26: demographics summed to 4,355 while this field returned 4,577 —
 * the 222 difference is followers in countries below Meta's reporting cutoff.
 *
 * Never throws: Home's entire follower panel hangs off the caller's route, so a
 * profile-fetch hiccup must degrade to null rather than blank the page.
 */
export interface ProfileTotals {
  followersTotal: number | null;
}

interface ProfileResponse {
  followers_count?: unknown;
}

export async function fetchProfileTotals(): Promise<ProfileTotals> {
  try {
    const { data } = await insightsGraph.get<ProfileResponse>(`/${env.IG_USER_ID}`, {
      params: { fields: "followers_count" },
    });
    const raw = data.followers_count;
    const followersTotal = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (followersTotal === null) {
      logger.warn({ raw }, "followers_count missing or non-numeric");
    }
    return { followersTotal };
  } catch (err) {
    logger.warn(describeGraphError(err), "fetchProfileTotals failed");
    return { followersTotal: null };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- profileFetcher`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/meta/profileFetcher.ts src/meta/profileFetcher.test.ts
git commit -m "feat: fetch the true follower total from the IG user node

follower_demographics only reports Meta's top ~45 countries, so summing
its buckets undercounts — 4,355 vs the real 4,577 on 2026-07-26. Degrades
to null rather than throwing; Home's whole panel rides on the caller."
```

---

### Task 2: Thread `followersTotal` to the API boundary

**Files:**
- Modify: `src/services/followerFlowCore.ts`
- Modify: `src/services/followerFlowCore.test.ts`
- Modify: `src/services/followerFlowService.ts`

**Interfaces:**
- Consumes: `fetchProfileTotals()` from Task 1.
- Produces: `FollowerStock` gains `followersTotal: number | null`. `stockFrom(anchor, followersTotal)` takes a second parameter. `GET /api/insights/follower-daily-adds` now returns it inside `stock`. Task 3 renders it.

- [ ] **Step 1: Write the failing test**

In `src/services/followerFlowCore.test.ts`, append:

```ts
describe("stockFrom followersTotal", () => {
  const anchor = {
    day: "2026-07-26",
    capturedAt: new Date("2026-07-26T18:07:52.909Z"),
    counts: { US: 1522, IN: 1278, GB: 400, ZZ: 100 },
    totalCounted: 3300,
  };

  it("carries the true total alongside the 45-country subtotal", () => {
    const stock = stockFrom(anchor, 4577);
    expect(stock.followersTotal).toBe(4577);
    // The demographics subtotal is preserved, not overwritten — the regional
    // math still needs it.
    expect(stock.totalCounted).toBe(3300);
  });

  it("leaves followersTotal null when the profile fetch failed", () => {
    expect(stockFrom(anchor, null).followersTotal).toBeNull();
  });
});
```

Confirm `stockFrom` is in that file's imports; add it if not.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- followerFlowCore`
Expected: FAIL — `Expected 1 arguments, but got 2` (TS) or `followersTotal` undefined.

- [ ] **Step 3: Implement**

In `src/services/followerFlowCore.ts`:

**(a)** Add the field to `FollowerStock` (after the `totalCounted` line, keeping its comment):

```ts
export interface FollowerStock {
  capturedAt: string;
  totalCounted: number; // sum across Meta's reported countries — NOT the true follower total
  // Instagram's real profile count (followers_count). Null when the profile
  // fetch failed. Differs from totalCounted by the followers in countries below
  // Meta's ~45-country reporting cutoff.
  followersTotal: number | null;
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  countriesReported: number;
}
```

**(b)** Give `stockFrom` the second parameter:

```ts
export function stockFrom(
  anchor: AnchorSnapshot,
  followersTotal: number | null = null,
): FollowerStock {
```

and add `followersTotal,` to the returned object (beside `totalCounted`).

In `src/services/followerFlowService.ts`:

**(c)** Import the fetcher:
```ts
import { fetchProfileTotals } from "../meta/profileFetcher.js";
```

**(d)** In `getFollowerDailyAdds`, fetch the profile total in parallel with the snapshot query (it's an independent network call — don't serialize it), then pass it to `stockFrom`. Find the existing `stock:` line in the return and change it so the total flows through:

```ts
  // Fetched per request, not stored: this must always agree with what
  // Instagram shows on the profile. Runs in parallel with the DB read.
  const { followersTotal } = await profileTotalsPromise;
```

Declare `const profileTotalsPromise = fetchProfileTotals();` immediately BEFORE the `await prisma.geoDemographicSnapshot.findMany(...)` call, and change the `stock` expression from `stockFrom(anchors[anchors.length - 1]!)` to `stockFrom(anchors[anchors.length - 1]!, followersTotal)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- followerFlowCore`
Expected: PASS including the 2 new tests.

Run: `npm test`
Expected: full backend suite green, 13 files.

- [ ] **Step 5: Commit**

```bash
git add src/services/followerFlowCore.ts src/services/followerFlowCore.test.ts src/services/followerFlowService.ts
git commit -m "feat: expose the true follower total on the flow route

stock.followersTotal rides alongside totalCounted rather than replacing
it — the regional diff math is built on the 45-country buckets. Fetched
per request (in parallel with the DB read) so it never drifts from the
profile."
```

---

### Task 3: Tile 2 shows the true total

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/followerFlow.ts`
- Modify: `web/src/lib/followerFlow.test.ts`
- Modify: `web/src/components/home/FollowerKpiRow.tsx`
- Modify: `web/src/components/home/FollowerKpiRow.test.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`

**Interfaces:**
- Consumes: `stock.followersTotal` from Task 2.
- Produces: `describeStockVsFlow` projects the milestone off the true total when available.

**Why the milestone changes too:** it currently computes from 4,355 → "8 days to 5,000". Off the true 4,577 it's ~5 days. Leaving it on the subtotal would print a milestone that contradicts the headline directly above it.

- [ ] **Step 1: Write the failing tests**

In `web/src/lib/followerFlow.test.ts`, inside the existing `describe("describeStockVsFlow", ...)`, its `stock` fixture needs `followersTotal`. Add to that fixture: `followersTotal: 4577,` — then append these tests inside the same describe:

```ts
  it("projects the milestone from the true total, not the 45-country subtotal", () => {
    // 4577 -> 5000 is 423 away; at 91/day that's 5 days. From the 4308
    // subtotal it would read 8 — a milestone contradicting the headline.
    const s = describeStockVsFlow({ ...stock, totalCounted: 4308, followersTotal: 4577 }, 91);
    expect(s.nextMilestone).toBe(5000);
    expect(s.daysToNextMilestone).toBe(5);
    expect(s.stockLabel).toBe("4,577");
  });

  it("falls back to the subtotal when the true total is unavailable", () => {
    const s = describeStockVsFlow({ ...stock, totalCounted: 4308, followersTotal: null }, 91);
    expect(s.stockLabel).toBe("4,308");
    expect(s.daysToNextMilestone).toBe(8); // ceil(692/91)
  });
```

In `web/src/components/home/FollowerKpiRow.test.tsx`, add `followersTotal: 4577,` to the `stock` fixture, then append:

```ts
  it("shows Instagram's real follower count, disclosing the reported subtotal", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow} stock={stock} avgPerDay7={91} stats={stats}
        isFlowLoading={false} isStatsLoading={false}
      />,
    );
    expect(html).toContain("4,577");
    // The 45-country number stays visible — we added a truer number, not hid one.
    expect(html).toContain("4,355 across Meta's 45 reported countries");
  });

  it("falls back to the reported subtotal when the profile fetch failed", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow} stock={{ ...stock, followersTotal: null }}
        avgPerDay7={91} stats={stats} isFlowLoading={false} isStatsLoading={false}
      />,
    );
    expect(html).toContain("4,355");
    expect(html).toContain("Counted across Meta's 45 reported countries");
  });
```

Note the existing `stock` fixture in that file has `totalCounted: 4355` — keep it, so the two numbers differ and the assertions are meaningful.

- [ ] **Step 2: Run to verify they fail**

Run (from `web/`): `npm test -- followerFlow FollowerKpiRow`
Expected: FAIL — `followersTotal` not in the type, and the tile shows 4,355 where 4,577 is expected.

- [ ] **Step 3: Implement**

**(a)** `web/src/lib/types.ts` — mirror the backend field on `FollowerStock`:

```ts
export interface FollowerStock {
  capturedAt: string;
  totalCounted: number; // sum across Meta's reported countries, NOT the true total
  followersTotal: number | null; // Instagram's real profile count; null if unfetched
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  countriesReported: number;
}
```

**(b)** `web/src/lib/followerFlow.ts` — in `describeStockVsFlow`, base every figure on the true total when present. Replace the function's first three statements:

```ts
export function describeStockVsFlow(
  stock: FollowerStock,
  avgPerDay7: number | null,
): StockVsFlow {
  // Prefer Instagram's real count; the demographics subtotal undercounts by
  // whatever sits below Meta's ~45-country cutoff, which would make the
  // milestone ETA contradict the headline printed above it.
  const base = stock.followersTotal ?? stock.totalCounted;
  const nextMilestone = (Math.floor(base / 1000) + 1) * 1000;
  const daysToNextMilestone =
    avgPerDay7 !== null && avgPerDay7 > 0
      ? Math.ceil((nextMilestone - base) / avgPerDay7)
      : null;
  return {
    stockLabel: base.toLocaleString("en-US"),
```

The rest of the function body is unchanged.

**(c)** `web/src/components/home/FollowerKpiRow.tsx` — tile 2's `value` and `note`. `milestone.stockLabel` already carries the right number after (b), so use it:

```tsx
      <KpiTile
        label="Total followers"
        value={milestone?.stockLabel ?? "—"}
        context={
          milestone?.sentence ??
          (stock === null
            ? "Waiting for the next follower snapshot"
            : `Next milestone ${numberFormat.format(milestone!.nextMilestone)}`)
        }
        // Two notes, both load-bearing: the daily rate (the trimmed chart panel
        // gave up its own headline) and the 45-country subtotal, so the smaller
        // number stays visible and explained rather than just disappearing.
        note={
          stock === null
            ? null
            : [
                avgPerDay7 === null
                  ? null
                  : `${formatSignedCount(Math.round(avgPerDay7))}/day all regions`,
                stock.followersTotal === null
                  ? `Counted across Meta's ${stock.countriesReported} reported countries`
                  : `${numberFormat.format(stock.totalCounted)} across Meta's ${stock.countriesReported} reported countries`,
              ]
                .filter(Boolean)
                .join(" · ")
        }
        Icon={Trophy}
        tone="sky"
        isLoading={isFlowLoading}
      />
```

**(d)** `web/src/components/home/HomePanels.test.tsx` — add `followersTotal: 4577,` to its `flowStock` fixture so the file typechecks.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: 8 files green; `followerFlow.test.ts` and `FollowerKpiRow.test.tsx` each up by 2.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/followerFlow.ts src/lib/followerFlow.test.ts \
        src/components/home/FollowerKpiRow.tsx src/components/home/FollowerKpiRow.test.tsx \
        src/components/home/HomePanels.test.tsx
git commit -m "feat(web): Total-followers tile shows Instagram's real count

4,577 instead of the 4,355 demographics subtotal, which made the tile
look wrong next to the Instagram profile. The milestone ETA now derives
from the same number (5 days to 5,000, not 8). The 45-country subtotal
stays on the note line, labelled."
```

---

### Task 4: `axisTicks` + opt-in chart gutter

**Files:**
- Modify: `web/src/lib/followerFlow.ts`
- Modify: `web/src/lib/followerFlow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AxisTick { value: number; y: number }
  export function axisTicks(yMin: number, yMax: number, height: number): AxisTick[];
  // chartGeometry gains a 4th param and two returned fields:
  export function chartGeometry(
    points: FollowerDailyAddsPoint[], width?: number, height?: number, gutterLeft?: number,
  ): ChartGeometry;   // ChartGeometry gains: gutterLeft: number; ticks: AxisTick[]
  ```
  Task 5 renders these.

**Why a gutter option instead of changing INSET:** `INSET = 8` is used in the x, y, and width math, and 13 existing `chartGeometry` tests assert coordinates derived from it. `gutterLeft` defaults to `0`, so every existing test keeps passing untouched; only the chart component opts into `34`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/followerFlow.test.ts`:

```ts
describe("axisTicks", () => {
  it("picks round steps and always includes zero", () => {
    const ticks = axisTicks(0, 180, 220);
    expect(ticks.map((t) => t.value)).toContain(0);
    // Nice steps only — no 37s or 43s.
    for (const t of ticks) expect(t.value % 50).toBe(0);
    expect(Math.max(...ticks.map((t) => t.value))).toBeGreaterThanOrEqual(180);
  });

  it("spans negative domains without losing the zero line", () => {
    const ticks = axisTicks(-40, 120, 220);
    const values = ticks.map((t) => t.value);
    expect(values).toContain(0);
    expect(Math.min(...values)).toBeLessThanOrEqual(-40);
  });

  it("maps values to descending y pixels inside the plot", () => {
    const ticks = axisTicks(0, 100, 220);
    const zero = ticks.find((t) => t.value === 0)!;
    const top = ticks.reduce((a, b) => (b.value > a.value ? b : a));
    expect(zero.y).toBeGreaterThan(top.y); // y grows downward
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(zero.y).toBeLessThanOrEqual(220);
  });

  it("returns a usable single tick for a flat all-zero series", () => {
    const ticks = axisTicks(0, 0, 220);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.every((t) => Number.isFinite(t.y))).toBe(true);
  });
});

describe("chartGeometry gutter", () => {
  it("defaults to no gutter so existing coordinates are untouched", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 20, total: 20 }), point({ us: 30, total: 30 })));
    expect(geo.gutterLeft).toBe(0);
    expect(geo.bars[0]!.x).toBeGreaterThanOrEqual(0);
  });

  it("shifts bars right by the gutter and narrows them to fit", () => {
    dayCounter = 0;
    const pts = series(point({ us: 20, total: 20 }), point({ us: 30, total: 30 }));
    const plain = chartGeometry(pts, 720, 220, 0);
    const gutter = chartGeometry(pts, 720, 220, 34);

    expect(gutter.gutterLeft).toBe(34);
    expect(gutter.bars[0]!.x).toBeGreaterThan(plain.bars[0]!.x);
    expect(gutter.bars[0]!.width).toBeLessThan(plain.bars[0]!.width);
    // Right edge still inside the viewBox.
    const last = gutter.bars[gutter.bars.length - 1]!;
    expect(last.x + last.width).toBeLessThanOrEqual(720);
  });

  it("supplies ticks spanning the data domain", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 40, total: 40 }), point({ us: 160, total: 160 })), 720, 220, 34);
    expect(geo.ticks.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...geo.ticks.map((t) => t.value))).toBeGreaterThanOrEqual(160);
  });
});
```

Add `axisTicks` to the file's import from `./followerFlow`.

- [ ] **Step 2: Run to verify they fail**

Run (from `web/`): `npm test -- followerFlow`
Expected: FAIL — `axisTicks is not a function`; `gutterLeft`/`ticks` undefined.

- [ ] **Step 3: Implement**

In `web/src/lib/followerFlow.ts`:

**(a)** Add above `chartGeometry`:

```ts
export interface AxisTick {
  value: number;
  y: number;
}

// 1/2/5 × 10^n — the standard "nice number" ladder, so labels read 50/100/150
// rather than 47/94/141.
const NICE_STEPS = [1, 2, 5];
const TARGET_TICKS = 4;

function niceStep(span: number, target: number): number {
  if (span <= 0) return 1;
  const rough = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const s of NICE_STEPS) {
    if (magnitude * s >= rough) return magnitude * s;
  }
  return magnitude * 10;
}

/**
 * Y-axis ticks for the daily-adds chart, in the same pixel space chartGeometry
 * uses. Always includes zero (the bars are signed — the zero line is the datum
 * the eye reads against) and snaps to round steps.
 */
export function axisTicks(yMin: number, yMax: number, height: number): AxisTick[] {
  const spread = Math.max(yMax - yMin, 1);
  const plotHeight = height - INSET * 2;
  const yOf = (value: number) => round(INSET + ((yMax - value) / spread) * plotHeight);

  const step = niceStep(spread, TARGET_TICKS);
  const first = Math.ceil(yMin / step) * step;
  const ticks: AxisTick[] = [];
  for (let v = first; v <= yMax + step * 0.001; v += step) {
    ticks.push({ value: round(v, 0), y: yOf(v) });
  }
  if (!ticks.some((t) => t.value === 0) && yMin <= 0 && yMax >= 0) {
    ticks.push({ value: 0, y: yOf(0) });
  }
  return ticks.sort((a, b) => a.value - b.value);
}
```

**(b)** Extend `ChartGeometry` with `gutterLeft: number;` and `ticks: AxisTick[];`.

**(c)** Change the signature and the two x-math lines. Signature:

```ts
export function chartGeometry(
  points: FollowerDailyAddsPoint[],
  width = 720,
  height = 220,
  gutterLeft = 0,
): ChartGeometry {
  const slots = Math.max(points.length, 1);
  const plotLeft = INSET + gutterLeft;
  const slotWidth = (width - plotLeft - INSET) / slots;
```

Then replace every remaining `INSET + ` in an **x** expression with `plotLeft + ` — there are three: the measured-bar `x`, the ghost-bar `x`, and the mean-line `x`. Leave all **y** math on `INSET` (the gutter is horizontal only).

**(d)** Add both new fields to the returned object:

```ts
  return {
    bars, meanLine, yMin, yMax, zeroY, width, height,
    gutterLeft,
    ticks: axisTicks(yMin, yMax, height),
  };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- followerFlow`
Expected: PASS — all pre-existing `chartGeometry` tests still green (they pass no gutter, so it's 0), plus 7 new.

- [ ] **Step 5: Commit**

```bash
git add src/lib/followerFlow.ts src/lib/followerFlow.test.ts
git commit -m "feat(web): axis ticks and an opt-in chart gutter

gutterLeft defaults to 0 so all 13 existing chartGeometry tests keep
their coordinates; only the chart opts into the 34px label gutter.
axisTicks snaps to 1/2/5 steps and always keeps the zero line, which is
the datum signed bars are read against."
```

---

### Task 5: Render the axes

**Files:**
- Modify: `web/src/components/home/DailyAddsChart.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`

**Interfaces:**
- Consumes: `geo.ticks`, `geo.gutterLeft` from Task 4.

- [ ] **Step 1: Write the failing test**

In `web/src/components/home/HomePanels.test.tsx`, add inside the `describe("FollowerFlowPanel", ...)` block:

```ts
  it("labels the y-axis so a single day's gain is readable", () => {
    const points = [
      flowPoint("2026-07-20", { us: 40, southAsian: 5, anglosphere: 10, other: 5 }),
      flowPoint("2026-07-21", { us: 120, southAsian: 15, anglosphere: 30, other: 10 }),
      flowPoint("2026-07-22", { us: 80, southAsian: 10, anglosphere: 20, other: 8 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points} stock={flowStock} summary={summary}
        isLoading={false} isError={false} onRetry={() => undefined}
      />,
    );

    // Gridline labels present as <text> in the svg.
    expect(html).toContain("<text");
    expect(html).toMatch(/>1?[05]0</);
    // More than the old 3 date ticks along the bottom.
    expect((html.match(/Jul /g) ?? []).length).toBeGreaterThan(3);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- HomePanels`
Expected: FAIL — no `<text>` gridline labels in the SVG.

- [ ] **Step 3: Implement**

In `web/src/components/home/DailyAddsChart.tsx`:

**(a)** Add the gutter constant beside the existing dimensions:

```tsx
const WIDTH = 720;
const HEIGHT = 220;
// Room for y-axis labels; chartGeometry shifts the plot right by this much.
const GUTTER_LEFT = 34;
```

**(b)** Pass it in: `const geo = chartGeometry(points, WIDTH, HEIGHT, GUTTER_LEFT);`

**(c)** Replace the existing single zero-line `<line>` element with gridlines + labels. The zero line stays visually distinct (it's the datum), so it keeps a stronger stroke:

```tsx
        {geo.ticks.map((tick) => (
          <g key={`tick-${tick.value}`}>
            <line
              x1={geo.gutterLeft + 8}
              y1={tick.y}
              x2={WIDTH - 8}
              y2={tick.y}
              stroke="currentColor"
              strokeOpacity={tick.value === 0 ? 0.28 : 0.08}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={geo.gutterLeft}
              y={tick.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              fillOpacity="0.45"
            >
              {formatSignedCount(tick.value)}
            </text>
          </g>
        ))}
```

Place this block BEFORE the bars so gridlines render behind them.

**(d)** Denser X ticks. Replace the 3-span footer (`first`/`mid`/`last`) with an evenly spaced set. Delete the `const mid = ...` line and swap the footer div for:

```tsx
      <div className="mt-1.5 flex justify-between pl-[34px] text-[10px] text-muted-foreground">
        {xTicks.map((day) => (
          <span key={day}>{tickLabel(day)}</span>
        ))}
      </div>
```

and compute above the `return`, after `const last = ...`:

```tsx
  // ~6 evenly spaced date labels instead of 3, so a bar can be located in time.
  const X_TICK_COUNT = 6;
  const stride = Math.max(1, Math.ceil(points.length / X_TICK_COUNT));
  const xTicks = points.filter((_, i) => i % stride === 0).map((p) => p.day);
  if (xTicks[xTicks.length - 1] !== last) xTicks.push(last);
```

`first` stays used by `ariaLabel`; keep it. If `mid` is now unused, remove it — `noUnusedLocals` will fail the build otherwise.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- HomePanels`
Expected: PASS.

Run: `npm test` (from `web/`)
Expected: all 8 files green.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/home/DailyAddsChart.tsx src/components/home/HomePanels.test.tsx
git commit -m "feat(web): y-axis labels and denser date ticks on the adds chart

You can now read a bar's value instead of only comparing heights. Zero
keeps a stronger stroke since signed bars are read against it. Six date
labels instead of three."
```

---

### Task 6: Verify, then deploy both halves

**Files:** none (verification + deploy)

**This change needs BOTH deploys** — unlike the Home declutter, which was frontend-only. The tile renders `null` and silently falls back to the old subtotal if the backend ships late, so **Railway must go first**.

- [ ] **Step 1: Full verification**

```bash
npm test            # repo root: backend, 13 files
cd web && npm test  # frontend, 8 files
npm run build
```
All must be green before deploying.

- [ ] **Step 2: Confirm the live endpoint shape locally**

Start the API locally and check the new field is present and numeric:

```bash
npm run dev   # repo root, in a separate shell
curl -s localhost:3000/api/insights/follower-daily-adds | python3 -c "import json,sys; s=json.load(sys.stdin)['stock']; print('followersTotal:', s.get('followersTotal'), '| totalCounted:', s.get('totalCounted'))"
```
Expected: `followersTotal` is a number near 4,577 and strictly greater than `totalCounted`. If it's `null`, check the token before deploying — don't ship a tile that silently falls back.

- [ ] **Step 3: Deploy the backend to Railway FIRST**

Per the hardened protocol (a `railway up` once shipped another agent's mid-write files, because it uploads the working directory rather than a git checkout), deploy from a pristine worktree:

```bash
SHA=$(git rev-parse HEAD)
git worktree add /tmp/deploy-$SHA $SHA
cd /tmp/deploy-$SHA
railway link -p 521a9d91-6a89-48f5-8df6-fa4038bc2c81 -s api -e production
railway up --service api --detach
```

Then confirm it booted and the field is live:

```bash
# Wait for SUCCESS, then:
curl -s "$API_BASE/api/insights/follower-daily-adds" | python3 -c "import json,sys; print(json.load(sys.stdin)['stock']['followersTotal'])"
```

Clean up: `git worktree remove /tmp/deploy-$SHA`.

- [ ] **Step 4: Deploy the frontend to Vercel**

The project is NOT Git-connected — pushing to main deploys nothing. Use the CLI:

```bash
cd web && vercel --prod --yes
```

- [ ] **Step 5: Verify in production**

Load the live admin URL. Confirm: the Total-followers tile reads ~4,577 (matching the Instagram profile), its note line shows the smaller 45-country figure, the milestone says ~5 days, and the chart has numbered gridlines with six date labels.

---

## Rollback

Frontend: `vercel rollback` or redeploy the prior deployment id. Backend: redeploy the previous Railway deployment. No migration ran, so there is no schema to unwind — `followersTotal` is computed per request.
