# Experiments and flags

Every switch in this system is described in `src/config/flagRegistry.ts`, and
`flagRegistry.test.ts` fails the build when one is added to `env.ts` without a
description. This document is why those rules exist.

Before this existed, sixteen switches were split between schema defaults and the
Railway variables page, five of them running on values nobody had chosen, and nothing
anywhere said what any of them did.

## The seven rules

**1. Plain English or it does not ship.** Three answers per flag: what it does, who it
affects, and what changes if it is off. The third is the one an operator actually needs
and the one nobody thinks to write. A length floor in the test is a crude proxy for
"did you answer" — if it rejects a genuinely complete sentence, say more rather than
lowering the floor.

**2. The outcome is a funnel stage, not a sentence you invented.** An experiment's
outcome names a stage in a `FunnelDef` (`src/services/funnels/registry.ts`) —
*Asked for a guide*, *Got the unlock DM*, *Replied*, *Got the guide*, *Following*,
*Still following (21 days)*. A metric typed into a text box is a metric nobody
implemented. New metrics are added as funnel definitions, which `funnels.md` already
names as the intended way to extend.

**3. A rate below `minSample` prints counts, never a percentage.** Straight from
`funnels.md`: "15.6%" over 32 people and over 3,200 are different claims and only one
of them is a number. Reuse `guardedRate`. When it returns null, say what is still
missing — *"about 400 more people needed"* — rather than showing a p-value.

**4. Arms are immutable once anyone is assigned.** Recutting the split mid-flight
invalidates the result you were waiting for.

**5. There is a do-nothing arm.** Otherwise you learn that two hours beats six and
never whether reminding beats silence. It costs roughly a tenth of people getting
nothing, and that is the price of an answer. It is also what makes every number
legible: *68 in 100 got their guide* means nothing until you know that saying nothing
gets 44.

**6. Every experiment states what happens when it ends, and the system does it.**
Earned the hard way. The first timing experiment's real landing behaviour was "silently
stop sending reminders" — nobody chose that; it was a default falling through, and
nothing announced it.

**7. Off is one click. On is a deploy.** And a stop is offered *only* where the flag is
read per operation. This one has teeth because it was nearly broken: guide delivery
captured its flag at module load, so switching it off would have stopped new deliveries
while the worker kept draining the queue — a stop button that appears to have worked.
`pageMayStop` now requires a test proving the next operation halts.

Two flags offer no console control at all, for two different reasons.
`WORKERS_ENABLED` is read once at boot, so a change could not take effect without a
restart. `DM_RECOVERY_FAILURE_RATE_PERCENT` is the point at which the system stops
sending by itself, so *raising* it would make the system tolerate more failures — the
one direction this console may not move anything.

## Adding a flag

1. Add it to `src/config/env.ts` with `booleanFlag()` or a bounded number. Never
   `z.coerce.boolean()` — `AI_SEND_ENABLED=false` parses to `true` under coercion, and
   `booleanFlag.ts` explains why that nearly shipped.
2. Add a `FlagDefinition` in the same commit. `flagRegistry.test.ts` parses `env.ts` and
   fails otherwise, so this is not optional.
3. Read it through `flags.bool(key)` or `flags.percent(key)`, never `env.KEY`.
   `flagCallSites.test.ts` enforces this. Two exemptions, both recorded there: `env.ts`
   itself, whose cross-field checks validate what the operator wrote rather than what is
   in force, and `server.ts`, whose scheduler options decide at boot whether to start a
   worker at all — a stored row cannot start a scheduler that never started.
4. If you set `pageMayStop: true`, write the test that proves the stop works.

## Where a value comes from

Three places, in order: the `flag_override` row, then the deployed environment value,
then the schema default. An absent row means "no override", so an empty table behaves
exactly like production before any of this existed.

Values live in a table rather than only in the environment because an environment
variable is parsed once at boot: changing one takes effect only by restarting, and on
Railway that restart happens automatically. A console slider wired to a restart is not
a slider. `ig_token` solved this first — the environment seeds it, the table owns it
while running.

The resolver **fails closed**. A stored `false` is always honoured; a stored `true`
only where the definition permits it. An unreadable table serves the environment value
and keeps whatever it had, rather than clearing the cache and reverting every override
at once. So the worst this system can do is make itself quieter.

## Switches versus experiments

An experiment is **a flag with declared arms** — named, split stated, outcome chosen.
No arms means it is a switch. Checkable rather than debatable, which is the point: the
older Insights → Experiments tab defined it by feeling and holds 94 rows nobody can
close.

The two live at separate addresses, because a switch has a *state* and an experiment
has a *result*:

| | Switches | Experiments |
| --- | --- | --- |
| Address | `/switches` | `/experiments` |
| A row shows | name, state, owning experiment | name, state, the one number that matters |
| A detail page shows | the three sentences, the value in force, the control | arms in whole people, what was skipped, the countdown |
| Registered in | `src/config/flagRegistry.ts` | `src/config/experimentRegistry.ts` |

Rules that follow from this, all enforced by tests rather than review:

1. **Lists carry no controls and no descriptions.** One line per row. Three sentences
   are right on a detail page and wrong on a list — a list is for finding the thing.
   Stopping stays deliberate, which a stop button inside a list you are scanning is
   not.
2. **A flag belongs to at most one experiment**, and the two directions must agree.
   Owned twice, it would appear under two experiments and its numbers would seem to
   contradict themselves.
3. **A switch is never named the same as its experiment.** The row prints
   "*switch* · part of *experiment*", and identical names read as a tautology.
4. **`not_started` returns intent and a blocker, never zeroes.** Zeroes read as "we
   tried and nobody converted"; "never switched on" reads as a decision. It is listed
   rather than hidden, because a list of experiments you could run tomorrow is the most
   useful thing on the page.
5. **Counts in whole people, never rates.** No confidence intervals, no significance,
   no "visitors remaining". The Optimizely pages this borrows its shape from report
   285,991 visitors; recovery reminders have 594 sends. `docs/funnels.md` already
   refuses to print a rate its sample cannot support.
6. **Every person lands in exactly one bucket.** An arm, or a named skip. The obvious
   implementation — treatment is `sent`, skipped is `suppressed` — silently dropped 71
   real people out of 2,360 and still looked complete.
7. **Each experiment supplies its own summary function**, registered by key in
   `src/services/experimentSummary.ts`. Recovery counts arms out of
   `dm_recovery_reminder`; a rollout would compare two delivery paths. One abstraction
   over three different shapes would be structure we invented rather than structure the
   data has.

## Decisions taken

Until rule 6's closing surface exists, a decision about a live experiment is recorded
here. One entry per decision, and it must say what the evidence actually supported —
a kept behaviour is not the same claim as a proven one.

### recovery-reminder-timing — kept on, unproven (19 August 2026)

`DM_RECOVERY_POST_EXPERIMENT_ENABLED` was set to `true` two days before the window
closed on 21 August 2026, so reminders continue instead of pausing for review.

**This is not a measured win.** Matched per-protocol comparison — people who had not
engaged by the moment a reminder came due, treatment being those who actually received
one:

| | Got a reminder | Got nothing |
| --- | --- | --- |
| People | 638 | 200 |
| Engaged afterwards | 91 | 23 |
| Got the guide | 61 | 16 |

Reminders lead on both, by roughly three people per hundred on engagement and one and a
half per hundred on getting the guide. Neither difference survives its own sample:
p≈0.30 and p≈0.49. Per rule 3 these counts do not support a headline rate, and what is
missing is large — detecting a difference this size on this base needs on the order of
**5,000 more people per arm**. At 638 treatment rows per fortnight the window would have
to stay open for years, so the experiment as designed can never conclude.

The decision was therefore made on the direction of travel and the cost of being wrong:
one reminder DM to somebody who asked for a guide and did not come back. It was made
deliberately and with the numbers above in view.

**What would overturn it.** A reminder that measurably annoys people — unfollows or
blocks rising among reminded users — or `feat/dm-recovery-timing-v2` changing when
reminders fire, which changes the intervention and so restarts the question.

The three arms the earlier confounded readings produced are worth naming, because two of
them are wrong and both looked authoritative: comparing all treatment rows to all control
rows says control wins 56% to 27%, because treatment's denominator carries 1,339
suppressed people who were never sent anything. Comparing sent-treatment to all control
says control wins 11.5% to 14.3% the other way, because a reminder was suppressed for
anyone who had already engaged — so the people who got one are, by construction, the
non-responders. Only the matched comparison above answers the question that was asked.

## Not built yet

Closing experiments — the decisions surface, the diagram drawn from stored steps and
arms, funnel-backed outcomes, the verdict language, and the worker that executes rule 6
— is specified in
`docs/superpowers/specs/2026-08-18-experiments-and-flags-design.md` as Phase 2.
