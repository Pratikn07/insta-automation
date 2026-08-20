# Experiments and Flags Design

**Date:** 2026-08-18

**Status:** Awaiting review

**Feature:** A single place to see and control every switch in the system, and to close the experiments that run on them.

## 1. Decision summary

One new destination, **Things we're testing**, holding all 16 flags and knobs that
currently live scattered between `src/config/env.ts` defaults and the Railway
variables page.

The page is **decision-first, not inventory-first**. Experiments with an answer
available appear at the top as decisions needing a person; everything else is a quiet
grouped list below. This follows Home's existing `AttentionItem` pattern rather than
inventing a second one.

Values move into the database, seeded from environment variables, exactly as
`ig_token` already works. The page writes rows; the app reads rows; env remains the
seed and the fail-closed fallback.

Control is **asymmetric**. Three flags decide whether the system contacts real people —
`DM_RECOVERY_ENABLED`, `GUIDE_DELIVERY_ENABLED`, `AI_SEND_ENABLED`. The page can turn
those **off in one click** and cannot turn them on. A bug in this page can therefore
only ever make the system quieter.

`WORKERS_ENABLED` is **not** one of them, and one of the three needs a code change
first. See §5a — the page may only offer to stop what it can genuinely stop.

Every flag carries three **required** plain-language fields. Every experiment's
diagram is **rendered from the fields it needs anyway**, so an experiment cannot exist
without one. Every experiment's outcome is **chosen from the funnel stage catalogue**,
never typed in. Every experiment declares what happens when it ends, and a worker
**executes** that instead of leaving it to a default.

A written standard, `docs/experiments.md`, states the rules; required columns and a
check script make it binding.

## 2. Why this exists

The problem is not that experiments are hard to find. It is that they are never
closed.

Evidence in production on 2026-08-18:

| Observation | Count |
| --- | --- |
| Content experiments created since 2 Jul | 94 |
| Of those, ever concluded | **0** |
| Measured with a computed suggestion, unread | 65 |
| System experiments running | 1 |
| Days that one has been running | 11 |
| Times its result has been computed | **0** |

That last row matters most. The recovery timing experiment's answer is available right
now — 585 reminded against 394 left alone — and nobody has looked. It expires
2026-08-21T21:45:00Z, and when it does, `dmRecoveryService.ts` assigns every new
candidate to control with `experiment_awaiting_review`, so **reminders stop being sent
and nothing announces it**.

A registry that only lists things would make this backlog more visible without making
it smaller. So the page is built around closing, and the expiry is built to act.

The secondary problem is real but smaller: of 16 flags, five run on code defaults that
no one set and no interface shows. Nobody could currently tell you that
`DM_RECOVERY_HOLDOUT_PERCENT` is 10, or that it was never chosen.

## 3. Goals

- One place showing all 16 flags, what each is set to, and what each does in plain words.
- Live control of the safe on/off flags and the percentage dials, without a restart.
- A one-click stop for anything that reaches a real person.
- Experiments whose result a content creator can read and act on without help.
- An experiment that ends on purpose rather than by accident.
- A written standard that new experiments must follow, enforced by a check.

## 4. Non-goals

- **Content / reel experiments.** The existing `experiment` table and the Insights →
  Experiments tab are explicitly out of scope and untouched, at the owner's direction.
- **Creating multi-arm experiments from the UI.** Cut deliberately — see §11.
- **Writing to Railway.** Ruled out in §5.
- **Statistical machinery.** No p-values, no confidence intervals, no sequential
  testing. §8 explains what replaces them.
- **Turning dangerous flags on from the page.** Permanently out of scope, not deferred.

## 5. Why not write to Railway

The owner's first instinct was a slider wired to Railway, so the reasoning is recorded
rather than left implicit.

`src/config/env.ts` parses `process.env` once at module load and `process.exit(1)`s on
failure. Nothing re-reads it. So a Railway write can only take effect by restarting the
API, and Railway does that automatically — observed 2026-08-18, where setting
`UPCOMING_AUTOMATIONS_ENABLED` at 16:09 queued a deployment at 16:09:25 unprompted.

A slider wired to Railway is therefore a restart button wearing a slider's face:
workers stop, in-flight webhooks drop, and on that same afternoon the restart sat in
Railway's queue for over ten minutes during a platform incident. The owner would move
the slider and watch nothing happen.

It would also require an API token in the app with permission to rewrite any variable,
including `DATABASE_URL`, `META_APP_SECRET` and `IG_ACCESS_TOKEN`.

The codebase already solved this once. `IG_ACCESS_TOKEN` used to be config; the live
token now lives in the `ig_token` table, refreshes itself, and the env var is a seed.
Config that changes while running belongs in a table.

## 5a. A stop button must actually stop

An earlier draft of this design promised a one-click stop on four flags. Checking where
each is actually enforced showed that two of those promises were false:

| Flag | Enforced | A DB flip would |
| --- | --- | --- |
| `AI_SEND_ENABLED` | Per request, `src/api/ai.routes.ts:318` and `:354` | Stop it immediately and completely |
| `DM_RECOVERY_ENABLED` | Per tick, `dmRecoveryWorker.ts:54` and `historicalRecoveryWorker.ts:100` | Stop it on the next tick |
| `GUIDE_DELIVERY_ENABLED` | Per message at `messageHandler.ts:141`, but `guideDeliveryWorker.ts:88` captures `enabled` at module load | Stop new deliveries and **leave the worker draining the existing queue** |
| `WORKERS_ENABLED` | Once at boot, `server.ts:262` | Do nothing at all |

Two consequences, both load-bearing.

**`WORKERS_ENABLED` is `infrastructure` and read-only.** It cannot be stopped without a
restart, so the page must not imply otherwise. It appears with its value and a note that
it is changed in Railway.

**`runGuideDeliveryTick` must read the flag per tick.** `createGuideDeliveryWorker`
currently takes `enabled` as a captured boolean; it needs to take a resolver
(`() => boolean`) called at the start of each tick, as the DM recovery workers already
do. Without that change, "Stop now" on guide delivery is a half-truth — the more
dangerous kind, because the button appears to have worked.

**The invariant:** the page offers a stop only where the flag is checked per operation,
and a test proves it for each one. `page_may_stop` is a column, not a UI assumption, and
`check:flag-coverage` fails if a flag is marked stoppable without a corresponding
per-operation enforcement test.

## 6. Data model

Two tables. Both additive.

### `flag`

One row per switch, whether or not it is experimental. The plain-language columns are
`NOT NULL` — that is the enforcement, not a form validation.

| Column | Notes |
| --- | --- |
| `key` | Unique. Matches the env var name exactly, e.g. `AI_DRAFTS_ENABLED`. |
| `name` | Human title, e.g. "AI reply drafts". |
| `group` | `outbound` \| `experiment` \| `assistive` \| `infrastructure`. Drives §7 ordering. |
| `does_what` | **NOT NULL.** One or two sentences, no jargon. |
| `affects_who` | **NOT NULL.** Plain description of the population. |
| `if_off` | **NOT NULL.** What changes if it is switched off. |
| `kind` | `boolean` \| `percent`. |
| `page_may_enable` | `false` for the three outbound flags. Enforced server-side, not in the UI. |
| `page_may_stop` | `true` only where the flag is checked per operation. See §5a. `false` for `WORKERS_ENABLED`. |
| `value_bool` / `value_percent` | The live value. Null means "no override, use the env seed". |
| `shipped_at` | Set by *mark as shipped*. Drops the row out of the active list. |
| `updated_by`, `updated_at` | Who last changed it. |

### `experiment_rule`

Only for flags in the `experiment` group. Immutable after first assignment.

| Column | Notes |
| --- | --- |
| `flag_key` | FK to `flag`. |
| `version` | Immutable identity, e.g. `read-recovery-v1`. |
| `steps` | Ordered `String[]`. One short sentence each. Renders the diagram. |
| `arms` | JSON: `[{ key, percent, does_what, is_control }]`. Must total 100 and contain exactly one `is_control`. |
| `outcome_funnel_key` | e.g. `guide-follow`. |
| `outcome_stage_key` | e.g. `guideDelivered`. Must exist in that funnel's definition. |
| `outcome_window_hours` | e.g. 48. |
| `starts_at`, `ends_at` | Both required. |
| `on_end` | `keep_winner` \| `revert_to_off` \| `hold_current`. **Required.** See §9. |
| `ended_at`, `verdict`, `verdict_note` | Written when it closes. |

`arms` is JSON rather than a table because an arm has no identity outside its rule and
is never queried independently. If arm-level history is ever needed, that is the signal
to promote it.

## 7. The page

### Reading order

1. **Decisions.** Rendered like Home's attention items: a sentence, the number, one
   action. A rule appears here when either is true:
   - **Its answer is available** — every arm, including the control, has reached
     `minSample` for the chosen outcome stage, so `guardedRate` returns a number rather
     than null for all of them. Not "some data exists".
   - **It ends within 7 days**, whether or not the answer is available, because the
     landing in §9 is about to happen either way.
2. **Everything else**, grouped, loudest first: `outbound` → `experiment` →
   `assistive` → `infrastructure`. Grouped by blast radius because the 16 flags are not
   peers — `AI_DRAFTS_ENABLED` cannot hurt anyone and `DM_RECOVERY_ENABLED` posts
   public comments on real reels.

### Row

`name` · `key` · the control · status chip. Controls by kind:

- `boolean`, page may enable → a switch.
- `boolean`, page may not enable → a **Stop now** button when live; a locked note when off.
- `percent` → a slider and its value.
- experiment → a read-only summary and its countdown.

**No `Source` column.** An earlier draft proposed one and it is deliberately dropped:
its value was the one-time discovery of the five flags on code defaults, and once those
are set deliberately it would read "Saved here" on nearly every row forever. The two
states that matter ongoing are exceptions, so they are badges on the row: **never
set by anyone**, and **drifted from the env seed** — the second matters because a
restart reverts to the seed.

### Expanded flag

The three plain-language fields, then the value in force, the env seed, and whether the
flag causes anything to be sent.

### Expanded experiment

The three fields, then the diagram drawn from `steps` and `arms`, then the outcome
sentence, then live per-arm counts, then the countdown and its declared `on_end`.

## 8. Metrics a content creator can read

### Outcomes come from the funnel catalogue

`outcome_stage_key` must name a stage in an existing `FunnelDef`
(`src/services/funnels/registry.ts`). Today that is:

| Stage | Label |
| --- | --- |
| `entered` | Asked for a guide |
| `gateSent` | Got the unlock DM |
| `replied` | Replied |
| `guideDelivered` | Got the guide |
| `followingMeasured` | Following (first reading) |
| `followingD21` | Still following (21 days) |

Free text is rejected. A typed-in metric is a metric nobody implemented, whereas every
stage above is already cohort-correct and sample-guarded. New metrics are added as
funnel definitions, which `docs/funnels.md` already names as the intended extension
path.

### Presentation rules

**Every number is a comparison, and the do-nothing arm is always shown.** Without it,
"68 in 100" could be excellent or dreadful and no one can say which.

**Whole people, never decimals.** "68 in 100", not "68.4%". A decimal implies precision
that 585 observations do not support.

**No p-values.** Reuse `guardedRate(numerator, denominator, minSample)` from
`src/services/funnels/types.ts`. When it returns null the page prints counts and what
is still missing — *"Still counting — about 400 more people needed"* — which is the
same fact in a form that says what to do about it.

Rendered:

```
Trying: remind people sooner
Worth keeping — 7 more people in 100 got their guide

  Remind at 2 hours    68 in 100 got their guide
  Remind at 6 hours    61 in 100
  Say nothing          44 in 100
```

### Language

"Experiment" is a researcher's word and does not appear in the interface. The
destination is **Things we're testing**; each row reads *"Trying: remind people
sooner"*. Verdicts are **Worth keeping / Made no difference / Made it worse / Still
counting**, stored as `verdict` values `kept` / `no_difference` / `worse` /
`inconclusive`.

### Translating to followers

Stopping at *got their guide* makes every experiment feel academic, because followers
are what the owner cares about. But reaching followers means chaining guide→follow
conversion against 21-day retention, and chained estimates compound error: "about 5
extra followers" could be 2 or 9.

**Decision:** show it, always labelled, never asserted. One line, marked as an
estimate, naming both rates it is built from and the sample behind them. If either
input rate is below its `minSample`, the line is withheld entirely rather than
softened — the same rule the funnel already applies to itself.

## 9. Ending on purpose

Every rule sets `on_end` before it starts:

- `keep_winner` — the winning arm's behaviour becomes the default for everyone.
- `revert_to_off` — the flag goes off.
- `hold_current` — behaviour freezes as-is pending a decision.

A worker tick after `ends_at` applies the declared behaviour, writes `ended_at`, and
logs `experiment_ended` with the version and what it did. If `on_end` is `keep_winner`
and no arm clears `minSample`, it degrades to `hold_current` and logs that instead —
it must never pick a winner from a number it would refuse to print.

This exists because of the 21 August case: the live experiment's actual landing
behaviour is "silently stop sending reminders", which nobody chose. It is the default
falling through, and it is the failure this section prevents.

The page surfaces any rule ending within 7 days as a decision, so the landing is
visible before it happens rather than discovered afterwards.

## 10. Reading a flag at runtime

A `flagService` with a short in-process cache, refreshed on a timer, resolving in
order:

1. `flag.value_bool` / `value_percent`, when not null.
2. The env value.
3. The zod schema default.

**Fails closed.** If the table is unreachable, the resolver returns the env value and
logs once per interval. It never returns a more permissive value than env — a database
problem can make the system quieter, never louder. `page_may_enable = false` is checked
server-side in the route as well as in the resolver, so a crafted request cannot enable
an outbound flag.

Roughly 16 call sites move from `env.X` to `flags.X()`. `WORKERS_ENABLED` stays on `env`
— it is read once at boot by design, which is also why it cannot be stopped from the
page (§5a).

One call site changes shape rather than just its source: `createGuideDeliveryWorker`
takes `enabled` as a captured boolean and must take `() => boolean` instead, so the flag
is resolved per tick. Without that the guide-delivery stop is incomplete.

## 11. Why there is no create form in v1

An earlier draft included one. It is cut, and not only its multi-arm parts.

A form cannot create a working experiment. Arms have to be implemented in code — the
recovery timing arms are code-frozen schedules — so a UI that appears to create one
would produce a row describing behaviour that does not exist. The owner will define a
handful of experiments this quarter, each alongside the code that implements it, so the
plain-language fields are seeded in the same commit.

Build the form after five experiments have run, when the fields are known rather than
guessed.

## 12. The standard, and its teeth

`docs/experiments.md`, in the style of `funnels.md` — rules with the reason each was
earned:

1. **Plain English or it does not ship.** What it does, who it affects, what changes if it is off.
2. **The outcome is a funnel stage, not a sentence you invented.**
3. **A rate below `minSample` prints counts, never a percentage.**
4. **Arms are immutable once anyone is assigned.**
5. **There is a do-nothing arm.** Otherwise you learn 2h beats 6h and never whether reminding beats silence.
6. **Every experiment states what happens when it ends, and the system does it.**
7. **Off is one click. On is a deploy.**

Enforcement is not the document. Two mechanisms:

- `NOT NULL` on the three plain-language columns, and zod `min(1)` on the routes.
- `npm run check:flag-coverage` — reads every flag name out of `src/config/env.ts` and
  fails if any lacks a `flag` row, or if any `experiment_rule` has arms not totalling
  100, no control arm, an unknown `outcome_stage_key`, or a missing `on_end`. Same shape
  as the existing `check:guide-delivery-bypasses`.

The one-time cost is honest: **16 descriptions to write**. That is most of the work in
this feature, and most of its value.

## 13. Testing

| Area | What is proved |
| --- | --- |
| Resolver precedence | DB over env over default, for both kinds. |
| Fail-closed | Table unreachable returns env; never returns a more permissive value. |
| Enable fence | A request to enable a `page_may_enable = false` flag is refused server-side. |
| Stop actually stops | Per flag marked `page_may_stop`: flipping the row stops the next operation. For guide delivery specifically, that the **worker tick** halts, not only new enqueues. |
| Stop is never promised falsely | `WORKERS_ENABLED` offers no stop control, and `check:flag-coverage` fails if a flag is marked stoppable with no per-operation enforcement test. |
| Rate honesty | Below `minSample` no percentage is rendered anywhere. |
| Arm validation | Arms not totalling 100, or with zero or two controls, are rejected. |
| Diagram | Renders from `steps`/`arms` with no separate stored artifact. |
| `on_end` | Each of the three behaviours applies once, logs, and is idempotent across ticks. |
| `keep_winner` degradation | With no arm clearing `minSample`, it holds and logs instead of picking. |
| Follower estimate | Withheld entirely when either input rate is below `minSample`. |
| `check:flag-coverage` | Fails on a flag added to `env.ts` with no row. |
| Contrast | Every status chip clears 4.5:1 on both paper surfaces. |

Backend contract tests run against the disposable loopback Postgres, so the migration
contract executes rather than skipping.

## 14. Size, and the natural split

This is larger than one sitting: two tables, a resolver with a cache and a fail-closed
path, ~16 call-site migrations, a worker signature change, a new page with three row
types, an end-of-experiment worker, a check script, a standard, and 16 descriptions
written by hand. Comparable in size to the Maison readiness plan, which ran twelve
tasks.

It splits cleanly in two, and the first half is independently useful:

**Phase 1 — see everything, stop anything.** The `flag` table, the three plain-language
columns, the resolver, the call-site migration, the guide-delivery per-tick fix, the
grouped list with switches and sliders, `check:flag-coverage`, `docs/experiments.md`, and
the 16 descriptions. Delivers the whole inventory and every control. Experiments render
read-only from their existing config, with no new experiment table at all.

**Phase 2 — close experiments.** `experiment_rule`, the decisions section, the drawn
diagram, funnel-backed outcomes with `guardedRate`, the verdict language, and the
`on_end` worker.

Phase 1 is worth shipping alone: it ends the situation where five flags run on values
nobody set and where stopping an outbound feature means a Railway edit and a ten-minute
deploy. Phase 2 is what stops experiments from accumulating unclosed, and depends on
nothing in Phase 1 except the `flag` row it hangs from.

**One caveat on sequencing.** Neither phase resolves the 21 August expiry. That is an
operational decision needed this week — extend the window, ship recovery timing v2, or
set `DM_RECOVERY_POST_EXPERIMENT_ENABLED` — and it must not wait on this build.

## 15. Open question for review

Rule 5 has a real cost: a control arm means roughly 10% of people deliberately get
nothing. On the recovery experiment that is about 39 people a week who receive no
reminder. The alternative is never knowing whether the feature works at all, which is
how 62 unattributable content experiments happened. Recorded as a decision to confirm,
not an assumption.
