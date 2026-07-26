# Home Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the Home page from five overlapping panels to one glanceable KPI row plus one region chart, relocating automation health to Activity and repeat-reel picks to Insights.

**Architecture:** Pure display refactor of an existing React SPA. One new pure function (`summarizeUsWeekOverWeek`) in `web/src/lib/followerFlow.ts`; two new presentational components; two components relocated to other pages; two components plus two calculation helpers deleted. No backend, API, or database changes — every number already ships in `GET /api/insights/follower-daily-adds` and `GET /api/stats`.

**Tech Stack:** React 19, TypeScript, Vite, TanStack Query v5, Tailwind CSS v4, framer-motion, lucide-react, Vitest 4 (`renderToStaticMarkup` for component assertions — there is no jsdom/RTL in this project).

## Global Constraints

- All work happens in `web/`. Run every command from `/Users/pratik.nandoskar/Documents/working/mch/insta-automation/web`.
- Test command is `npm test` (`vitest run`). Baseline before any change, measured empirically:

  | File | Tests |
  |---|---|
  | `src/lib/followerFlow.test.ts` | 25 |
  | `src/lib/homeDashboard.test.ts` | 15 |
  | `src/components/home/HomePanels.test.tsx` | 11 |
  | `src/lib/growthLab.test.ts` | 10 (untouched by this plan) |
  | **Total** | **61** |
- Component tests use `renderToStaticMarkup` from `react-dom/server` and assert on HTML substrings. Do NOT introduce `@testing-library/react` or jsdom — neither is installed.
- Pure functions in `web/src/lib/` must never call `Date.now()` or `new Date()` with no argument. Time comes in as an ISO string parameter. This keeps them deterministic under `renderToStaticMarkup`.
- `tsconfig.app.json` sets `noUnusedLocals: true` and `noUnusedParameters: true`. A leftover unused import fails `npm run build`.
- The `@/` path alias maps to `web/src/`.
- Signed counts use `formatSignedCount` from `@/lib/followerFlow`, which renders the U+2212 minus (`−`), not ASCII hyphen. Tests asserting negatives must use `−`.
- Provisional (still-settling) follower days are **INCLUDED** in every window sum and rate. This matches `summarizeFollowerFlow` (`includeProvisional: true`) and is load-bearing — see Task 1's rationale.
- Copy rule: never describe follower yield as causal. "followed after getting their guide", never "because of".
- Commit after each task. Use `git add` with explicit paths, never `git add -A`.

---

## File Structure

**Created:**
| Path | Responsibility |
|---|---|
| `web/src/components/home/KpiTile.tsx` | Presentational tile shell: icon, big value, context line, loading/empty states. Zero domain logic. |
| `web/src/components/home/FollowerKpiRow.tsx` | Composes the 3 tiles; maps domain summaries → tile props. |
| `web/src/components/activity/AutomationHealthStrip.tsx` | Relocated from `components/home/`, content unchanged. |
| `web/src/components/insights/RepeatReelsCard.tsx` | Relocated repeat-reel picks, restyled for the Insights page idiom. |

**Modified:**
| Path | Change |
|---|---|
| `web/src/lib/followerFlow.ts` | Add `UsWeekOverWeek` type + `summarizeUsWeekOverWeek`. |
| `web/src/lib/followerFlow.test.ts` | Add `summarizeUsWeekOverWeek` coverage. |
| `web/src/lib/homeDashboard.ts` | Delete `summarizeAudienceGrowth`, `formatAudienceDelta`, `AudienceGrowthSummary`, `AudienceGrowthStatus`, `AudienceGrowthSource`, and the now-orphaned `comparisonFromPoint` helper + `GROWTH_THRESHOLD_POINTS`. |
| `web/src/lib/homeDashboard.test.ts` | Delete the two corresponding `describe` blocks and the `geoPoint` fixture. |
| `web/src/components/home/FollowerFlowPanel.tsx` | Trim to chart + legend + disclaimers. |
| `web/src/components/home/HomePanels.test.tsx` | Retarget onto surviving components. |
| `web/src/pages/Home.tsx` | Drop 2 queries; render KPI row + trimmed panel. |
| `web/src/pages/Activity.tsx` | Add stats query + health strip. |
| `web/src/pages/Insights.tsx` | Add repeat-reels card to Leaderboard tab. |
| `web/src/components/home/PanelShell.tsx` | Make the 600px min-height opt-in. |

**Deleted:** `AudienceGrowthPanel.tsx`, `DashboardSparkline.tsx`, `RepeatReelsPanel.tsx`, `FollowerYieldPanel.tsx`, `components/home/AutomationHealthStrip.tsx`.

**Task order rationale:** Tasks 1–2 build the new pieces bottom-up (pure function, then dumb component) so nothing is referenced before it exists. Tasks 3–4 relocate the two displaced features *before* Task 6 deletes their originals, so no feature is ever absent from the app between commits. Task 5 trims the surviving panel. Task 6 rewires Home and removes the dead code in one commit — this is the only commit where Home changes shape, so it's the natural review gate.

---

### Task 1: `summarizeUsWeekOverWeek` pure function

**Files:**
- Modify: `web/src/lib/followerFlow.ts` (append after `summarizeFollowerFlow`, before the `formatSignedCount` block at line ~162)
- Test: `web/src/lib/followerFlow.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `sumRegions(points, windowDays)` and `round()` — both already in this file. `FollowerDailyAddsPoint` from `./types`.
- Produces:
  ```ts
  export interface UsWeekOverWeek {
    thisWeek: number;              // net US adds, trailing 7 points
    lastWeek: number | null;       // null when prior window has <7 covered days
    deltaCount: number | null;     // thisWeek − lastWeek, null when lastWeek is null
    trend: FlowTrend;              // "accelerating" | "steady" | "slowing"; "steady" when lastWeek null
    coveredDays: number;           // covered days in the this-week window
    provisionalDays: number;       // of coveredDays, how many Meta may still revise
  }
  export function summarizeUsWeekOverWeek(
    points: FollowerDailyAddsPoint[],
  ): UsWeekOverWeek | null;         // null when the this-week window covers 0 days
  ```
  Task 2 renders this. Task 6 calls it.

**Why provisional days are included:** `summarizeFollowerFlow` calls `ratePerDay(..., { includeProvisional: true })`. Commit `126d4ee` changed it *to* true because excluding the newest days made the headline rate disagree with the 7-day region legend printed beside it, and skewed the trend badge (dropping 2 days strips ~29% of a 7-day window but only ~7% of a 28-day baseline). The existing test `"does not flatter the trend by dropping the newest days from the short window"` guards this. The new function must match, and disclose the count via `provisionalDays` instead.

- [ ] **Step 1: Write the failing tests**

Append to the end of `web/src/lib/followerFlow.test.ts`:

```ts
describe("summarizeUsWeekOverWeek", () => {
  it("compares real US counts across two 7-day windows", () => {
    dayCounter = 0;
    const pts = series(
      // last week: 7 days × +20 US = 140
      ...Array.from({ length: 7 }, () => point({ us: 20, total: 20 })),
      // this week: 7 days, 26×6 + 26 = 182 US
      ...Array.from({ length: 6 }, () => point({ us: 26, total: 26 })),
      point({ us: 26, total: 26 }),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(182);
    expect(s.lastWeek).toBe(140);
    expect(s.deltaCount).toBe(42);
    expect(s.coveredDays).toBe(7);
  });

  it("counts still-settling days and reports how many there are", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 7 }, () => point({ us: 20, total: 20 })),
      ...Array.from({ length: 5 }, () => point({ us: 30, total: 30 })),
      point({ us: 8, total: 8, provisional: true }),
      point({ us: 7, total: 7, provisional: true }),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    // 150 + 8 + 7 = 165 — the provisional days count, matching the chart legend.
    expect(s.thisWeek).toBe(165);
    expect(s.provisionalDays).toBe(2);
  });

  it("withholds the comparison when the prior window is short", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 3 }, () => point({ us: 20, total: 20 })),
      ...Array.from({ length: 7 }, () => point({ us: 30, total: 30 })),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(210);
    expect(s.lastWeek).toBeNull();
    expect(s.deltaCount).toBeNull();
    expect(s.trend).toBe("steady");
  });

  it("reads a 15%-or-greater rise as accelerating and a fall as slowing", () => {
    dayCounter = 0;
    const rising = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 116, total: 116 })),
    );
    // band = max(700 × 0.15, 1) = 105; 812 − 700 = 112 ≥ 105.
    expect(summarizeUsWeekOverWeek(rising)!.trend).toBe("accelerating");

    dayCounter = 0;
    const falling = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 80, total: 80 })),
    );
    // 560 − 700 = −140 ≤ −105.
    expect(summarizeUsWeekOverWeek(falling)!.trend).toBe("slowing");

    dayCounter = 0;
    const flat = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 105, total: 105 })),
    );
    // 735 − 700 = 35 < 105.
    expect(summarizeUsWeekOverWeek(flat)!.trend).toBe("steady");
  });

  it("handles a net-negative US week without flipping the trend sign", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 7 }, () => point({ us: 10, total: 10 })),
      ...Array.from({ length: 7 }, () => point({ us: -5, total: -5 })),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(-35);
    expect(s.lastWeek).toBe(70);
    expect(s.deltaCount).toBe(-105);
    expect(s.trend).toBe("slowing");
  });

  it("returns null when no day in the window is measured", () => {
    dayCounter = 0;
    expect(
      summarizeUsWeekOverWeek(series(nullPoint("no_prior_day"), nullPoint("stale"))),
    ).toBeNull();
  });
});
```

Also extend the import at the top of the same file (line 3-9) to include the new function:

```ts
import {
  chartGeometry,
  describeStockVsFlow,
  formatSignedCount,
  ratePerDay,
  summarizeFollowerFlow,
  summarizeUsWeekOverWeek,
} from "./followerFlow";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- followerFlow`
Expected: FAIL. Vitest reports `summarizeUsWeekOverWeek is not a function` (or a TS resolution error on the import) for all 6 new tests. The 20 pre-existing tests in this file still pass.

- [ ] **Step 3: Write the implementation**

In `web/src/lib/followerFlow.ts`, insert this immediately after the closing brace of `summarizeFollowerFlow` (after line 160) and before the `// U+2212 minus` comment:

```ts
export interface UsWeekOverWeek {
  thisWeek: number;
  lastWeek: number | null;
  deltaCount: number | null;
  trend: FlowTrend;
  coveredDays: number;
  provisionalDays: number;
}

const WEEK_DAYS = 7;

/**
 * Net US followers gained this week against last week, in real counts.
 *
 * Answers "is my US audience growing?" without percentage-point arithmetic.
 * Both windows reuse sumRegions, so this tile and the region legend under the
 * chart are computed identically and can never disagree on screen.
 *
 * Provisional (still-settling) days are counted, matching
 * summarizeFollowerFlow's includeProvisional: true — excluding them would make
 * this tile contradict the legend beside it, and would bend the trend by
 * stripping a larger share of the newer window than the older one. The count
 * is surfaced as provisionalDays so the UI can disclose it instead.
 *
 * lastWeek is null (and trend "steady") until the prior window covers a full
 * 7 days — a partial prior window makes the comparison misleading, so we
 * withhold it rather than print a number that reads as a real decline.
 */
export function summarizeUsWeekOverWeek(
  points: FollowerDailyAddsPoint[],
): UsWeekOverWeek | null {
  const current = sumRegions(points, WEEK_DAYS);
  if (current.coveredDays === 0) return null;

  // Slice off the current window by point count (sumRegions windows by points),
  // then measure the 7 points before it.
  const priorPoints = points.slice(0, Math.max(points.length - WEEK_DAYS, 0));
  const prior = sumRegions(priorPoints, WEEK_DAYS);
  const lastWeek = prior.coveredDays >= WEEK_DAYS ? prior.us : null;

  let trend: FlowTrend = "steady";
  if (lastWeek !== null) {
    const band = Math.max(Math.abs(lastWeek) * TREND_RATIO, 1);
    if (current.us - lastWeek >= band) trend = "accelerating";
    else if (current.us - lastWeek <= -band) trend = "slowing";
  }

  return {
    thisWeek: current.us,
    lastWeek,
    deltaCount: lastWeek === null ? null : round(current.us - lastWeek, 0),
    trend,
    coveredDays: current.coveredDays,
    provisionalDays: current.provisionalDays,
  };
}
```

`TREND_RATIO` (0.15) and `round` already exist above in this file — reuse them, do not redeclare.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- followerFlow`
Expected: PASS, 26 tests in this file (20 existing + 6 new).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`
Expected: 4 files, 67 tests passing.

Run: `npm run build`
Expected: exit 0, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/followerFlow.ts src/lib/followerFlow.test.ts
git commit -m "feat(web): week-over-week US follower counts

Answers 'is my US audience growing' in real counts instead of
percentage points. Reuses sumRegions so the tile and the chart legend
can never disagree; counts provisional days like summarizeFollowerFlow
does and reports the count for disclosure."
```

---

### Task 2: `KpiTile` presentational component

**Files:**
- Create: `web/src/components/home/KpiTile.tsx`
- Test: `web/src/components/home/KpiTile.test.tsx`

**Interfaces:**
- Consumes: `Card`/`CardContent` from `@/components/ui/card`, `Skeleton` from `@/components/ui/skeleton`, `cn` from `@/lib/utils`, `LucideIcon` type from `lucide-react`.
- Produces:
  ```ts
  export type KpiTone = "emerald" | "sky" | "violet";
  export interface KpiTileProps {
    label: string;              // small uppercase label, e.g. "US followers this week"
    value: string;              // pre-formatted, e.g. "+182" or "22.3%" or "—"
    context?: string | null;    // one line under the value, e.g. "vs +140 last week"
    note?: string | null;       // dimmer second line, e.g. "newest 2 still settling"
    Icon: LucideIcon;
    tone?: KpiTone;             // default "sky"
    isLoading?: boolean;
    trendIcon?: LucideIcon | null;  // optional arrow rendered beside the value
  }
  export function KpiTile(props: KpiTileProps): React.JSX.Element;
  ```
  Task 6 (via Task 2's row component) renders three of these.

This component holds **no domain logic** — every string arrives pre-formatted. That is what keeps it testable in isolation and reusable for all three tiles.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/home/KpiTile.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArrowUpRight, Users } from "lucide-react";
import { KpiTile } from "./KpiTile";

describe("KpiTile", () => {
  it("renders the label, value, context and note", () => {
    const html = renderToStaticMarkup(
      <KpiTile
        label="US followers this week"
        value="+182"
        context="vs +140 last week"
        note="newest 2 still settling"
        Icon={Users}
        tone="emerald"
        trendIcon={ArrowUpRight}
      />,
    );

    expect(html).toContain("US followers this week");
    expect(html).toContain("+182");
    expect(html).toContain("vs +140 last week");
    expect(html).toContain("newest 2 still settling");
  });

  it("omits the context and note lines when they are absent", () => {
    const html = renderToStaticMarkup(
      <KpiTile label="Total followers" value="4,355" Icon={Users} />,
    );

    expect(html).toContain("4,355");
    expect(html).not.toContain("still settling");
    expect(html).not.toContain("vs ");
  });

  it("renders a skeleton instead of a value while loading", () => {
    const html = renderToStaticMarkup(
      <KpiTile label="Total followers" value="4,355" Icon={Users} isLoading />,
    );

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("4,355");
  });

  it("renders an em dash value without inventing a comparison", () => {
    const html = renderToStaticMarkup(
      <KpiTile
        label="Guide → follow yield"
        value="—"
        context="No non-follower deliveries to measure yet"
        Icon={Users}
      />,
    );

    expect(html).toContain("—");
    expect(html).toContain("No non-follower deliveries to measure yet");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- KpiTile`
Expected: FAIL — `Failed to resolve import "./KpiTile"`.

- [ ] **Step 3: Write the implementation**

Create `web/src/components/home/KpiTile.tsx`:

```tsx
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// A single glanceable stat. Deliberately dumb: every string arrives already
// formatted, so the tile has no opinion about follower math and stays trivially
// testable. Domain formatting lives in FollowerKpiRow.
export type KpiTone = "emerald" | "sky" | "violet";

export interface KpiTileProps {
  label: string;
  value: string;
  context?: string | null;
  note?: string | null;
  Icon: LucideIcon;
  tone?: KpiTone;
  isLoading?: boolean;
  trendIcon?: LucideIcon | null;
}

const TONES: Record<KpiTone, { chip: string; value: string; glow: string }> = {
  emerald: {
    chip: "bg-emerald-400/10 text-emerald-300",
    value: "text-emerald-300",
    glow: "from-emerald-400/12 to-transparent",
  },
  sky: {
    chip: "bg-sky-400/10 text-sky-300",
    value: "text-sky-300",
    glow: "from-sky-400/12 to-transparent",
  },
  violet: {
    chip: "bg-violet-400/10 text-violet-200",
    value: "text-violet-200",
    glow: "from-violet-400/12 to-transparent",
  },
};

export function KpiTile({
  label,
  value,
  context,
  note,
  Icon,
  tone = "sky",
  isLoading = false,
  trendIcon: TrendIcon = null,
}: KpiTileProps) {
  const t = TONES[tone];

  return (
    <Card className="relative overflow-hidden rounded-2xl border-white/10 bg-card/85">
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b", t.glow)} />
      <CardContent className="relative p-5 pt-5">
        <div className="flex items-center gap-2.5">
          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", t.chip)}>
            <Icon className="size-4" />
          </div>
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="mt-4 h-10 w-28" />
        ) : (
          <div className="mt-4 flex items-baseline gap-2">
            <span className={cn("text-4xl font-semibold tracking-[-0.04em] tabular-nums", t.value)}>
              {value}
            </span>
            {TrendIcon && <TrendIcon className={cn("size-5 shrink-0", t.value)} />}
          </div>
        )}

        {!isLoading && context && (
          <p className="mt-2 text-sm leading-snug text-foreground/80">{context}</p>
        )}
        {!isLoading && note && (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{note}</p>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- KpiTile`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/home/KpiTile.tsx src/components/home/KpiTile.test.tsx
git commit -m "feat(web): KpiTile presentational component

Dumb tile — takes pre-formatted strings only, so all follower math stays
in lib/ and the tile is testable in isolation."
```

---

### Task 3: Relocate automation health to Activity

**Files:**
- Create: `web/src/components/activity/AutomationHealthStrip.tsx` (moved content)
- Create: `web/src/components/activity/AutomationHealthStrip.test.tsx`
- Modify: `web/src/pages/Activity.tsx`

**Interfaces:**
- Consumes: `Stats` type from `@/lib/types` (already has `completedToday`, `conversationsAwaiting`, `gateQueuePending`).
- Produces: `AutomationHealthStrip({ stats, isLoading }: { stats: Stats | undefined; isLoading: boolean })`.

The original at `components/home/AutomationHealthStrip.tsx` is **left in place for now** — Task 6 deletes it, so the app never has a moment with the feature missing.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/activity/AutomationHealthStrip.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Stats } from "@/lib/types";
import { AutomationHealthStrip } from "./AutomationHealthStrip";

const stats: Stats = {
  activeKeywords: 8,
  totalKeywords: 10,
  dmsSentToday: 16,
  conversationsAwaiting: 5,
  completedToday: 12,
  lastError: null,
  gateQueuePending: 2,
  gateQueueExhausted: 0,
};

describe("AutomationHealthStrip", () => {
  it("shows the delivery loop counters", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={stats} isLoading={false} />,
    );

    expect(html).toContain("Automation health");
    expect(html).toContain("12");
    expect(html).toContain("Sequences today");
    expect(html).toContain("5");
    expect(html).toContain("Awaiting reply");
    expect(html).toContain("2");
    expect(html).toContain("Retries queued");
  });

  it("degrades to a message when stats are unavailable", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={undefined} isLoading={false} />,
    );
    expect(html).toContain("temporarily unavailable");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- activity`
Expected: FAIL — `Failed to resolve import "./AutomationHealthStrip"`.

- [ ] **Step 3: Move the component file**

```bash
mkdir -p src/components/activity
git mv src/components/home/AutomationHealthStrip.tsx src/components/activity/AutomationHealthStrip.tsx
```

Its imports (`lucide-react`, `@/lib/types`, `@/components/ui/card`, `@/components/ui/skeleton`) are all absolute or package-level, so no import rewriting is needed inside the file. Its content stays byte-identical.

Note: `git mv` breaks `Home.tsx`'s import — that is expected and fixed in Step 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- activity`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into Activity and repair Home's import**

In `web/src/pages/Activity.tsx`:

Change the imports at line 1-2 from:
```tsx
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon } from "lucide-react";
```
to:
```tsx
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon } from "lucide-react";
```

Add to the import block (after the `api` import on line 4):
```tsx
import type { Stats } from "@/lib/types";
import { AutomationHealthStrip } from "@/components/activity/AutomationHealthStrip";
```

Inside `export function Activity()`, after the `eventsQ` declaration (after line 53), add:
```tsx
  // Same key as elsewhere, so this shares one cached fetch across pages.
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
  });
```

Then, in the returned JSX, insert the strip between the page heading `</div>` (line 70) and the `KIND_FILTERS` filter row (line 72):
```tsx
      <AutomationHealthStrip stats={statsQ.data} isLoading={statsQ.isLoading} />
```

In `web/src/pages/Home.tsx`, update the now-broken import on line 10 from:
```tsx
import { AutomationHealthStrip } from "@/components/home/AutomationHealthStrip";
```
to:
```tsx
import { AutomationHealthStrip } from "@/components/activity/AutomationHealthStrip";
```
(Home stops rendering it in Task 6; this keeps the build green in between.)

- [ ] **Step 6: Verify the build and full suite**

Run: `npm run build`
Expected: exit 0.

Run: `npm test`
Expected: 6 files, 73 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/components/activity src/pages/Activity.tsx src/pages/Home.tsx
git commit -m "feat(web): move automation health to Activity

Operational counters belong with the diagnostic feed, not the growth
dashboard. Home still renders it this commit so nothing regresses
mid-refactor; it drops off Home in the Home rewire."
```

---

### Task 4: Relocate repeat-reel picks to Insights

**Files:**
- Create: `web/src/components/insights/RepeatReelsCard.tsx`
- Create: `web/src/components/insights/RepeatReelsCard.test.tsx`
- Modify: `web/src/pages/Insights.tsx`

**Interfaces:**
- Consumes: `rankRepeatCandidates` and the `RepeatCandidate` type from `@/lib/homeDashboard` (both survive the cleanup unchanged).
- Produces: `RepeatReelsCard({ rows, isLoading }: { rows: LeaderboardRow[]; isLoading: boolean })`.

Note the prop shape differs from the old `RepeatReelsPanel` (which took pre-ranked `candidates`). Taking raw `rows` matches the sibling `CaptureLeadersCard` already in `Insights.tsx`, so the card owns its own ranking call and the page stays uniform. Visual treatment follows the Insights page idiom (`rounded-lg border bg-card/40 p-4`), not Home's `PanelShell`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/insights/RepeatReelsCard.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardRow } from "@/lib/types";
import { RepeatReelsCard } from "./RepeatReelsCard";

function reel(overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, "mediaId">): LeaderboardRow {
  const { mediaId, ...rest } = overrides;
  return {
    mediaId,
    caption: "A useful parenting reel",
    thumbnailUrl: null,
    permalink: null,
    postedAt: "2026-07-01T12:00:00.000Z",
    usFitScore: 50,
    confidence: "medium",
    mediaAudioType: null,
    videoUnavailable: false,
    analyzed: true,
    views: null,
    reach: null,
    skipRate: null,
    conversion: { keywordComments: 0, gateDelivered: 0, completed: 0 },
    captureRatePct: null,
    ...rest,
  };
}

describe("RepeatReelsCard", () => {
  it("ranks reels and explains why each one earned the pick", () => {
    const html = renderToStaticMarkup(
      <RepeatReelsCard
        rows={[
          reel({
            mediaId: "a",
            caption: "The bedtime reset that finally worked",
            reach: 9800,
            skipRate: 0.21,
            usFitScore: 78,
            conversion: { keywordComments: 90, gateDelivered: 70, completed: 44 },
          }),
          reel({ mediaId: "b", reach: 1200, skipRate: 0.7 }),
        ]}
        isLoading={false}
      />,
    );

    expect(html).toContain("Which reels should I repeat?");
    expect(html).toContain("The bedtime reset that finally worked");
    expect(html).toContain("9.8K");
    expect(html).toContain("21% skip");
    expect(html).toContain("44 guides");
    expect(html).toContain("US fit 78");
    expect(html).toContain("US-fit is context, not part of the ranking");
  });

  it("explains the wait instead of rendering an empty list", () => {
    const html = renderToStaticMarkup(<RepeatReelsCard rows={[]} isLoading={false} />);
    expect(html).toContain("Not enough measured performance yet");
  });

  it("renders a skeleton while loading", () => {
    const html = renderToStaticMarkup(<RepeatReelsCard rows={[]} isLoading />);
    expect(html).toContain("animate-pulse");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- RepeatReelsCard`
Expected: FAIL — `Failed to resolve import "./RepeatReelsCard"`.

- [ ] **Step 3: Write the implementation**

Create `web/src/components/insights/RepeatReelsCard.tsx`:

```tsx
import { ArrowUpRight, Film, Repeat2, Sparkles } from "lucide-react";
import type { LeaderboardRow } from "@/lib/types";
import { rankRepeatCandidates } from "@/lib/homeDashboard";
import { Skeleton } from "@/components/ui/skeleton";

// Moved off Home (which is now follower-stats only). Takes raw leaderboard rows
// and ranks them itself, matching CaptureLeadersCard's shape so the Insights
// page reads uniformly.
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function RepeatReelsCard({
  rows,
  isLoading,
}: {
  rows: LeaderboardRow[];
  isLoading: boolean;
}) {
  const candidates = rankRepeatCandidates(rows);

  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Repeat2 className="size-4 text-muted-foreground" /> Which reels should I repeat?
      </h3>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Ranked from reach, retention, and guide deliveries. US-fit is context, not part of the
        ranking.
      </p>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-md" />
      ) : candidates.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          Not enough measured performance yet — reels appear here once snapshots include reach,
          skip rate, or guide deliveries.
        </p>
      ) : (
        <ol className="space-y-2">
          {candidates.map((c) => (
            <li key={c.mediaId} className="flex gap-3 rounded-md border bg-background/40 p-2.5">
              <div className="relative aspect-[9/16] w-12 shrink-0 overflow-hidden rounded bg-accent">
                {c.thumbnailUrl ? (
                  <img src={c.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    <Film className="size-4" />
                  </div>
                )}
                <span className="absolute left-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/75 text-[9px] font-bold text-white">
                  {c.rank}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-xs">{c.caption?.trim() || "Untitled reel"}</p>
                  {c.permalink && (
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open reel on Instagram"
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowUpRight className="size-3.5" />
                    </a>
                  )}
                </div>
                <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="mt-0.5 size-3 shrink-0" /> {c.reason}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>{c.reach === null ? "—" : compactNumber.format(c.reach)} reach</span>
                  <span>
                    {c.skipRate === null ? "—" : `${Math.round(c.skipRate * 100)}% skip`}
                  </span>
                  <span className="text-emerald-400">
                    {compactNumber.format(c.conversion.completed)} guides
                  </span>
                  {c.usFitScore !== null && <span>US fit {c.usFitScore}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- RepeatReelsCard`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into the Insights Leaderboard tab**

In `web/src/pages/Insights.tsx`, add to the import block (after line 24's `EmptyState` import):
```tsx
import { RepeatReelsCard } from "@/components/insights/RepeatReelsCard";
```

Then inside `function Leaderboard()`, in its returned JSX, wrap the existing grid so the card sits above it. Replace the opening of the return (currently `return (` / `<>` / `<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">` at lines 177-179) with:

```tsx
  return (
    <>
      <RepeatReelsCard rows={items} isLoading={q.isLoading} />

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
```

The rest of the function body is unchanged. `items` and `q` are already in scope at that point (declared at lines 137-166).

- [ ] **Step 6: Verify the build and full suite**

Run: `npm run build`
Expected: exit 0.

Run: `npm test`
Expected: 7 files, 76 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/components/insights src/pages/Insights.tsx
git commit -m "feat(web): move repeat-reel picks to Insights

Home is becoming follower-stats only. The ranking rules are unchanged;
the card now takes raw rows and ranks them itself, matching
CaptureLeadersCard's shape on the same page."
```

---

### Task 5: Trim `FollowerFlowPanel` to the chart

**Files:**
- Modify: `web/src/components/home/FollowerFlowPanel.tsx`
- Modify: `web/src/components/home/PanelShell.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`

**Interfaces:**
- Consumes: unchanged props — `{ points, stock, summary, isLoading, isError, onRetry, now? }`.
- Produces: same component name and props. `PanelShell` gains an optional prop:
  ```ts
  export function PanelShell({ children, className, tall }: {
    children: React.ReactNode; className?: string; tall?: boolean;
  }): React.JSX.Element;   // tall=true restores the old min-h-[600px]
  ```

**Why:** Task 6 puts the KPI row above this panel. The panel's own headline rate, US-share pair, and stock/milestone row would then print the same numbers twice on one screen — the exact duplication this redesign exists to remove. `stock` stays a required prop: the panel still needs `countriesReported` for its unattributed footnote and `capturedAt` for the staleness pill.

- [ ] **Step 1: Rewrite the panel's assertions in the existing test file**

In `web/src/components/home/HomePanels.test.tsx`, replace the whole `describe("FollowerFlowPanel", ...)` block (lines 146-319) with:

```tsx
describe("FollowerFlowPanel", () => {
  it("shows the region legend and chart without repeating the KPI row's numbers", () => {
    const points = [
      flowPoint("2026-07-19", { us: 10, southAsian: 3, anglosphere: 2, other: 2 }),
      flowPoint("2026-07-20", { us: 28, southAsian: 5, anglosphere: 12, other: 8 }),
      {
        ...flowPoint("2026-07-21", { us: null, southAsian: null, anglosphere: null, other: null }),
        total: null,
        spanDays: null,
        reportedTotalDelta: null,
        unattributed: null,
        stale: true,
        basis: "stale" as const,
      },
      flowPoint("2026-07-22", {
        us: 118,
        southAsian: 20,
        anglosphere: 20,
        other: 10,
        spanDays: 2,
        basis: "multi_day_span",
      }),
    ];
    const summary = summarizeFollowerFlow(points)!;

    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Where your new followers come from");
    expect(html).toContain("South Asia");
    expect(html).toContain("Daily net adds by region");
    expect(html).toContain("Meta did not refresh");

    // The KPI row above owns these now — printing them here too was the
    // duplication this redesign removes. Note the chart's own "Line = 7-day
    // average" caption stays, so assert on the headline's "/day" suffix
    // specifically rather than the bare substring.
    expect(html).not.toContain("Net new followers a day");
    expect(html).not.toContain(">/day<");
    expect(html).not.toContain("US share of ALL followers");
    expect(html).not.toContain("US share of NEW followers");
    expect(html).not.toContain("followers counted");
    expect(html).not.toContain("At this pace");
  });

  it("surfaces unattributed rank-churn as an honest footnote when non-zero", () => {
    const points = [
      flowPoint("2026-07-24", { us: 20, other: 5 }),
      flowPoint("2026-07-25", { us: 30, other: 5, unattributed: 7 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("+7 more Meta counted");
    expect(html).toContain("top-45 reporting cutoff");
  });

  it("warns when the follower feed itself has gone stale", () => {
    const points = [
      flowPoint("2026-07-19", { us: 20 }),
      flowPoint("2026-07-20", { us: 30 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={{ ...flowStock, capturedAt: "2026-07-20T23:00:00.000Z" }}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        now="2026-07-25T12:00:00.000Z"
      />,
    );
    expect(html).toContain("Snapshots");
    expect(html).toContain("days old");
  });

  it("stays quiet when the follower feed is fresh", () => {
    const points = [
      flowPoint("2026-07-24", { us: 20 }),
      flowPoint("2026-07-25", { us: 30 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={{ ...flowStock, capturedAt: "2026-07-25T06:00:00.000Z" }}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        now="2026-07-25T12:00:00.000Z"
      />,
    );
    expect(html).not.toContain("Snapshots as of");
  });

  it("shows the waiting state before two measured days exist", () => {
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={[]}
        stock={null}
        summary={null}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("Waiting for follower snapshots");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- HomePanels`
Expected: FAIL. The first test fails on `expect(html).toContain("Where your new followers come from")` (the panel still says "Who the new followers are (7 days)") and on the four `not.toContain` assertions, since the panel still renders all of those.

- [ ] **Step 3: Trim the panel**

In `web/src/components/home/FollowerFlowPanel.tsx`:

**(a)** Replace the import block at lines 1-13 with (drops `describeStockVsFlow` and the now-unused `numberFormat` deps):
```tsx
import { ArrowDownRight, ArrowRight, ArrowUpRight, Clock, Info, RefreshCw, TrendingUp } from "lucide-react";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import { formatSignedCount, type FollowerFlowSummary } from "@/lib/followerFlow";
import { describeFreshness } from "@/lib/homeDashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DailyAddsChart, REGION_COLORS, REGION_LABELS } from "./DailyAddsChart";
import { EmptyPanel, PanelShell } from "./PanelShell";
```

**(b)** Delete the module-level `const numberFormat = new Intl.NumberFormat("en-US");` (line 53) — only the deleted stock row used it.

**(c)** In the loading branch, change `<Skeleton className="min-h-[600px] rounded-2xl" />` to `<Skeleton className="h-96 rounded-2xl" />` (the trimmed panel is no longer 600px tall).

**(d)** In the two `PanelShell` empty/error branches, pass `tall`: `<PanelShell tall>` (both places), so a "waiting for snapshots" state still fills a sensible area.

**(e)** Delete these local bindings now that nothing reads them (lines 100-104): `stockVsFlow`, `stockUsSharePct`, and `settlingDays`.

**(f)** Replace the panel body — everything from the `<div className="grid items-end gap-5 sm:grid-cols-[auto_1fr]">` opening (line 135) through the closing `</div>` of the stock/milestone row (line 207) — with just the legend and chart:

```tsx
        <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-3">
          <div className="text-xs text-muted-foreground">
            Where your new followers come from (7 days)
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {regionLegend.map(({ key, sum }) => (
              <span key={key} className="inline-flex items-center gap-1.5 text-xs text-foreground">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: REGION_COLORS[key] }} />
                <span className="font-semibold tabular-nums">{formatSignedCount(sum)}</span>
                <span className="text-muted-foreground">{REGION_LABELS[key]}</span>
              </span>
            ))}
          </div>
          {summary.window7.unattributed !== 0 && (
            <p className="mt-2 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {formatSignedCount(summary.window7.unattributed)} more Meta counted but couldn't place —
              countries crossing its top-{stock.countriesReported} reporting cutoff.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">Daily net adds by region</span>
            <span className="text-muted-foreground">Line = 7-day average</span>
          </div>
          <DailyAddsChart points={points} />
        </div>
```

The header block (lines 116-133: title, trend badge, freshness pill) and the closing violet `Info` disclaimer (lines 209-216) are kept exactly as-is.

**(g)** Change the panel's `<h2>` (line 121) from `How many new followers a day?` to `Where are your followers coming from?` — the daily rate now lives in the KPI row, so the old question no longer matches what the panel shows.

- [ ] **Step 4: Make `PanelShell`'s min-height opt-in**

In `web/src/components/home/PanelShell.tsx`, replace the `PanelShell` function (lines 9-15) with:

```tsx
export function PanelShell({
  children,
  className,
  tall = false,
}: {
  children: React.ReactNode;
  className?: string;
  // Empty/error states still want a generous box; the populated chart panel is
  // much shorter than the old all-in-one panel and a 600px floor left a gap.
  tall?: boolean;
}) {
  return (
    <Card
      className={cn(
        "rounded-2xl border-white/10 bg-card/85 shadow-xl shadow-black/10",
        tall && "min-h-[600px]",
        className,
      )}
    >
      <CardContent className="p-5 sm:p-6">{children}</CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- HomePanels`
Expected: PASS. The `FollowerFlowPanel` describe block's 5 tests pass. The `AudienceGrowthPanel`, `RepeatReelsPanel`, and `AutomationHealthStrip` blocks in this file still pass too (they are removed in Task 6).

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: exit 0. If it reports an unused import or variable, remove it — `noUnusedLocals` is on.

- [ ] **Step 7: Commit**

```bash
git add src/components/home/FollowerFlowPanel.tsx src/components/home/PanelShell.tsx src/components/home/HomePanels.test.tsx
git commit -m "refactor(web): trim FollowerFlowPanel to its chart

The KPI row now owns the daily rate, US shares, and the milestone, so
keeping them here would print each number twice on one screen. Panel
keeps the chart, legend, freshness pill and Meta-lag caveats."
```

---

### Task 6: Rewire Home to the KPI row and delete the dead code

**Files:**
- Create: `web/src/components/home/FollowerKpiRow.tsx`
- Create: `web/src/components/home/FollowerKpiRow.test.tsx`
- Modify: `web/src/pages/Home.tsx`
- Modify: `web/src/lib/homeDashboard.ts`
- Modify: `web/src/lib/homeDashboard.test.ts`
- Modify: `web/src/components/home/HomePanels.test.tsx`
- Delete: `web/src/components/home/AudienceGrowthPanel.tsx`, `web/src/components/home/DashboardSparkline.tsx`, `web/src/components/home/RepeatReelsPanel.tsx`, `web/src/components/home/FollowerYieldPanel.tsx`, `web/src/components/home/AutomationHealthStrip.tsx`

**Interfaces:**
- Consumes: `KpiTile`/`KpiTileProps` (Task 2), `summarizeUsWeekOverWeek`/`UsWeekOverWeek` (Task 1), `describeStockVsFlow` + `formatSignedCount` (existing `followerFlow.ts`), `summarizeFollowerYield` (existing `homeDashboard.ts`), `FollowerStock` + `Stats` types.
- Produces:
  ```ts
  export function FollowerKpiRow(props: {
    weekOverWeek: UsWeekOverWeek | null;
    stock: FollowerStock | null;
    avgPerDay7: number | null;     // feeds the milestone ETA
    stats: Stats | undefined;
    isFlowLoading: boolean;
    isStatsLoading: boolean;
  }): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/src/components/home/FollowerKpiRow.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerStock, Stats } from "@/lib/types";
import type { UsWeekOverWeek } from "@/lib/followerFlow";
import { FollowerKpiRow } from "./FollowerKpiRow";

const stock: FollowerStock = {
  capturedAt: "2026-07-25T23:24:27.681Z",
  totalCounted: 4355,
  us: 1489,
  southAsian: 1278,
  anglosphere: 817,
  other: 771,
  countriesReported: 45,
};

const stats: Stats = {
  activeKeywords: 8,
  totalKeywords: 10,
  dmsSentToday: 16,
  conversationsAwaiting: 5,
  completedToday: 12,
  lastError: null,
  gateQueuePending: 2,
  gateQueueExhausted: 0,
  followConversion: {
    windowDays: 30,
    deliveredToNonFollowers: 112,
    rechecked: 112,
    converted: 25,
    pending: 0,
    yieldPct: 22.3,
  },
};

const wow: UsWeekOverWeek = {
  thisWeek: 182,
  lastWeek: 140,
  deltaCount: 42,
  trend: "accelerating",
  coveredDays: 7,
  provisionalDays: 0,
};

describe("FollowerKpiRow", () => {
  it("answers US growth in real counts, not percentage points", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );

    expect(html).toContain("US followers this week");
    expect(html).toContain("+182");
    expect(html).toContain("vs +140 last week");
    expect(html).not.toContain("percentage points");
  });

  it("discloses still-settling days rather than hiding them", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={{ ...wow, provisionalDays: 2 }}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("newest 2 still settling");
  });

  it("withholds the comparison when there is not enough history", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={{ ...wow, lastWeek: null, deltaCount: null, trend: "steady" }}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("Not enough history yet for a week-over-week read");
    expect(html).not.toContain("vs +140 last week");
  });

  it("shows the total-follower milestone and its pace", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("4,355");
    expect(html).toContain("5,000");
    expect(html).toContain("At this pace");
  });

  it("keeps the all-regions daily rate that the trimmed chart panel gave up", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    // "How many followers were added a day" is a must-have; trimming the panel
    // removed its +108/day headline, so this tile has to carry it.
    expect(html).toContain("+108/day all regions");
  });

  it("shows the guide-to-follow yield without claiming causation", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("22.3%");
    expect(html).toContain("25 of 112");
    expect(html).toContain("followed after");
    expect(html).not.toContain("because");
  });

  it("degrades each tile independently when its feed is missing", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={null}
        stock={null}
        avgPerDay7={null}
        stats={undefined}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("Needs two days of follower geography");
    expect(html).toContain("—");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- FollowerKpiRow`
Expected: FAIL — `Failed to resolve import "./FollowerKpiRow"`.

- [ ] **Step 3: Write `FollowerKpiRow`**

Create `web/src/components/home/FollowerKpiRow.tsx`:

```tsx
import { ArrowDownRight, ArrowRight, ArrowUpRight, Trophy, UserPlus, Users } from "lucide-react";
import type { FollowerStock, Stats } from "@/lib/types";
import {
  describeStockVsFlow,
  formatSignedCount,
  type FlowTrend,
  type UsWeekOverWeek,
} from "@/lib/followerFlow";
import { summarizeFollowerYield } from "@/lib/homeDashboard";
import { KpiTile } from "./KpiTile";

// The three numbers Home exists to answer: is the US audience growing, how big
// is the account, and does the guide funnel earn follows. Formatting lives here
// so KpiTile stays a dumb shell.
const TREND_ICON: Record<FlowTrend, typeof ArrowUpRight> = {
  accelerating: ArrowUpRight,
  steady: ArrowRight,
  slowing: ArrowDownRight,
};

const numberFormat = new Intl.NumberFormat("en-US");

interface FollowerKpiRowProps {
  weekOverWeek: UsWeekOverWeek | null;
  stock: FollowerStock | null;
  avgPerDay7: number | null;
  stats: Stats | undefined;
  isFlowLoading: boolean;
  isStatsLoading: boolean;
}

export function FollowerKpiRow({
  weekOverWeek,
  stock,
  avgPerDay7,
  stats,
  isFlowLoading,
  isStatsLoading,
}: FollowerKpiRowProps) {
  const milestone = stock ? describeStockVsFlow(stock, avgPerDay7) : null;
  const yieldSummary = summarizeFollowerYield(stats?.followConversion);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiTile
        label="US followers this week"
        value={weekOverWeek === null ? "—" : formatSignedCount(weekOverWeek.thisWeek)}
        context={
          weekOverWeek === null
            ? "Needs two days of follower geography"
            : weekOverWeek.lastWeek === null
              ? "Not enough history yet for a week-over-week read"
              : `vs ${formatSignedCount(weekOverWeek.lastWeek)} last week`
        }
        note={
          weekOverWeek && weekOverWeek.provisionalDays > 0
            ? `newest ${weekOverWeek.provisionalDays} still settling`
            : null
        }
        Icon={Users}
        tone="emerald"
        isLoading={isFlowLoading}
        trendIcon={
          weekOverWeek && weekOverWeek.lastWeek !== null
            ? TREND_ICON[weekOverWeek.trend]
            : null
        }
      />

      <KpiTile
        label="Total followers"
        value={stock === null ? "—" : numberFormat.format(stock.totalCounted)}
        context={
          milestone?.sentence ??
          (stock === null
            ? "Waiting for the next follower snapshot"
            : `Next milestone ${numberFormat.format(milestone!.nextMilestone)}`)
        }
        // The trimmed flow panel no longer prints its own "+108/day" headline,
        // and the daily rate is a must-have number — it lives here, beside the
        // milestone ETA that is derived from it.
        note={
          avgPerDay7 === null
            ? null
            : `${formatSignedCount(Math.round(avgPerDay7))}/day all regions`
        }
        Icon={Trophy}
        tone="sky"
        isLoading={isFlowLoading}
      />

      <KpiTile
        label="Guide → follow yield"
        value={
          yieldSummary?.state === "measured" && yieldSummary.yieldPct !== null
            ? `${yieldSummary.yieldPct}%`
            : "—"
        }
        context={
          yieldSummary === null
            ? "Follower yield is temporarily unavailable"
            : yieldSummary.state === "measured"
              ? `${yieldSummary.converted} of ${yieldSummary.rechecked} non-followers followed after getting their guide`
              : yieldSummary.headline
        }
        note={
          yieldSummary?.state === "measured" && yieldSummary.pending > 0
            ? `${yieldSummary.pending} still measuring`
            : null
        }
        Icon={UserPlus}
        tone="violet"
        isLoading={isStatsLoading}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- FollowerKpiRow`
Expected: PASS, 7 tests.

- [ ] **Step 5: Rewrite `Home.tsx`**

Replace the entire contents of `web/src/pages/Home.tsx` with:

```tsx
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowUpRight, CalendarDays, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { FollowerFlowResponse, Stats } from "@/lib/types";
import { summarizeFollowerFlow, summarizeUsWeekOverWeek } from "@/lib/followerFlow";
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FollowerKpiRow } from "@/components/home/FollowerKpiRow";
import { Button } from "@/components/ui/button";

const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function Home() {
  const flowQ = useQuery<FollowerFlowResponse>({
    queryKey: ["insights", "follower-daily-adds"],
    queryFn: () => api<FollowerFlowResponse>("/insights/follower-daily-adds"),
  });
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
  });

  const flowPoints = flowQ.data?.points ?? [];
  const flowStock = flowQ.data?.stock ?? null;
  const flowSummary = summarizeFollowerFlow(flowPoints);
  const weekOverWeek = summarizeUsWeekOverWeek(flowPoints);

  const updatedLabel = flowStock
    ? new Date(flowStock.capturedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Waiting for the next snapshot";

  return (
    <div className="relative space-y-6 pb-6">
      <div className="pointer-events-none absolute -left-32 -top-32 -z-10 size-80 rounded-full bg-emerald-400/5 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-24 -z-10 size-72 rounded-full bg-sky-400/5 blur-3xl" />

      <motion.header
        {...fadeUp}
        transition={{ duration: 0.24 }}
        className="flex flex-col gap-5 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.055] to-transparent p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6"
      >
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-violet-300">
            <Sparkles className="size-4" /> Growth snapshot
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
            Who you gained.<br className="hidden sm:block" /> And where they came from.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Your followers day by day, by region — in real counts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/10 px-3 py-2 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" /> Updated {updatedLabel}
          </div>
          <Button asChild variant="outline" size="sm" className="rounded-full bg-black/10">
            <Link to="/insights">Full insights <ArrowUpRight className="size-3.5" /></Link>
          </Button>
        </div>
      </motion.header>

      <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.05 }}>
        <FollowerKpiRow
          weekOverWeek={weekOverWeek}
          stock={flowStock}
          avgPerDay7={flowSummary?.avgPerDay7 ?? null}
          stats={statsQ.data}
          isFlowLoading={flowQ.isLoading}
          isStatsLoading={statsQ.isLoading}
        />
      </motion.div>

      <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.1 }}>
        <FollowerFlowPanel
          points={flowPoints}
          stock={flowStock}
          summary={flowSummary}
          isLoading={flowQ.isLoading}
          isError={flowQ.isError}
          onRetry={() => void flowQ.refetch()}
          now={new Date().toISOString()}
        />
      </motion.div>
    </div>
  );
}
```

- [ ] **Step 6: Delete the four dead Home components**

```bash
git rm src/components/home/AudienceGrowthPanel.tsx \
       src/components/home/DashboardSparkline.tsx \
       src/components/home/RepeatReelsPanel.tsx \
       src/components/home/FollowerYieldPanel.tsx
```

Do NOT delete `src/components/activity/AutomationHealthStrip.tsx` — Task 3 moved that file there and Activity renders it. The old `src/components/home/AutomationHealthStrip.tsx` no longer exists (Task 3's `git mv` removed it), so it is not in this list.

- [ ] **Step 7: Remove the orphaned calculations from `homeDashboard.ts`**

In `web/src/lib/homeDashboard.ts`, delete:
- the `AudienceGrowthStatus`, `AudienceGrowthSource` type aliases (lines 3-4)
- the `AudienceGrowthSummary` interface (lines 7-15)
- the `GROWTH_THRESHOLD_POINTS` const (line 29)
- the `comparisonFromPoint` function (lines 41-53)
- `summarizeAudienceGrowth` (lines 55-82)
- `formatAudienceDelta` (lines 84-88)

Then update the top import (line 1) — `GeoWindowPoint` is no longer referenced anywhere in the file:
```ts
import type { FollowConversion, LeaderboardRow } from "./types";
```

Everything else in the file (`RepeatCandidate`, `isNumber`, `round`, `describeFreshness`, `FreshnessSummary`, `FollowerYieldSummary`, `summarizeFollowerYield`, `percentile`, `measured`, `chooseReason`, `REASONS`, `rankRepeatCandidates`, `REPEAT_LIMIT`) stays — all still have live callers.

- [ ] **Step 8: Prune the orphaned tests**

In `web/src/lib/homeDashboard.test.ts`:
- delete the `describe("summarizeAudienceGrowth", ...)` block (lines 45-93)
- delete the `describe("formatAudienceDelta", ...)` block (lines 95-100)
- delete the `geoPoint` fixture function (lines 10-21) — only those blocks used it
- update the imports (lines 2-8) to:
  ```ts
  import type { FollowConversion, LeaderboardRow } from "./types";
  import { rankRepeatCandidates, summarizeFollowerYield } from "./homeDashboard";
  ```

In `web/src/components/home/HomePanels.test.tsx`:
- delete `describe("AudienceGrowthPanel", ...)` (lines 65-87)
- delete `describe("RepeatReelsPanel", ...)` (lines 89-110)
- delete `describe("AudienceGrowthPanel staleness pill", ...)` (lines 322-336)
- delete `describe("AutomationHealthStrip", ...)` (lines 338-364) — covered now by `components/activity/AutomationHealthStrip.test.tsx`
- delete the `points` fixture (lines 11-30), the `summary` fixture (lines 32-40), and the `candidate` fixture (lines 42-63)
- update the imports (lines 1-9) to:
  ```tsx
  import { renderToStaticMarkup } from "react-dom/server";
  import { describe, expect, it } from "vitest";
  import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
  import { summarizeFollowerFlow } from "@/lib/followerFlow";
  import { FollowerFlowPanel } from "./FollowerFlowPanel";
  ```

`flowPoint` and `flowStock` (lines 112-144) stay — the surviving `FollowerFlowPanel` tests use them.

- [ ] **Step 9: Verify nothing references the deleted symbols**

Run:
```bash
grep -rn "AudienceGrowthPanel\|DashboardSparkline\|RepeatReelsPanel\|FollowerYieldPanel\|summarizeAudienceGrowth\|formatAudienceDelta\|geo-window-trend" src/pages/Home.tsx src/components/home/ src/lib/homeDashboard.ts
```
Expected: **no output.** (`geo-window-trend` still legitimately appears in `src/pages/Insights.tsx` — that's why the grep is scoped to Home's files.)

- [ ] **Step 10: Run the full suite and build**

Run: `npm test`
Expected: **8 files, 77 tests.** The arithmetic, from the measured baseline (each removed count verified against the real suite, not estimated):

| Change | Δ |
|---|---|
| Baseline | 61 |
| Task 1 `summarizeUsWeekOverWeek` | +6 |
| Task 2 `KpiTile` | +4 |
| Task 3 `AutomationHealthStrip` (activity) | +2 |
| Task 4 `RepeatReelsCard` | +3 |
| Task 5 `FollowerFlowPanel` 7 → 5 | −2 |
| Task 6 `FollowerKpiRow` | +7 |
| − `describe("AudienceGrowthPanel")` | −1 |
| − `describe("RepeatReelsPanel")` | −1 |
| − `describe("AudienceGrowthPanel staleness pill")` | −1 |
| − `describe("AutomationHealthStrip")` (Home copy) | −1 |
| − `describe("summarizeAudienceGrowth")` | −4 |
| − `describe("formatAudienceDelta")` | −1 |
| **Total** | **77** |

If your count differs, reconcile before committing — a surprise delta means a test was dropped by accident.

Run: `npm run build`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0. If it reports pre-existing failures in files this plan never touched, note them in the commit body rather than fixing them here.

- [ ] **Step 11: Commit**

```bash
git add -u src/
git add src/components/home/FollowerKpiRow.tsx src/components/home/FollowerKpiRow.test.tsx
git commit -m "feat(web): Home is a KPI row and one chart

Five overlapping panels become three glanceable tiles plus the region
chart. US growth now reads as real week-over-week counts instead of
percentage points vs a 90-day baseline, which was the framing that made
the old panel hard to act on.

Removes AudienceGrowthPanel (duplicated the US-growth question and
overlapped Insights' Experiments tab), its sparkline, and the two panels
relocated to Activity and Insights. Home now fetches 2 endpoints
instead of 4."
```

---

### Task 7: Verify in the running app

**Files:** none (verification only)

**Interfaces:** none.

Static tests can't catch a layout that technically renders but looks wrong. This task is the visual gate.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite serves on `http://localhost:5173`.

- [ ] **Step 2: Check Home**

Load `http://localhost:5173/`. Confirm:
- Three KPI tiles sit in one row above a single chart panel.
- No number appears twice on the page (in particular: no `/day` headline, no "US share of ALL followers", no "followers counted" row inside the chart panel).
- No "Automation health" strip and no reel thumbnails.
- The whole page fits in roughly one to one-and-a-half screens — the original needed three screenshots.

- [ ] **Step 3: Check the relocated features**

Load `/activity` — the "Automation health" strip renders above the event filters.
Load `/insights` — the Leaderboard tab shows "Which reels should I repeat?" above the reel grid.

- [ ] **Step 4: Check narrow widths**

Resize to ~375px wide. The three tiles stack to one column; the chart stays legible; nothing overflows horizontally.

- [ ] **Step 5: Stop the server and report**

Stop the dev server. Report what you saw, including anything that looked off. If a fix is needed, make it, re-run `npm test` and `npm run build`, and commit separately.

---

## Rollback

Every task is one commit and no schema or API changed, so `git revert <sha>` on the Task 6 commit restores the old Home while keeping the relocated Activity/Insights features. To undo the whole change, revert Tasks 6→1 in reverse order.
