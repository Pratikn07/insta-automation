# Funnels

Where people drop off, measured over cohorts.

The first funnel is **guide → follow**. More are already latent in the schema
(historical recovery, DM recovery reminders, public recovery dispatch, AI reply
drafts, per-reel capture) and should be added as *definitions*, not as new pages.

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
GRANT SELECT ON event_log, conversations, ig_users, keywords TO funnel_readonly;
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
