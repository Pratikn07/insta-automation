# Switches and Experiments Design

**Date:** 2026-08-19

**Status:** Approved

**Supersedes:** the single-page surface in
`2026-08-18-experiments-and-flags-design.md` §7. Everything else in that spec —
the registry, the resolver, the asymmetric control model, `flag_override` — stands
unchanged.

## 1. Why this changes

The page shipped and was immediately too much to read: sixteen rows, each carrying
three sentences, all on one screen. Two separate mistakes, found by looking at it in
production rather than at a fixture.

**The wall of text.** Three sentences per row is right on a detail page and wrong on
a list. A list is for finding the thing; the sentences are for deciding about it.

**The name lied.** "Things we're testing" promises a test behind every row. Only two
of the sixteen were ever tests. The rest are switches — they have a *state*, not a
*result*, because nothing is being compared. Calling them experiments made fourteen
rows look like they should have metrics and then failed to produce any.

That second error was the more important one, and it also explains the first: much of
the page's bulk was one experiment's parts listed as if they were unrelated things.

## 2. What an experiment is

**A flag with declared arms.** Arms named, split stated, outcome chosen. No arms means
it is a switch.

Checkable rather than debatable. The alternative — "things that feel like
experiments" — is how the existing Insights → Experiments tab reached 94 rows that
nobody can close, and this design will not repeat it.

Three experiments qualify today:

| Experiment | State | Basis |
| --- | --- | --- |
| Recovery reminder timing | `running` | 1,958 reminded, 394 held out, window closes 21 Aug |
| Cold message test | `not_started` | Arms exist in `gateQueueWorker.ts`; the flag has never been on |
| Guide delivery rollout | `not_started` | Old path versus new path, sitting at 0% |

`not_started` is deliberately a state rather than a separate place. It is the most
useful thing on the page: a list of experiments that could run tomorrow.

**Explicitly excluded:** flags where a comparison is *conceivable* but undeclared —
reply drafts, the better-origin-guess. They stay switches with a quiet marker noting
a comparison is possible. Admitting them would refill the page with aspiration.

## 3. An experiment owns flags

Five of the sixteen belong to recovery reminder timing:

| Flag | Its role |
| --- | --- |
| `DM_RECOVERY_ENABLED` | kill switch |
| `DM_RECOVERY_HOLDOUT_PERCENT` | the split |
| `DM_RECOVERY_WESTERN_ONLY` | eligibility rule |
| `DM_RECOVERY_FAILURE_RATE_PERCENT` | circuit breaker |
| `DM_RECOVERY_POST_EXPERIMENT_ENABLED` | what happens when it ends |

Guide delivery rollout owns two: `GUIDE_DELIVERY_ENABLED` and
`GUIDE_DELIVERY_ROLLOUT_PERCENT`. The cold message test owns `GATE_DM_EXPERIMENT`.

A flag appears **once**, on Switches, and says which experiment it belongs to with a
link. That is why nearly a third of the old page felt arbitrary: those five moved
together and nothing said so.

Eight flags belong to no experiment and stand alone.

## 4. Two destinations

Replaces `/flags` and the label "Things we're testing".

```
SYSTEM
  Experiments      3
  Switches         16
  Activity
  Assistant
```

### `/experiments` — the list

One line each: name, state, and the one number that matters. Nothing else.

```
Recovery reminder timing     running       1,958 v 394 · ends in 2 days   ›
Guide delivery rollout       not started   nobody on the new path yet     ›
Cold message test            not started   never switched on              ›
```

### `/experiments/:key` — the result

The three plain sentences, then what is actually measured. For the running one:
arm counts in whole people, the suppression breakdown, the countdown, and its
declared landing behaviour. For a `not_started` one: what it *would* compare, and
what has to happen first.

No confidence intervals, no significance bars, no "visitors remaining". The
Optimizely screenshots that prompted this show 285,991 visitors; recovery reminders
have 593 sends. `docs/funnels.md` already forbids printing a rate that its sample
cannot support, and `guardedRate` is the existing mechanism.

### `/switches` — the list

Grouped by blast radius, which was the part of the old page that worked. One line
per switch: name, state, and its owning experiment if it has one.

```
REACHES REAL PEOPLE
  Recovery reminders          Live   part of Recovery reminder timing  ›
  Guide delivery              Live   part of Guide delivery rollout    ›
  Guide delivery rollout        0%   part of Guide delivery rollout    ›
  AI sending                   Off                                     ›
  Set up in advance           Live                                     ›
  Historical campaigns        Live                                     ›
```

### `/switches/:key` — the detail

The three sentences, the value in force, where it came from, the drift warning, the
control, and its experiment link. Everything the old row carried, now on a page with
room for it.

## 5. Where the controls live

**On the detail pages, not the lists.** A list you scan should not have a stop button
in it — the whole point of the asymmetric model is that stopping is deliberate.

The rules from the previous spec are unchanged: off in one click, on only via a
deploy, `pageMayStop` only where the flag is read per operation, and the enable fence
enforced in the route as well as the resolver.

## 6. What the API needs

`GET /flags` and `PATCH /flags/:key` are unchanged and already shipped.

Two additions:

- **`GET /experiments`** — the three, with state and a headline figure each.
- **`GET /experiments/:key`** — that experiment's own measurements.

Per-experiment measurement is deliberately **not** generic. Recovery reminder timing
counts arms and suppression reasons out of `dm_recovery_reminder`; guide delivery
rollout would compare two paths. A generic "metrics" abstraction over three
experiments with different shapes would be invented structure. Each experiment
supplies its own summary function, registered by key.

For a `not_started` experiment the summary returns its intent and its blocker, not
zeroes. Zeroes read as failure; "never switched on" reads as a decision.

## 7. Testing

| Area | What is proved |
| --- | --- |
| Registry | Every experiment's `ownedFlagKeys` exist; no flag is owned twice; every flag's `experimentKey` resolves |
| Lists | A list row renders no control and no description |
| Detail | The three sentences, the value in force, and the control appear |
| Enable fence | Still refused server-side after the route moves |
| Rate honesty | No percentage rendered below `minSample` |
| Not-started | Renders intent and blocker, never zeroes |
| Nav | Both destinations exist; `/flags` redirects to `/switches` rather than 404ing |

## 8. Out of scope

Phase 2 of the previous spec is still unbuilt and still applies: the drawn arm
diagram, funnel-backed outcome selection, verdict language, and the worker that acts
on `on_end`. This design changes *where* things live and what they are called. It
does not add the closing machinery.
