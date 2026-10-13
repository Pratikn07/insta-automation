# Guide Journey Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Funnels page's six per-card stages with a per-person trunk (asked → got the card → said yes) that forks at the follow check into "already following" and "not following yet" lanes, with two headlines and a bucket breakdown under each leak; Home reads the same endpoint.

**Architecture:** One read-only SQL statement returns one row per person, built on the card-level V1+V2 signals in `JOURNEY_SIGNALS`. A pure summarizer turns rows into `GuideJourneyResult`. The same SQL, filtered, serves the two "see who" lists. The funnel registers as `guide-journey`, so the existing `/api/funnels/:key` and `/:key/drop-off/:bucket` routes serve it. The page and Home switch to it; `guide-follow` is untouched for the CLI.

**Tech Stack:** TypeScript ESM, Postgres via Prisma `$queryRawUnsafe`, Express, React + TanStack Query, Vitest (+ jsdom, Testing Library).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-13-guide-journey-funnel-design.md`.
- Count people, not cards. Every split adds up exactly: never said yes = got the card − said yes; stuck = shown the wall − followed; the two lanes partition said yes.
- Leak buckets, first match wins. Never said yes: `still_has_time`, `wrote_not_yes`, `opened_ignored`, `no_sign_opened`, `cannot_tell`. Stuck at the wall: `still_has_time`, `said_followed`, `never_came_back`.
- Every rate is a `GuardedRate` with `GUIDE_FOLLOW_MIN_SAMPLE` (5).
- Read-only SQL. Parameters `$1` from, `$2` to, `$3` lookback (`EVENT_LOOKBACK_MARGIN`); the leak list adds `$4` leak, `$5` limit.
- Home's tile keeps label "Reply rate" and copy "answered the unlock DM".
- Backend tests: `npx vitest run <file>`. DB contract tests need the contract-DB env (memory `contract-db-recipe`). Web tests: run from `web/`.

---

### Task 1: Pure summarizer and types

**Files:**
- Create: `src/services/funnels/guideJourneyFunnel.ts`
- Test: `src/services/funnels/guideJourneyFunnel.test.ts`

**Interfaces:**
- Produces: `guideJourneyDef: FunnelDef`, `GuideJourneyRow`, `GuideJourneyResult`, `QuietBucket`, `WallBucket`, `QUIET_BUCKETS`, `WALL_BUCKETS`, `GUIDE_JOURNEY_LEAKS`, `GuideJourneyLeak`, `summarizeGuideJourney(rows, window, minSample?)`.

- [ ] **Step 1: Failing tests** — `guideJourneyFunnel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeGuideJourney, type GuideJourneyRow } from "./guideJourneyFunnel.js";

const WINDOW = { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" };
let n = 0;
function person(over: Partial<GuideJourneyRow> = {}): GuideJourneyRow {
  n += 1;
  return {
    igUserId: `ig-${n}`, username: null, lastKeyword: null, cards: 1,
    lastAskedAt: new Date("2026-10-01T00:00:00.000Z"),
    reached: true, saidYes: false, hitWall: false, followed: false, gotGuide: false,
    d21Read: false, d21Following: false, d21Due: false,
    quietBucket: null, wallBucket: null,
    ...over,
  };
}
const many = (count: number, over: Partial<GuideJourneyRow>) => Array.from({ length: count }, () => person(over));

describe("summarizeGuideJourney", () => {
  const rows = [
    ...many(4, { quietBucket: "cannot_tell" }),
    ...many(2, { quietBucket: "still_has_time" }),
    ...many(6, { saidYes: true, gotGuide: true }),                       // already following
    ...many(5, { saidYes: true, hitWall: true, followed: true, gotGuide: true, d21Read: true, d21Following: true, d21Due: true }),
    ...many(1, { saidYes: true, hitWall: true, followed: true, gotGuide: true, d21Due: true }),
    ...many(3, { saidYes: true, hitWall: true, wallBucket: "never_came_back" }),
    ...many(1, { saidYes: true, hitWall: true, wallBucket: "said_followed" }),
    person({ reached: false }),
  ];
  const s = summarizeGuideJourney(rows, WINDOW);

  it("counts the trunk per person and keeps the reply rate Home reads", () => {
    expect(s.cohortSize).toBe(23);
    expect(s.stages.map((x) => [x.key, x.count])).toEqual([["asked", 23], ["reached", 22], ["saidYes", 16]]);
    expect(s.headline.label).toBe("Reply rate");
    expect(s.headline.rate).toMatchObject({ numerator: 16, denominator: 22 });
  });

  it("splits everyone who said yes into exactly one lane", () => {
    expect(s.lanes.alreadyFollowing.people + s.lanes.notFollowing.people).toBe(16);
    expect(s.lanes.alreadyFollowing).toMatchObject({ people: 6, gotGuide: { numerator: 6, denominator: 6 } });
    expect(s.lanes.notFollowing.people).toBe(10);
  });

  it("leads with new followers out of those not following, and guides out of everyone who asked", () => {
    expect(s.newFollowers).toMatchObject({ numerator: 6, denominator: 10, pct: 60 });
    expect(s.gotGuide).toMatchObject({ numerator: 12, denominator: 23 });
  });

  it("makes each leak add up to the gap it explains", () => {
    expect(s.leaks.neverSaidYes.total).toBe(22 - 16);
    expect(s.leaks.neverSaidYes.buckets).toEqual({
      still_has_time: 2, wrote_not_yes: 0, opened_ignored: 0, no_sign_opened: 0, cannot_tell: 4,
    });
    expect(s.leaks.stuckAtWall.total).toBe(10 - 6);
    expect(s.leaks.stuckAtWall.buckets).toEqual({ still_has_time: 0, said_followed: 1, never_came_back: 3 });
  });

  it("reports retention over new followers who were read, never over everyone", () => {
    expect(s.retention.due).toBe(6);
    expect(s.retention.rate).toMatchObject({ numerator: 5, denominator: 5, pct: 100 });
  });

  it("suppresses a rate below the minimum sample", () => {
    const thin = summarizeGuideJourney(many(3, { saidYes: true, hitWall: true, followed: true }), WINDOW);
    expect(thin.newFollowers).toMatchObject({ numerator: 3, denominator: 3, pct: null, belowMinSample: true });
  });
});
```

- [ ] **Step 2:** `npx vitest run src/services/funnels/guideJourneyFunnel.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `guideJourneyFunnel.ts` (summarizer part; Task 2 appends the SQL):

```ts
// The guide journey, counted per person: one trunk (asked -> got the card -> said yes) that
// forks at the follow check into "already following" and "not following yet".
//
// WHY THIS REPLACED THE SIX-STAGE VIEW. Counted per card, someone who comments on seven
// reels counted seven times, and their six untapped cards read as losses. Drawn as one
// list, "following (first reading)" was mostly people who followed before they asked, and
// the 21-day bar read "2%" against everyone when 67 of 69 converts were still following.
// The output the page exists for, new followers, was a sentence under another stage.
// See docs/superpowers/specs/2026-10-13-guide-journey-funnel-design.md.

import {
  type FunnelDef,
  type FunnelHeadline,
  type FunnelStageCount,
  type GuardedRate,
  guardedRate,
  toStageCounts,
} from "./types.js";
import { GUIDE_FOLLOW_MIN_SAMPLE } from "./guideFollowFunnel.js";

export const QUIET_BUCKETS = [
  "still_has_time",
  "wrote_not_yes",
  "opened_ignored",
  "no_sign_opened",
  "cannot_tell",
] as const;
export type QuietBucket = (typeof QUIET_BUCKETS)[number];

export const WALL_BUCKETS = ["still_has_time", "said_followed", "never_came_back"] as const;
export type WallBucket = (typeof WALL_BUCKETS)[number];

export const GUIDE_JOURNEY_LEAKS = ["never-said-yes", "stuck-at-wall"] as const;
export type GuideJourneyLeak = (typeof GUIDE_JOURNEY_LEAKS)[number];

export const guideJourneyDef: FunnelDef = {
  key: "guide-journey",
  name: "Guide journey",
  question:
    "Of the people who ask for a guide, how many get it, and how many new followers does it bring in?",
  headline: {
    fromStage: "reached",
    toStage: "saidYes",
    label: "Reply rate",
    rationale:
      "More people stop at the unlock card than anywhere else in the journey. Everyone who answers it reaches the follow check.",
  },
  minSample: GUIDE_FOLLOW_MIN_SAMPLE,
  stages: [
    {
      key: "asked",
      label: "Asked for a guide",
      definition:
        "Commented or DM'd a guide keyword in the window. Each person counted once, however many reels they commented on.",
    },
    {
      key: "reached",
      label: "Got the card",
      definition:
        "Instagram accepted at least one unlock card (or the old text gate). Asking by DM is its own request, so DM askers count here too.",
    },
    {
      key: "saidYes",
      label: "Said yes",
      definition:
        "Tapped 'Yes, send it', typed a yes or DONE, or asked by DM. Everyone past this point reaches the follow check.",
    },
  ],
};

/** One row per person. Shape returned by GUIDE_JOURNEY_SQL. */
export interface GuideJourneyRow {
  igUserId: string;
  username: string | null;
  lastKeyword: string | null;
  cards: number;
  lastAskedAt: Date;
  reached: boolean;
  saidYes: boolean;
  /** Not following at a follow check on any card: the growth lane. */
  hitWall: boolean;
  /** Hit the wall and got a guide delivered after their first wall. */
  followed: boolean;
  gotGuide: boolean;
  d21Read: boolean;
  d21Following: boolean;
  /** A new follower rechecked and completed at least FOLLOW_THROUGH_MIN_DAYS ago. */
  d21Due: boolean;
  quietBucket: QuietBucket | null;
  wallBucket: WallBucket | null;
}

export interface GuideJourneyResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  /** People who asked. */
  cohortSize: number;
  /** The trunk only. Home's "largest loss" walks these, so it lands on said yes. */
  stages: FunnelStageCount[];
  headline: FunnelHeadline & { rate: GuardedRate };
  newFollowers: GuardedRate;
  gotGuide: GuardedRate;
  lanes: {
    alreadyFollowing: { people: number; gotGuide: GuardedRate };
    notFollowing: { people: number };
  };
  leaks: {
    neverSaidYes: { total: number; buckets: Record<QuietBucket, number> };
    stuckAtWall: { total: number; buckets: Record<WallBucket, number> };
  };
  /** Still following at 21 days, over new followers who were read. */
  retention: { due: number; rate: GuardedRate };
}

function bucketCounts<B extends string>(
  names: readonly B[],
  values: readonly (B | null)[],
): Record<B, number> {
  const counts = Object.fromEntries(names.map((name) => [name, 0])) as Record<B, number>;
  for (const value of values) if (value !== null) counts[value] += 1;
  return counts;
}

/** Pure: no database, no clock. */
export function summarizeGuideJourney(
  rows: GuideJourneyRow[],
  window: { from: string; to: string },
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): GuideJourneyResult {
  const count = (predicate: (row: GuideJourneyRow) => boolean) => rows.filter(predicate).length;
  const rate = (numerator: number, denominator: number) =>
    guardedRate(numerator, denominator, minSample);

  const asked = rows.length;
  const reached = count((r) => r.reached);
  const saidYes = count((r) => r.saidYes);
  const notFollowing = count((r) => r.hitWall);
  const alreadyFollowing = rows.filter((r) => r.saidYes && !r.hitWall);
  const followed = count((r) => r.followed);
  const quiet = rows.map((r) => r.quietBucket);
  const wall = rows.map((r) => r.wallBucket);

  return {
    key: guideJourneyDef.key,
    name: guideJourneyDef.name,
    question: guideJourneyDef.question,
    window,
    cohortSize: asked,
    stages: toStageCounts(guideJourneyDef.stages, { asked, reached, saidYes }),
    headline: { ...guideJourneyDef.headline, rate: rate(saidYes, reached) },
    newFollowers: rate(followed, notFollowing),
    gotGuide: rate(count((r) => r.gotGuide), asked),
    lanes: {
      alreadyFollowing: {
        people: alreadyFollowing.length,
        gotGuide: rate(alreadyFollowing.filter((r) => r.gotGuide).length, alreadyFollowing.length),
      },
      notFollowing: { people: notFollowing },
    },
    leaks: {
      neverSaidYes: {
        total: quiet.filter((b) => b !== null).length,
        buckets: bucketCounts(QUIET_BUCKETS, quiet),
      },
      stuckAtWall: {
        total: wall.filter((b) => b !== null).length,
        buckets: bucketCounts(WALL_BUCKETS, wall),
      },
    },
    retention: {
      due: count((r) => r.d21Due),
      rate: rate(count((r) => r.followed && r.d21Following), count((r) => r.followed && r.d21Read)),
    },
  };
}
```

- [ ] **Step 4:** run the test file → PASS.
- [ ] **Step 5:** commit `feat: summarize the guide journey per person`.

### Task 2: Per-person SQL, runners, contract test

**Files:**
- Modify: `src/services/funnels/guideFollowFunnel.ts` (`ACCESS_JOURNEY_CTE` gains `opened_at`, `first_wall_at`, `window_end`, `wall_window_end`, `rechecked_at_wall`; existing selects ignore them)
- Modify: `src/services/funnels/guideJourneyFunnel.ts` (append `GUIDE_JOURNEY_SQL`, `GUIDE_JOURNEY_LEAK_SQL`, `GuideJourneyLeakRow`, `GuideJourneyLeakList`)
- Modify: `src/services/funnels/runFunnel.ts` (`fetchGuideJourneyRows`, `runGuideJourneyFunnel`, `runGuideJourneyLeak`)
- Test: `src/services/funnels/guideJourneyFunnelContract.test.ts`

**Interfaces:**
- Consumes: `JOURNEY_SIGNALS`, `EVENT_LOOKBACK_MARGIN` (guideFollowFunnel.ts), `FOLLOW_THROUGH_MIN_DAYS`, Task 1 types.
- Produces: `runGuideJourneyFunnel(db, window?, minSample?) => Promise<GuideJourneyResult>`, `runGuideJourneyLeak(db, leak, window?, limit?) => Promise<GuideJourneyLeakList>`, `fetchGuideJourneyRows(db, window)`.

- [ ] **Step 1: Failing contract test** seeding, under one keyword, people with `igUserId` `ig-<suffix>-<name>`:
  `multi` (3 comment cards: one tapped + delivered, two untapped), `wallThenFollow` (card 1 wall token at T-2d never delivered; card 2 tapped + delivered at T-1d), `dmOnly` (`source: "dm"` attempt delivered), `fresh` (untapped, window open), `wrote` (untapped, window closed, inbound DM after the card), `opened` (untapped, window closed, outbound keyword_automation card with `seenAt`), `unread` (untapped, window closed, card logged, no `seenAt`), `silent` (untapped, window closed, nothing logged), `saidFollowed` (wall, `followResponseCount: 1`, window closed), `gaveUp` (wall, `followCheckCount: 1`, window closed). Assert per person from `fetchGuideJourneyRows`: `multi` → `cards: 3, saidYes, !hitWall, quietBucket: null`; `wallThenFollow` → `hitWall, followed, wallBucket: null`; `dmOnly` → `reached, saidYes`; buckets `still_has_time`, `wrote_not_yes`, `opened_ignored`, `no_sign_opened`, `cannot_tell`, `said_followed`, `never_came_back` on the respective people; and `runGuideJourneyLeak(db, "stuck-at-wall", window, 500)` returns `saidFollowed` and `gaveUp` but not `wallThenFollow`.

- [ ] **Step 2:** run with the contract-DB env → FAIL (no SQL yet).

- [ ] **Step 3: Implement.** `ACCESS_JOURNEY_CTE` select list becomes:

```sql
    a.conversation_id,
    COALESCE(bool_or(a.follow_check_count > 0
      OR (t.action = 'request_guide' AND t.status = 'consumed')), false) AS replied,
    (COUNT(DISTINCT t.id) FILTER (WHERE t.action = 'check_follow'))::int AS follow_asks,
    MIN(a.created_at) AS opened_at,
    MIN(t.created_at) FILTER (WHERE t.action = 'check_follow') AS first_wall_at,
    MAX(a.messaging_window_expires_at) AS window_end,
    MAX(a.messaging_window_expires_at) FILTER (WHERE t.action = 'check_follow') AS wall_window_end,
    COALESCE(bool_or(a.follow_response_count > 0 OR a.follow_check_count >= 2)
      FILTER (WHERE t.action = 'check_follow'), false) AS rechecked_at_wall
```

`GUIDE_JOURNEY_SQL` (in guideJourneyFunnel.ts):

```ts
export const GUIDE_JOURNEY_SQL = `
WITH cohort AS (
  SELECT (e.payload->>'conversationId')::uuid AS conversation_id,
         MIN(e.created_at) AS entered_at,
         COALESCE(MIN(e.payload->>'source'), 'comment') AS entry_path
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
),
ev AS (
  SELECT (payload->>'conversationId')::uuid AS conversation_id, kind, payload, created_at
  FROM event_log
  WHERE kind IN ('dm_sent', 'follow_required', 'done_received', 'sequence_completed')
    AND created_at >= $1::timestamptz - $3::interval
    AND payload->>'conversationId' IS NOT NULL
),
${JOURNEY_SIGNALS.ctes},
card AS (
  SELECT
    co.conversation_id, co.entered_at, co.entry_path, c.ig_user_id, c.keyword_id,
    ${JOURNEY_SIGNALS.gateSent} AS card_sent,
    ${JOURNEY_SIGNALS.answered} AS answered,
    ${JOURNEY_SIGNALS.followAsks} AS follow_asks,
    ${JOURNEY_SIGNALS.delivered} AS delivered,
    LEAST(MIN(ev.created_at) FILTER (WHERE ev.kind = 'follow_required'), MIN(aj.first_wall_at))
                                                   AS first_wall_at,
    MAX(ev.created_at) FILTER (WHERE ev.kind = 'sequence_completed') AS last_delivered_at,
    MAX(aj.window_end)                             AS window_end,
    MAX(aj.wall_window_end)                        AS wall_window_end,
    (COALESCE(bool_or(aj.rechecked_at_wall), false)
      OR (COUNT(*) FILTER (WHERE ev.kind = 'follow_required')) >= 2) AS said_followed,
    MIN(aj.opened_at)                              AS opened_at,
    c.follow_through_is_follower                   AS d21,
    COALESCE(c.follow_rechecked_at IS NOT NULL
      AND c.completed_at <= now() - interval '${FOLLOW_THROUGH_MIN_DAYS} days', false) AS d21_eligible
  FROM cohort co
  JOIN conversations c ON c.id = co.conversation_id
  LEFT JOIN ev ON ev.conversation_id = co.conversation_id
  ${JOURNEY_SIGNALS.join}
  GROUP BY co.conversation_id, co.entered_at, co.entry_path, c.ig_user_id, c.keyword_id,
           c.follow_through_is_follower, c.follow_rechecked_at, c.completed_at
),
person AS (
  SELECT
    ig_user_id,
    COUNT(*)::int AS cards,
    MAX(entered_at) AS last_asked_at,
    (array_agg(keyword_id ORDER BY entered_at DESC))[1] AS last_keyword_id,
    bool_or(card_sent OR entry_path = 'dm' OR answered OR follow_asks > 0) AS reached,
    bool_or(answered OR follow_asks > 0 OR entry_path = 'dm') AS said_yes,
    bool_or(follow_asks > 0) AS hit_wall,
    MIN(first_wall_at) AS first_wall_at,
    bool_or(delivered) AS got_guide,
    MAX(last_delivered_at) AS last_delivered_at,
    COALESCE(bool_or(window_end > now()), false) AS window_open,
    COALESCE(bool_or(wall_window_end > now()), false) AS wall_window_open,
    bool_or(said_followed) AS said_followed,
    MIN(opened_at) AS first_card_at,
    bool_or(d21 IS NOT NULL) AS d21_read,
    bool_or(d21 IS TRUE) AS d21_following,
    bool_or(d21_eligible) AS d21_eligible
  FROM card
  GROUP BY ig_user_id
),
quiet AS (
  -- Read and reply evidence, only for people who got a card and never said yes. Cards were
  -- saved to DM history from 2026-10-05; before that, and on the V1 path, nothing is known.
  SELECT p.ig_user_id,
    EXISTS (SELECT 1 FROM dm_thread th JOIN dm_message m ON m.thread_id = th.id
            WHERE th.ig_user_id = p.ig_user_id AND m.direction = 'inbound'
              AND m.created_at > (p.first_card_at AT TIME ZONE 'UTC')) AS wrote,
    EXISTS (SELECT 1 FROM dm_thread th JOIN dm_message m ON m.thread_id = th.id
            WHERE th.ig_user_id = p.ig_user_id AND m.direction = 'outbound'
              AND m.source = 'keyword_automation' AND m.seen_at IS NOT NULL
              AND m.created_at >= (p.first_card_at AT TIME ZONE 'UTC') - interval '2 minutes')
      OR EXISTS (SELECT 1 FROM dm_recovery_reminder r JOIN card k ON k.conversation_id = r.conversation_id
                 WHERE k.ig_user_id = p.ig_user_id AND r.seen_at IS NOT NULL) AS seen,
    EXISTS (SELECT 1 FROM dm_thread th JOIN dm_message m ON m.thread_id = th.id
            WHERE th.ig_user_id = p.ig_user_id AND m.direction = 'outbound'
              AND m.source = 'keyword_automation'
              AND m.created_at >= (p.first_card_at AT TIME ZONE 'UTC') - interval '2 minutes')
      OR EXISTS (SELECT 1 FROM dm_recovery_reminder r JOIN card k ON k.conversation_id = r.conversation_id
                 WHERE k.ig_user_id = p.ig_user_id) AS tracked
  FROM person p
  WHERE p.reached AND NOT p.said_yes AND NOT p.window_open
)
SELECT
  p.ig_user_id                                  AS "igUserId",
  u.username                                    AS "username",
  k.keyword                                     AS "lastKeyword",
  p.cards                                       AS "cards",
  p.last_asked_at                               AS "lastAskedAt",
  p.reached                                     AS "reached",
  p.said_yes                                    AS "saidYes",
  p.hit_wall                                    AS "hitWall",
  COALESCE(p.hit_wall AND p.last_delivered_at > p.first_wall_at, false) AS "followed",
  p.got_guide                                   AS "gotGuide",
  p.d21_read                                    AS "d21Read",
  p.d21_following                               AS "d21Following",
  COALESCE(p.hit_wall AND p.last_delivered_at > p.first_wall_at AND p.d21_eligible, false) AS "d21Due",
  CASE
    WHEN NOT p.reached OR p.said_yes THEN NULL
    WHEN p.window_open THEN 'still_has_time'
    WHEN q.wrote THEN 'wrote_not_yes'
    WHEN q.seen THEN 'opened_ignored'
    WHEN q.tracked THEN 'no_sign_opened'
    ELSE 'cannot_tell'
  END                                           AS "quietBucket",
  CASE
    WHEN NOT p.hit_wall OR COALESCE(p.last_delivered_at > p.first_wall_at, false) THEN NULL
    WHEN p.wall_window_open THEN 'still_has_time'
    WHEN p.said_followed THEN 'said_followed'
    ELSE 'never_came_back'
  END                                           AS "wallBucket"
FROM person p
LEFT JOIN quiet q    ON q.ig_user_id = p.ig_user_id
LEFT JOIN ig_users u ON u.id = p.ig_user_id
LEFT JOIN keywords k ON k.id = p.last_keyword_id
`.trim();

export interface GuideJourneyLeakRow {
  igUserId: string;
  username: string | null;
  lastKeyword: string | null;
  cards: number;
  lastAskedAt: Date;
  bucket: QuietBucket | WallBucket;
}
export interface GuideJourneyLeakList {
  leak: GuideJourneyLeak;
  rows: GuideJourneyLeakRow[];
}

/** $4 = leak, $5 = limit. Newest first: the freshest are the actionable ones. */
export const GUIDE_JOURNEY_LEAK_SQL = `
SELECT "igUserId", "username", "lastKeyword", "cards", "lastAskedAt",
  CASE WHEN $4::text = 'never-said-yes' THEN "quietBucket" ELSE "wallBucket" END AS "bucket"
FROM (${GUIDE_JOURNEY_SQL}) person
WHERE CASE WHEN $4::text = 'never-said-yes' THEN "quietBucket" IS NOT NULL
           ELSE "wallBucket" IS NOT NULL END
ORDER BY "lastAskedAt" DESC
LIMIT $5
`.trim();
```

Runners (runFunnel.ts):

```ts
export async function fetchGuideJourneyRows(db: FunnelDb, window: FunnelWindow): Promise<GuideJourneyRow[]> {
  return db.$queryRawUnsafe<GuideJourneyRow[]>(
    GUIDE_JOURNEY_SQL, window.from.toISOString(), window.to.toISOString(), EVENT_LOOKBACK_MARGIN,
  );
}

export async function runGuideJourneyFunnel(
  db: FunnelDb, window: FunnelWindow = defaultWindow(), minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): Promise<GuideJourneyResult> {
  const rows = await fetchGuideJourneyRows(db, window);
  return summarizeGuideJourney(rows, { from: window.from.toISOString(), to: window.to.toISOString() }, minSample);
}

export async function runGuideJourneyLeak(
  db: FunnelDb, leak: GuideJourneyLeak, window: FunnelWindow = defaultWindow(),
  limit: number = DROP_OFF_DEFAULT_LIMIT,
): Promise<GuideJourneyLeakList> {
  const capped = Math.min(Math.max(limit, 1), DROP_OFF_MAX_LIMIT);
  const rows = await db.$queryRawUnsafe<GuideJourneyLeakRow[]>(
    GUIDE_JOURNEY_LEAK_SQL, window.from.toISOString(), window.to.toISOString(),
    EVENT_LOOKBACK_MARGIN, leak, capped,
  );
  return { leak, rows };
}
```

- [ ] **Step 4:** contract test PASS; existing `guideFollowFunnelContract` and funnel unit tests still PASS.
- [ ] **Step 5:** commit `feat: count the guide journey per person in one query`.

### Task 3: Register the funnel and serve it

**Files:** Modify `src/services/funnels/registry.ts`, `src/api/funnels.routes.ts`; Test `src/api/funnels.routes.test.ts`.

**Interfaces:** Consumes Task 2 runners. Produces `GET /api/funnels/guide-journey` and `GET /api/funnels/guide-journey/drop-off/{never-said-yes|stuck-at-wall}`; exports `journeyCache`, `journeyLeakCache`.

- [ ] **Step 1: Failing route tests** (add caches to `beforeEach` invalidation):

```ts
describe("GET /api/funnels/guide-journey", () => {
  it("returns the per-person trunk Home reads", async () => {
    const res = await request(makeApp()).get("/api/funnels/guide-journey");
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s: { key: string }) => s.key)).toEqual(["asked", "reached", "saidYes"]);
    expect(res.body.headline.label).toBe("Reply rate");
    expect(res.body.lanes.notFollowing.people).toBe(0);
  });

  it("serves a leak list and refuses an unknown leak", async () => {
    const ok = await request(makeApp()).get("/api/funnels/guide-journey/drop-off/stuck-at-wall");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ leak: "stuck-at-wall", rows: [] });
    const bad = await request(makeApp()).get("/api/funnels/guide-journey/drop-off/no-reply");
    expect(bad.status).toBe(404);
    expect(bad.body.available).toEqual(["never-said-yes", "stuck-at-wall"]);
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3:** register `[guideJourneyDef.key]: guideJourneyDef` in `FUNNELS`; in `/:key` add, before the guide-follow fallthrough:

```ts
  if (def.key === guideJourneyDef.key) {
    res.json(
      await journeyCache.get(funnelCacheKey(def.key, parsed.data, def.minSample), () =>
        runGuideJourneyFunnel(prisma, window, def.minSample),
      ),
    );
    return;
  }
```

and in `/:key/drop-off/:bucket`, after the unknown-funnel check:

```ts
  if (def.key === guideJourneyDef.key) {
    const leak = req.params.bucket as GuideJourneyLeak;
    if (!(GUIDE_JOURNEY_LEAKS as readonly string[]).includes(leak)) {
      res.status(404).json({ error: "unknown_bucket", available: GUIDE_JOURNEY_LEAKS });
      return;
    }
    const parsedLeak = dropOffQuery.safeParse(req.query);
    if (!parsedLeak.success) {
      res.status(400).json({ error: "bad_window", detail: "from/to must be YYYY-MM-DD, limit a number" });
      return;
    }
    const leakWindow = resolveWindow(parsedLeak.data);
    if (isWindowError(leakWindow)) {
      res.status(400).json(leakWindow);
      return;
    }
    const leakLimit = parsedLeak.data.limit ?? DROP_OFF_DEFAULT_LIMIT;
    res.json(
      await journeyLeakCache.get(
        `${funnelCacheKey(def.key, parsedLeak.data, def.minSample)}|${leak}|${leakLimit}`,
        () => runGuideJourneyLeak(prisma, leak, leakWindow, leakLimit),
      ),
    );
    return;
  }
```

- [ ] **Step 4:** route tests PASS. **Step 5:** commit `feat: serve the guide journey funnel and its leak lists`.

### Task 4: Trunk-and-fork page

**Files:** Modify `web/src/lib/types.ts`, `web/src/pages/Funnels.tsx`, `web/src/pages/Funnels.test.tsx`; Create `web/src/components/funnels/JourneyFunnel.tsx`, `web/src/components/funnels/JourneyLeakTable.tsx`.

**Interfaces:** Consumes the Task 3 endpoints. Produces web types `GuideJourneyResult`, `GuideJourneyLeakList`, `GuideJourneyLeakRow`, `QuietBucket`, `WallBucket`, `FunnelReport = Pick<GuideFollowResult, "window" | "stages" | "headline">`.

- [ ] **Step 1: Failing page tests.** Replace the `FUNNEL` fixture with a `JOURNEY` fixture (numbers from the spec), route `/funnels/guide-journey` and its two lists in `respond()`, and assert: both headline numbers (`1,140` new followers, `3,292` got their guide), the trunk labels, both lane titles, every bucket label with its count under both leaks, the 21-day line "67 of 69 read" with "69 of the 449", and that the request path is `/funnels/guide-journey?from=2026-09-14&to=2026-10-14`. The existing cover/health/link tests keep passing against the new fixture (the "keeps the follow funnel readable" test now waits for `1,140`).
- [ ] **Step 2:** FAIL. **Step 3:** implement the components (layout per the approved mockup; bars use `--color-funnel-track` / `--color-funnel-mark`; leaks reuse `Caveat`-style left rule; "see who" toggles `JourneyLeakTable`; lanes in a two-column grid that stacks below `md`). Remove `FunnelBody`, `Kpi`, `KpiCount` and the old drop-off query from `Funnels.tsx`.
- [ ] **Step 4:** `cd web && npx vitest run src/pages/Funnels.test.tsx` PASS; `npx tsc -b --noEmit` and `npx eslint` on the changed files clean.
- [ ] **Step 5:** commit `feat: draw the guide journey as one trunk and two lanes`.

### Task 5: Home reads the journey

**Files:** Modify `web/src/pages/Home.tsx`, `web/src/pages/Home.test.tsx`, `web/src/components/home/AutomationKpiRow.tsx`, `web/src/components/home/FollowerKpiRow.tsx`, `web/src/lib/homeAttention.ts`, `web/src/lib/todaysRead.ts`.

- [ ] **Step 1:** In `Home.test.tsx` switch the stubbed path to `/funnels/guide-journey` and assert Home requests it → FAIL.
- [ ] **Step 2:** `Home.tsx` loads `apiRead<GuideJourneyResult>("/funnels/guide-journey")` with query key `["funnels", "guide-journey", "default"]`; the four consumers take `FunnelReport` instead of `GuideFollowResult`.
- [ ] **Step 3:** `cd web && npx vitest run` (whole web suite) PASS; typecheck clean.
- [ ] **Step 4:** commit `feat: Home reads the per-person reply rate`.

### Task 6: Docs and verification

- [ ] `docs/funnels.md`: a "Guide journey (`guide-journey`)" section with the stage rules, leak buckets and the per-person unit.
- [ ] API typecheck; full backend suite with the contract DB; full web suite.
- [ ] Run `GUIDE_JOURNEY_SQL` read-only on production for 2026-09-14..10-14 and check the splits add up and match the spec's orientation numbers.
- [ ] commit `docs: describe the guide journey funnel`.
