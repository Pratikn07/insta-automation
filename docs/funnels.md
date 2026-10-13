# Funnels

Where people drop off, measured over cohorts.

The first funnel is **guide → follow**. More are already latent in the schema
(historical recovery, DM recovery reminders, public recovery dispatch, AI reply
drafts, per-reel capture) and should be added as *definitions*, not as new pages.

The strict follower-gate rollout also exposes an aggregate operational lens at
`GET /api/funnels/guide-access-metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`. It uses
the same default 30-day window and 365-day maximum as the cohort funnel, but it
is deliberately not a parent drop-off list.

## Strict guide-access metrics

The strict-access endpoint returns stable, zero-filled `counts` and
`latenciesMs` fields for these stages:

| Stage | Allowlisted outcomes |
| --- | --- |
| `opening` | `accepted`, `failed`, `uncertain` |
| `action` | `received`, `replayed`, `expired`, `unsupported` |
| `fresh_check` | `follower`, `non_follower`, `unavailable` |
| `gate` | `shown` |
| `recheck` | `attempted`, `confirmed`, `not_confirmed`, `unavailable` |
| `cover_gate` | `accepted`, `failed`, `uncertain`, `omitted_not_selected`, `omitted_mismatch` |
| `cover_delivery` | `selected`, `omitted_already_shown`, `omitted_not_selected`, `omitted_mismatch` |
| `delivery` | `planned` |
| `needs_review` | `marked` |

`fresh_check` and `recheck` are the same measurement taken at two different moments, and
keeping them apart is the point. `fresh_check` is the follow check when a parent first
asks. `recheck` is the check after they have already been shown the gate and told us they
followed — so `recheck.not_confirmed` means "they say they followed and Instagram
disagrees", which is the number a follow gate lives or dies by. Both used to be recorded
as `fresh_check`, which made that number unreadable.

`recheck.attempted` is the denominator for the other three.

Every stage in this table has a production writer, asserted by a test that matches on the
typed `recordGuideAccessMetric("stage", …)` call. A declared stage or outcome that nothing
writes reads as a permanent zero, which is indistinguishable from "this has not started yet"
— `cover`, `gate` and `recheck` were all in that state at some point during the guide-cover
work, as were `gate.profile_action_offered` and three `delivery` outcomes. All are either
written now or removed.

Two removals worth naming. `gate.profile_action_offered` went because the follower gate is
unconditionally plain text until the capability spike runs, so nothing could produce it.
`delivery.completed`, `delivery.failed` and `delivery.needs_review` went because the delivery
ledger already emits `sequence_completed`, which the cohort funnel reads to measure delivered
guides — a second, worse measurement of the same thing under a different name is how two
numbers start disagreeing. What this stage adds that the cohort funnel cannot see is delivery
STARTS, which is why `planned` stays.

The test proves a literal call site exists for every stage. It cannot prove the call is
reachable, so read it as a floor rather than a guarantee.

Each latency summary contains `samples`, rounded `average`, `p50`, `p95`, and
`max` milliseconds. Missing samples return zero plus `null` latency values. The
response also includes `totalEvents` and `ownerReviewEvents`.

`totalEvents` counts EVENTS, not journeys, and `recheck.attempted` is a sibling outcome of the
three it denominates — so every recheck contributes twice. That is correct for what the field
says it is; do not read it as a count of parents.

The underlying `guide_access_v2_metric` event is aggregate-safe by construction.
Its payload contains only `version`, an allowlisted `stage`, an allowlisted
`outcome`, and an optional bounded latency. It rejects extra fields. Never add
Instagram account IDs, usernames, guide/resource IDs or titles, action tokens,
DM copy, URLs, provider payloads, or raw errors. Parent investigation belongs in
the durable access-attempt review surface, not in this aggregate endpoint.

The rollout fence is allowlist-first. `GUIDE_FOLLOW_GATE_V2_ENABLED` and
`GUIDE_RICH_GATE_ENABLED` default off and cannot be enabled from the console;
the console may stop them. Even when strict access is enabled in the deployed
environment, an empty `GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS` and empty
`GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS` select nobody. An exact match in either list
enters the controlled pilot. There is intentionally no percentage assignment in
this phase.

## The two rules

**Cohort, not event counts.** A funnel picks the set of conversations that
*entered* in a window, then follows those conversations forward however long
they take. Counting events in a window instead would be wrong twice over:
`markGated` re-arms on every reply, so one stubborn non-follower emits several
`follow_required` events, and their eventual completion often lands *outside*
the window. Every stage is a boolean per conversation, never a row count.

**Rates that refuse to lie about their sample.** Below `minSample`, a rate
reports `null` and callers render the counts instead. "15.6%" over 32 people and
"15.6%" over 3,200 are different claims and only one of them is a number. Same
reasoning as `MIN_RETENTION_SAMPLE` in `followThroughCore.ts`.

A third rule falls out of the first two: this funnel is **not a straight line**.
Someone already following skips the gate and the reply and goes straight to the
guide. Stages that can be reached without passing the previous one are marked
`bypassable`, and no step conversion is printed across them — otherwise the
report says "150% conversion" and the page stops being believable.

## Layout

| File | What it is |
| --- | --- |
| `src/services/funnels/types.ts` | `FunnelDef`, `FunnelStage`, `GuardedRate`, stage arithmetic. Pure. |
| `src/services/funnels/guideFollowFunnel.ts` | Stage definitions, the cohort SQL, the summarizer. Pure. |
| `src/services/funnels/registry.ts` | Key → definition. Add funnels here. |
| `src/services/funnels/runFunnel.ts` | The only impure part: run the SQL, hand rows to the summarizer. |
| `scripts/funnel-report.ts` | CLI. |

Definitions and arithmetic are pure and free of Prisma so that the CLI, a future
`/api/funnels/:key` endpoint behind the Funnels tab, and an MCP client all agree
by construction rather than by convention — and so the arithmetic is testable
with no database (`guideFollowFunnel.test.ts`).

`runFunnel.ts` deliberately does **not** import `src/lib/prisma`, because that
pulls in `config/env`, which requires the whole Meta keyring. A funnel report
needs one credential, not six.

## Running it

### 1. CLI, where a DATABASE_URL exists

```bash
npm run funnel -- guide-follow
npm run funnel -- guide-follow --from 2026-07-01 --to 2026-08-14
npm run funnel -- guide-follow --json
```

Needs `DATABASE_URL` and nothing else. A SELECT-only role is sufficient.

### 2. No database access at all

Print the statement and run it wherever you like — the Supabase SQL editor,
`psql`, a Desktop MCP client — then read the result:

```bash
npm run funnel -- guide-follow --print-sql
```

This opens no connection and reads no environment, so it works from a session
that holds no credentials. The query returns one row per conversation; every
percentage is computed by `summarizeGuideFollow()`, not by the SQL.

### 3. MCP

`.mcp.json` declares a `funnel-db` server reading `FUNNEL_DATABASE_URL_READONLY`.
It stays inert until that variable is set, so the file is harmless when unset.

The server package is swappable — any Postgres MCP server works. What matters is
that the variable holds a **read-only** connection string and nothing else does.

> For Claude Code cloud sessions specifically: cloud environments have no
> secrets store, and the documentation says not to put credentials in
> environment variables. Reaching Supabase also needs the environment's network
> access set to **Custom** with your database host allowlisted. Prefer path 1 or
> 2 for cloud sessions unless you have a reason not to. Configuration changes
> only affect sessions started afterwards.

## The read-only role

Whichever path you choose, do not hand out the service key or the app's
`DATABASE_URL`. Create a role that can read the four tables the funnels need and
nothing else:

```sql
CREATE ROLE funnel_readonly LOGIN PASSWORD '<generate-a-strong-one>';
GRANT CONNECT ON DATABASE postgres TO funnel_readonly;
GRANT USAGE ON SCHEMA public TO funnel_readonly;
GRANT SELECT ON event_log, conversations, ig_users, keywords, guide_link_send, guide_link_click TO funnel_readonly;
```

Verified behaviour of exactly these grants:

- runs the guide → follow cohort query ✅
- `DELETE FROM event_log` → `permission denied` ✅
- `SELECT FROM resources` (outside the grant) → `permission denied` ✅

Widen the `GRANT SELECT` list as later funnels need more tables — narrow by
default is the point.

## Adding a funnel

1. Write a `FunnelDef` with marketer-facing stage labels and a `definition` for
   each stage saying what does *not* count. Mark `bypassable` stages.
2. Write a cohort SQL that returns one row per entity with boolean stage flags.
3. Write a pure summarizer and test it — no database required.
4. Register it in `registry.ts`.

### Leave room for lift

`DmRecoveryCohort` has `treatment | control` and `RecoveryCandidateArm` has
`treatment | holdout`. Funnels over those features can report **lift over
control**, not just a conversion rate — the difference between "34% came back"
and "reminders are worth +9 points over doing nothing". Keep `FunnelDef` a data
structure so an `arm` field can be added without a second renderer.

## Known limits

- The first follow reading is taken ~3 days after delivery and is a **lower
  bound**: someone who follows on day 10 is not counted, and anyone the recheck
  worker has not reached yet is missing entirely.
- Conversion is **correlational**. Nothing here proves the guide caused the
  follow; the guide → follow funnel has no control arm.
- `EVENT_LOOKBACK_MARGIN` (90 days) bounds how far back a reused conversation's
  earlier events are visible. A journey older than that will look like it never
  received a gate.
- **Two gate eras, one cohort.** The V1 text gate wrote `dm_sent` (kind `gate`),
  `done_received` and `follow_required`. The V2 card gate (every guide since
  2026-08-24) writes none of them; its journey lives in `guide_access_attempt` and
  `guide_action_token`. `JOURNEY_SIGNALS` in `guideFollowFunnel.ts` reads both, and
  the drop-off lists share it. Reading only V1 showed "Got the unlock DM: 1" against
  11,590 entries for seven weeks.
- A V2 comment-path attempt counts as the unlock DM. The attempt is created in the
  same step that sends the opening card, so the 10 openings in 11,566 that failed
  (2026-09-13..10-13) are counted as sent.
- The 21-day reading covers **converts only**: people who had to follow to get the
  guide. Someone already following is never re-read, so the bar is drawn against
  "following" but measured against `followThroughDue`.

## Comment → link click (`link-click`)

The link-guide funnel. Its cohort is `keyword_matched` events carrying `deliveryMode: "link"`. Those same events are excluded from `guide-follow` and its drop-off lists, so the gated baseline is never diluted.

| Stage | Source |
|---|---|
| `entered` | First `keyword_matched` per conversation in the window |
| `linkSent` | A `guide_link_send` row with `status = 'sent'` (first try or retry) |
| `clicked` | A `guide_link_click` row with `is_bot = false` |
| `followingMeasured` | Clicked, rechecked by `followRecheckWorker` (~3 days after the tap completed the conversation), and following. Coverage only |

The headline is the click rate (`clicked / linkSent`). `followedAnyway` is following among rechecked clickers, the number that prices moving more recipes to links. Both writers are real code: `guide_link_send` is written by the link sender, and `guide_link_click` by `GET /r/:token`. `linkClickFunnelContract.test.ts` runs the SQL against rows from both.
