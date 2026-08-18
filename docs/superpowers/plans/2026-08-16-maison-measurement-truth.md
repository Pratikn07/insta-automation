# Maison Measurement Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Home interpretation depend on complete comparable evidence, rank the funnel’s actual largest measured loss, and prevent loading or failed data from rendering as an all-clear.

**Architecture:** Pure calendar-window and funnel-ranking functions produce explicit discriminated results. A separate Home evidence-state module combines React Query source states without treating missing data as empty data; `Home.tsx` renders those contracts and keeps independently reliable sections visible.

**Tech Stack:** TypeScript, React 19, TanStack Query, React Router, Vitest, Testing Library, Vite.

**Spec:** [Maison Editorial production-readiness design](../specs/2026-08-16-maison-editorial-production-readiness-design.md), especially §1 and “Measurement contracts.”

## Global Constraints

- Analytics dates are Pacific date keys (`YYYY-MM-DD`); perform date-key arithmetic in UTC so the browser timezone cannot shift a day.
- A comparative week contains exactly seven distinct, contiguous `diff` points with `spanDays === 1`, non-null US counts, and `provisional === false`.
- Any missing, provisional, duplicate, stale, pending, no-snapshot, no-prior-day, or `multi_day_span` point withholds interpretation; do not backshift around it.
- Descriptive charts keep provisional and multi-day data with their existing qualifications. This plan narrows only interpretive week-over-week claims.
- Funnel loss is ranked by absolute measured people lost. `bypassable` and `coverageOnly` transitions are never candidates.
- “All clear,” “nothing is waiting,” and equivalent reassurance require successful follower-flow, stats, and funnel responses.
- One failed source does not erase successful sections or verified attention items.
- No new dependency is required.

---

## Planned File Structure

### Create

- `web/src/lib/homeAttention.ts` — pure source-readiness and attention ranking contract.
- `web/src/lib/homeAttention.test.ts` — loading/error/success cross-product tests.
- `web/src/pages/Home.test.tsx` — component-level request-state and copy regression tests.

### Modify

- `web/src/lib/followerFlow.ts` — calendar-key window comparison and discriminated result.
- `web/src/lib/followerFlow.test.ts` — complete, missing, provisional, duplicate, and span coverage.
- `web/src/lib/todaysRead.ts` — dated qualification and dynamic funnel-loss ranking.
- `web/src/lib/todaysRead.test.ts` — ranking, ineligible stage, and date-label contracts.
- `web/src/pages/Home.tsx` — consume explicit read/attention states and render partial failure honestly.
- `PRODUCT.md` — record complete-window and Home all-clear rules.

---

### Task 1: Replace point-count week summaries with comparable Pacific calendar windows

**Files:**

- Modify: `web/src/lib/followerFlow.ts:229-287`
- Modify: `web/src/lib/followerFlow.test.ts:374-462`

**Interfaces:**

- Produces: `ComparableWeek`, `ComparableWeekResult`, and `compareSettledUsWeeks(points)`.
- Consumed by: Task 2’s `composeTodaysRead` and Task 4’s Home rendering.

- [ ] **Step 1: Replace the existing happy-path fixture with dated single-day points**

Add a helper beside the existing follower-flow test fixtures:

```ts
function settledDay(day: string, us: number): FollowerDailyAddsPoint {
  return point({
    day,
    us,
    total: us,
    reportedTotalDelta: us,
    spanDays: 1,
    basis: "diff",
    stale: false,
    provisional: false,
  });
}

function settledFortnight(): FollowerDailyAddsPoint[] {
  return Array.from({ length: 14 }, (_, index) =>
    settledDay(`2026-08-${String(index + 1).padStart(2, "0")}`, index < 7 ? 10 : 20),
  );
}
```

- [ ] **Step 2: Write failing eligibility tests**

Replace tests that accept partial current coverage with these contracts:

```ts
it("compares two exact contiguous settled Pacific weeks", () => {
  expect(compareSettledUsWeeks(settledFortnight())).toMatchObject({
    status: "ready",
    current: { from: "2026-08-08", to: "2026-08-14", coveredDays: 7, us: 140 },
    prior: { from: "2026-08-01", to: "2026-08-07", coveredDays: 7, us: 70 },
  });
});

it.each([
  ["missing_day", (p: FollowerDailyAddsPoint[]) => p.filter((x) => x.day !== "2026-08-10")],
  ["provisional_day", (p: FollowerDailyAddsPoint[]) => p.map((x) => x.day === "2026-08-14" ? { ...x, provisional: true } : x)],
  ["multi_day_span", (p: FollowerDailyAddsPoint[]) => p.map((x) => x.day === "2026-08-14" ? { ...x, basis: "multi_day_span" as const, spanDays: 2 } : x)],
])("withholds for %s", (reason, change) => {
  expect(compareSettledUsWeeks(change(settledFortnight()))).toMatchObject({
    status: "insufficient",
    reason,
  });
});

it("withholds a duplicated date rather than silently selecting one", () => {
  const points = settledFortnight();
  points.push({ ...points.at(-1)! });
  expect(compareSettledUsWeeks(points)).toMatchObject({
    status: "insufficient",
    reason: "duplicate_day",
  });
});

it("does not backshift around provisional newest days", () => {
  const points = settledFortnight().map((x) =>
    x.day >= "2026-08-13" ? { ...x, provisional: true } : x,
  );
  expect(compareSettledUsWeeks(points)).toMatchObject({
    status: "insufficient",
    reason: "provisional_day",
  });
});
```

- [ ] **Step 3: Run the focused tests and verify the old summarizer fails**

Run:

```bash
npm --prefix web test -- src/lib/followerFlow.test.ts
```

Expected: the new symbol is absent or the existing implementation incorrectly returns a comparison for incomplete/provisional/span inputs.

- [ ] **Step 4: Add calendar-key helpers and discriminated types**

Add to `followerFlow.ts`:

```ts
export interface ComparableWeek {
  from: string;
  to: string;
  days: string[];
  us: number;
  coveredDays: 7;
}

export type ComparableWeekResult =
  | {
      status: "ready";
      current: ComparableWeek;
      prior: ComparableWeek;
      changePct: number | null;
      trend: FlowTrend;
    }
  | {
      status: "insufficient";
      reason:
        | "missing_day"
        | "provisional_day"
        | "multi_day_span"
        | "duplicate_day"
        | "not_enough_history";
      currentCoveredDays: number;
      priorCoveredDays: number;
    };

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function expectedDays(to: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDay(to, index - count + 1));
}
```

Sort a copy of the points by `day`, reject duplicate keys before building a map, anchor the fourteen expected dates to the newest point’s date, and inspect every expected date. Return the first deterministic reason in this order: insufficient history, duplicate, missing/non-measured, multi-day span, provisional.

Calculate percentage change only when the prior US total is positive. Preserve the existing 15% trend band for `accelerating`/`slowing`; otherwise return `steady`.

- [ ] **Step 5: Remove `UsWeekOverWeek` and its point-slice implementation**

Delete `lastWeek: null` fallback semantics from the interpretive path. Keep `sumRegions`, `ratePerDay`, and the descriptive chart summaries unchanged. Rename imports and tests from `summarizeUsWeekOverWeek` to `compareSettledUsWeeks`.

- [ ] **Step 6: Run the complete follower-flow tests**

```bash
npm --prefix web test -- src/lib/followerFlow.test.ts
```

Expected: PASS, including existing descriptive chart/rate behavior.

- [ ] **Step 7: Commit the calendar comparison**

```bash
git add web/src/lib/followerFlow.ts web/src/lib/followerFlow.test.ts
git commit -m "fix: require comparable calendar weeks for home read"
```

---

### Task 2: Rank the funnel’s actual measured loss and compose dated evidence

**Files:**

- Modify: `web/src/lib/todaysRead.ts`
- Modify: `web/src/lib/todaysRead.test.ts`

**Interfaces:**

- Consumes: `ComparableWeekResult` from Task 1 and `GuideFollowResult`.
- Produces: `FunnelLoss`, `largestMeasuredFunnelLoss(funnel)`, and updated `composeTodaysRead`.
- Consumed by: Task 3’s attention ranking and Task 4’s Home UI.

- [ ] **Step 1: Add a funnel fixture whose declared headline is not the largest loss**

Extend `todaysRead.test.ts` with stages:

```ts
function rankedFunnel(): GuideFollowResult {
  return {
    ...funnel(43),
    stages: [
      stage("entered", "Entered", 100),
      stage("gateSent", "Gate sent", 92),
      stage("replied", "Replied", 40),
      stage("guideDelivered", "Guide delivered", 35),
      stage("followingD21", "Following at day 21", 5, { coverageOnly: true }),
    ],
  };
}
```

Use a local `stage` helper that returns every required `FunnelStageCount` field.

- [ ] **Step 2: Write failing loss-ranking and qualification tests**

```ts
it("ranks the largest eligible absolute stage loss", () => {
  expect(largestMeasuredFunnelLoss(rankedFunnel())).toMatchObject({
    fromStage: "gateSent",
    toStage: "replied",
    denominator: 92,
    numerator: 40,
    lost: 52,
  });
});

it("excludes bypassable and coverage-only transitions", () => {
  const result = rankedFunnel();
  result.stages[2]!.bypassable = true;
  expect(largestMeasuredFunnelLoss(result)?.toStage).toBe("guideDelivered");
});

it("derives the week qualification from actual dates", () => {
  const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
  expect(read.headlineWindow).toBe("Aug 8–14 against Aug 1–7");
});

it("prints no interpretation for insufficient comparison evidence", () => {
  expect(composeTodaysRead(insufficientWeek("provisional_day"), rankedFunnel())).toBeNull();
});

it("does not call the predefined headline the largest loss", () => {
  const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
  expect(read.because).toContain("52 of 92");
  expect(read.because).toContain("gate sent and replied");
});
```

- [ ] **Step 3: Run the composer tests and verify they fail**

```bash
npm --prefix web test -- src/lib/todaysRead.test.ts
```

Expected: the existing composer uses `funnel.headline`, hardcodes the window label, and accepts the old nullable summary.

- [ ] **Step 4: Implement the pure loss selector**

Add:

```ts
export interface FunnelLoss {
  fromStage: string;
  toStage: string;
  fromLabel: string;
  toLabel: string;
  denominator: number;
  numerator: number;
  lost: number;
}

export function largestMeasuredFunnelLoss(funnel: GuideFollowResult): FunnelLoss | null {
  const candidates = funnel.stages.slice(1).flatMap((stage, index) => {
    const previous = funnel.stages[index]!;
    if (stage.bypassable || stage.coverageOnly) return [];
    if (!Number.isFinite(previous.count) || !Number.isFinite(stage.count)) return [];
    const lost = previous.count - stage.count;
    return lost > 0 ? [{
      fromStage: previous.key,
      toStage: stage.key,
      fromLabel: previous.label,
      toLabel: stage.label,
      denominator: previous.count,
      numerator: stage.count,
      lost,
    }] : [];
  });
  return candidates.sort((a, b) => b.lost - a.lost)[0] ?? null;
}
```

Keep the stable stage order as the tie-breaker by relying on stable sort or by retaining the first candidate when losses are equal.

- [ ] **Step 5: Update the read composer**

Accept `ComparableWeekResult`, return `null` unless it is `ready`, and derive:

```ts
function formatDateKey(day: string): { month: string; day: number } {
  const date = new Date(`${day}T00:00:00Z`);
  return {
    month: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    day: date.getUTCDate(),
  };
}

function formatWindow(window: ComparableWeek): string {
  const from = formatDateKey(window.from);
  const to = formatDateKey(window.to);
  return from.month === to.month
    ? `${from.month} ${from.day}–${to.day}`
    : `${from.month} ${from.day}–${to.month} ${to.day}`;
}

const headlineWindow = `${formatWindow(current)} against ${formatWindow(prior)}`;
const loss = funnel ? largestMeasuredFunnelLoss(funnel) : null;
```

Use the already-calculated `changePct`; when it is `null`, state only the current settled-week count without implying a baseline percentage. Qualification must say `14 settled calendar days`. Keep follower and funnel clauses separate and retain the funnel’s actual window.

- [ ] **Step 6: Run composer and follower-flow tests together**

```bash
npm --prefix web test -- src/lib/followerFlow.test.ts src/lib/todaysRead.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit dynamic interpretation**

```bash
git add web/src/lib/todaysRead.ts web/src/lib/todaysRead.test.ts
git commit -m "fix: derive home interpretation from measured losses"
```

---

### Task 3: Extract an explicit Home evidence-state model

**Files:**

- Create: `web/src/lib/homeAttention.ts`
- Create: `web/src/lib/homeAttention.test.ts`
- Modify: `web/src/pages/Home.tsx:21-82`

**Interfaces:**

- Consumes: `Stats`, `GuideFollowResult`, and `largestMeasuredFunnelLoss`.
- Produces: `AttentionItem`, `SourceState<T>`, `HomeAttentionState`, `deriveAttentionItems`, and `deriveHomeAttentionState`.
- Consumed by: Task 4’s Home component.

- [ ] **Step 1: Write source-state cross-product tests**

```ts
it("is checking while any required source is loading and none failed", () => {
  expect(deriveHomeAttentionState({
    flow: loading(),
    stats: success(clearStats()),
    funnel: success(clearFunnel()),
  })).toEqual({ status: "checking" });
});

it("is incomplete when one source fails and keeps verified attention", () => {
  expect(deriveHomeAttentionState({
    flow: success(flowResponse()),
    stats: success(statsWithFailedGates(3)),
    funnel: failed(),
  })).toMatchObject({
    status: "incomplete",
    failedSources: ["funnel"],
    items: [{ kind: "failed_gates" }],
  });
});

it("is ready_clear only after all three sources succeed with no items", () => {
  expect(deriveHomeAttentionState({
    flow: success(flowResponse()),
    stats: success(clearStats()),
    funnel: success(clearFunnel()),
  })).toEqual({ status: "ready_clear", items: [] });
});
```

Also cover `ready_with_attention`, multiple failed sources in stable
`["flow", "stats", "funnel"]` order, and a failed source winning over a still-loading source.

- [ ] **Step 2: Run the new test and verify it fails**

```bash
npm --prefix web test -- src/lib/homeAttention.test.ts
```

Expected: module not found.

- [ ] **Step 3: Move attention derivation into the pure module**

Define:

```ts
export type HomeSource = "flow" | "stats" | "funnel";
export type SourceState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; data: T };

export type HomeAttentionState =
  | { status: "checking" }
  | { status: "ready_with_attention"; items: AttentionItem[] }
  | { status: "ready_clear"; items: [] }
  | { status: "incomplete"; failedSources: HomeSource[]; items: AttentionItem[] };
```

Move the existing gate/retry attention rules without changing their thresholds.
Replace use of `funnel.headline` with `largestMeasuredFunnelLoss`. When funnel data
is unavailable, do not synthesize a funnel item.

Implement source precedence:

1. Any error → `incomplete`, preserving items derivable from successful sources.
2. Otherwise any loading → `checking`.
3. All success and items present → `ready_with_attention`.
4. All success and no items → `ready_clear`.

- [ ] **Step 4: Remove the private `deriveAttention` implementation from Home**

Import the pure helper and adapt query objects with a local function:

```ts
function queryState<T>(query: { isError: boolean; isPending: boolean; data?: T }): SourceState<T> {
  if (query.isError) return { status: "error" };
  if (query.isPending || query.data === undefined) return { status: "loading" };
  return { status: "success", data: query.data };
}
```

- [ ] **Step 5: Run the state tests and TypeScript build**

```bash
npm --prefix web test -- src/lib/homeAttention.test.ts src/lib/todaysRead.test.ts
npm --prefix web run build
```

Expected: PASS.

- [ ] **Step 6: Commit the state model**

```bash
git add web/src/lib/homeAttention.ts web/src/lib/homeAttention.test.ts web/src/pages/Home.tsx
git commit -m "refactor: model home evidence readiness explicitly"
```

---

### Task 4: Render checking, incomplete, attention, and all-clear states honestly

**Files:**

- Create: `web/src/pages/Home.test.tsx`
- Modify: `web/src/pages/Home.tsx`
- Modify: `PRODUCT.md`

**Interfaces:**

- Consumes: Tasks 1–3 contracts.
- Produces: the user-visible Home behavior and regression coverage.

- [ ] **Step 1: Create a controlled Home test harness**

Mock heavy chart/detail components but keep `Home`, React Query, and `api` real at
the query boundary. Use a `QueryClient` with `retry: false`, `MemoryRouter`, and
path-keyed deferred promises:

```ts
const responses = new Map<string, Promise<unknown>>();
vi.mock("@/lib/api", () => ({
  api: <T,>(path: string) => responses.get(path) as Promise<T>,
}));
```

Stub `FollowerFlowPanel`, `FollowerKpiRow`, and attribution-only components to
small labelled elements so failures identify Home copy rather than SVG details.

- [ ] **Step 2: Write failing component regressions**

Cover:

```ts
it("never renders reassurance while required requests are pending", () => {
  renderHomeWithPendingRequests();
  expect(screen.getByText(/Checking what needs attention/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Nothing is failing/)).not.toBeInTheDocument();
});

it("shows incomplete when stats fail even if the follower read succeeds", async () => {
  renderHome({ flow: settledFlow(), stats: reject(), funnel: clearFunnel() });
  expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
  expect(screen.queryByText(/automation is running without you/i)).not.toBeInTheDocument();
});

it("shows all clear only after every required source succeeds", async () => {
  renderHome({ flow: settledFlow(), stats: clearStats(), funnel: clearFunnel() });
  expect(await screen.findByText(/Nothing is waiting on you today/)).toBeInTheDocument();
});
```

Add a partial-failure test proving a verified failed-gate item stays visible
when the funnel request fails, and a test proving the follower clause remains
when only attribution detail fails because attribution is not an all-clear source.

- [ ] **Step 3: Run the component test and verify current false reassurance fails it**

```bash
npm --prefix web test -- src/pages/Home.test.tsx
```

Expected: pending/error states currently render “Nothing…” copy.

- [ ] **Step 4: Render copy from `HomeAttentionState`**

Use one exhaustive switch for header and attention-section copy. Required text:

| State | Header | Best next move |
| --- | --- | --- |
| `checking` | `Checking what needs attention…` | `Waiting for the required evidence.` |
| `ready_with_attention` | count of verified decisions | first verified item |
| `ready_clear` | `Nothing is waiting on you today.` | `Nothing is failing and nothing is queued.` |
| `incomplete` | `The check is incomplete.` | verified item if present, otherwise `Some evidence could not be checked.` |

In `incomplete`, list failed source names in the evidence area and provide source-specific retry buttons. Do not route a funnel retry through `flowQ.refetch()`.

For an insufficient comparison, map each reason to factual copy such as
`Waiting for seven settled daily measurements` or
`A catch-up span prevents a week-to-week comparison`; never say the account is
empty.

- [ ] **Step 5: Update the product record**

In `PRODUCT.md` under “The console interprets,” add the complete-window rule and
the four Home readiness states. State that all-clear requires successful
follower-flow, stats, and funnel evidence.

- [ ] **Step 6: Run focused and full frontend verification**

```bash
npm --prefix web test -- src/lib/followerFlow.test.ts src/lib/todaysRead.test.ts src/lib/homeAttention.test.ts src/pages/Home.test.tsx
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the Home rendering slice**

```bash
git add web/src/pages/Home.tsx web/src/pages/Home.test.tsx PRODUCT.md
git commit -m "fix: distinguish home all-clear from unknown evidence"
```

---

## Plan Verification

- [ ] Every interpretive comparison test uses explicit Pacific date keys.
- [ ] Search confirms Home no longer imports `summarizeUsWeekOverWeek`.
- [ ] Search confirms “largest measured loss” is emitted only from `largestMeasuredFunnelLoss`.
- [ ] No loading/error branch contains `Nothing is`, `nothing is`, or `all clear`.
- [ ] The full frontend suite, lint, and build pass.
- [ ] `git diff --check` is clean after every task.
