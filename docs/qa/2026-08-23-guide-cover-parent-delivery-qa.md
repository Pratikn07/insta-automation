# Guide Cover Parent Delivery QA — 2026-08-23

## Commit Under Test

`06122e5` on `codex/follower-button-flow` — the last commit that changes code.
This report and any later documentation commits sit on top of it.

This report covers the last of five plans in the guide-cover release train:

| Plan | Tasks | State |
| --- | --- | --- |
| `2026-08-22-meta-rich-guide-gate-capability-spike` | 5 | 4 done; Task 5 is a live Meta run, human-gated |
| `2026-08-22-guide-cover-rendering-and-publishing` | 9 | 9 done |
| `2026-08-22-guide-cover-creator-console` | 8 | superseded by the 6-task replan below |
| `2026-08-22-creator-guide-cover-console` | 6 | 6 done |
| `2026-08-22-strict-follower-gate-v2` | 8 | 8 done, plus a review-added Task 9 |
| `2026-08-22-guide-cover-parent-delivery-rollout` | 8 | Tasks 1–7 done; Task 8 is the phased rollout, human-gated |

No plan file has its checkboxes ticked. The commit history is the record, not the
checkboxes — stated here so nobody reads an unticked box as unfinished work.

## What ships, and what it does while disabled

A published cover image can be prepended to a guide DM as its first message. Every
switch defaults off and the cohort defaults to nobody, so on an unconfigured
deployment the guide goes out exactly as it did before covers existed — only the
image is withheld.

There are **two** cover paths and each has its own fence. Both govern the image only:
never follower authorization, and never which service owns the send.

- `eligibleCover` (`src/services/guideDeliveryService.ts`) fences the cover prepended as
  the first unit of a ledger delivery, consulted once before the plan is compiled.
- `exposeCoverForGate` (`src/services/guideAccessActionService.ts`) fences the cover the
  follow gate sends directly to a non-follower. This one shipped unfenced; see Critical
  below.

Verified by grep that `guideDeliveryOwner` never imports the cover selector, so cover
inclusion cannot influence which service owns a guide send.

### Flag defaults, read from `src/config/env.ts`

| Variable | Default | Parser |
| --- | --- | --- |
| `GUIDE_FOLLOW_GATE_V2_ENABLED` | `false` | `booleanFlag` |
| `GUIDE_RICH_GATE_ENABLED` | `false` | `booleanFlag` |
| `GUIDE_COVER_DELIVERY_ENABLED` | `false` | `booleanFlag` |
| `GUIDE_DELIVERY_ENABLED` | `false` | `booleanFlag` |
| `GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS` | empty | string |
| `GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS` | empty | string |
| `GUIDE_COVER_DELIVERY_RESOURCE_IDS` | empty | string |
| `GUIDE_DELIVERY_COHORT_IG_USER_IDS` | empty | string |
| `GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT` | `0` | int 0–100 |
| `GUIDE_DELIVERY_ROLLOUT_PERCENT` | `0` | int 0–100 |

Every boolean uses `booleanFlag`, never `z.coerce.boolean`, so the string `false`
really is false. Audit the parsed value, not the raw string.

`env.ts:373` refuses `GUIDE_DELIVERY_ENABLED=true` with neither a cohort nor a
percentage — it throws at startup rather than enabling a path that would select
nobody. The V2 and cover switches have no equivalent guard because their selectors
fail closed to `"v1"` and `"omit"`; that combination selects nobody instead of
throwing. Both are safe; the asymmetry is noted so nobody reads the missing guard as
an oversight.

### Which switch stops what

Recorded here because the existing rollback section did not cover it and it is easy
to get wrong under pressure. `guideAccessActionService` wires `startGuideDelivery` to
`deliverGuideForTrigger` directly and never consults `guideDeliveryOwner`, so:

- `GUIDE_COVER_DELIVERY_ENABLED=false` stops covers only, on the next decision.
- `GUIDE_FOLLOW_GATE_V2_ENABLED=false` stops strict-gate sending, on the next decision.
- `GUIDE_DELIVERY_ENABLED=false` stops the retry worker and the legacy-vs-ledger routing
  on the next worker tick (`guideDeliveryWorker.ts:100` reads it through the flags
  service), and does *not* stop a strict-gate delivery. Note the asymmetry: the scheduler
  is only created when the flag is true in boot-time env (`server.ts:196`), so turning it
  ON needs a restart while turning it OFF does not. Setting it false while the strict gate
  is on is worse than either state alone — deliveries still start, but the worker refuses
  to run, so a retryable unit is never retried and the guide sits unfinished.
- `GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT` cannot be lowered from the console at all.
  `resolvePercent` discards a stored value for any key `pageMayEnable` forbids, and the
  registry now declares `pageMayStop: false` to match. The stop is the boolean.

## Automated verification

All executed against commit `06122e5` on 2026-08-23.

| Gate | Result |
| --- | --- |
| Backend suite | **3378 passed / 215 files / 0 skipped** |
| Web suite | **940 passed / 73 files** |
| Playwright E2E | **120 passed** (desktop + mobile) |
| Backend typecheck | clean |
| Web typecheck | clean |
| Backend build (`npm run build`) | clean; compiled SQL verified to contain the cover vocabulary |
| Web production build | clean; bundle grepped for app code, not trusted on exit status alone |
| `eslint .` (web) | clean |
| `scripts/check-guide-delivery-bypasses.mjs` | `guide_delivery_bypass_check_passed` |
| `prisma migrate deploy` on a pristine database | all migrations applied, in order |

**One load-sensitive flake, unresolved and stated plainly.** Across roughly a dozen full
runs, a single test failed twice. The one occurrence I captured was
`src/api/aiDrafts.routes.test.ts > "does not let an audit write failure create an unhandled
owner retry"`. That file passes 53/53 eight times out of eight in isolation, and the suite
total is stable at 3378 every run, so no test is conditionally skipped. It mocks Prisma
entirely, so it is not database contention; the likely mechanism is a `mockRejectedValueOnce`
consumed by a floating promise under CPU pressure. It is in a file this branch does not touch
and I could not reproduce it deterministically, so it is **not fixed** — recorded here so it
is not mistaken for a new failure during rollout.

### Verification the unit tests could not do

The metrics reader's tests all mock `$queryRawUnsafe`. A mocked query cannot tell a
valid SQL string from a correct one, so the aggregate was additionally run against
real PostgreSQL with 121 seeded rows. That found a **Critical** defect (below) and,
after the fix, produced exactly the shares the mocked tests assert: 20% included, 85%
accepted, 4% duplicate-suppressed, 6% mispaired, with a malformed historical outcome
correctly dropped.

## Defects found and fixed during this pass

Two independent adversarial reviews were run against the branch, plus execution-based
verification. Three rounds of review found **six Critical** defects between them, the last
of which was introduced by the fix for the third. Each was found by review
or by execution, never by reading the code and feeling satisfied. Every fix was
mutation-verified: the production change was broken deliberately and the test suite had to
fail.

### Critical

**Cover metrics were silently discarded.** `AGGREGATE_SQL` carried a second hand-written
copy of the stage/outcome vocabulary and omitted the cover stage. Cover events were
written, validated against the closed vocabulary, stored — and dropped by the reader.
Every cover count would have read zero through the entire rollout. Worse, the panel's
empty state and the runbook both tell an operator that zero means "the pilot has not
started", so the symptom was camouflaged by design. The predicate is now generated from
the vocabulary. Found by running the aggregate against real PostgreSQL with 121 seeded
rows — the unit tests all mock `$queryRawUnsafe`, and a mocked query cannot tell a valid
SQL string from a correct one. Fixed in `78a82fe`.

**The gate cover ignored its own kill switch.** `exposeCoverForGate` sends the cover image
DIRECTLY to a non-follower and never consulted the rollout selector. Publishing a cover in
the creator console was therefore enough to put an image in front of a real parent with
`GUIDE_COVER_DELIVERY_ENABLED=false` and the cohort empty — through
`GUIDE_COVER_AUTHORING_ENABLED`, the one new flag the console may enable, whose own
description promised "It does not message parents or alter guide delivery." Both cover
paths now consult the same selector. Fixed in `0e41e36`.

**A duplicate follow gate to a real parent.** An uncertain gate send parked the attempt in
`needs_review` from `checking_follow`, and `markNeedsReview` never persisted
`lastFollowResult` — so the attempt kept `unknown`, meaning "we never found out", although
the check HAD answered. `isRetryableReview` keys on exactly that field, so the review
stayed re-enterable and the parent's next ordinary DM sent a second identical gate.
Bounded at three by `MAX_FOLLOW_CHECKS`. Also a regression against V1, which parks an
uncertain gate reply as `send_uncertain` and never retries it. Every review inside
`handleNonFollower` now records the answer it had; `handleUnavailable` deliberately still
records none, so its intended re-check survives. Fixed in `8fb31de`.

**Cancelling a delivery could expire a different, live attempt.** The cancel matched on
`state: "delivering"` alone. A stale delivery in the review backlog can outlive its own
attempt, so cancelling it expired the LIVE attempt, leaving nothing active — and the
parent's next message opened a third attempt and sent a third guide while the second was
still in flight. Fenced on the messaging window, the same identity handle
`settleAttemptForConversation` already used. This one was self-inflicted: the same hazard
had been fixed 200 lines away in the same session. Fixed in `0e41e36`.

**A stale completion could settle the wrong attempt.**
`settleAttemptForConversation` identified its attempt by conversation alone, so a callback
arriving after its own attempt was force-expired and replaced would close the replacement,
releasing the conversation while a second guide was in flight. Fixed in `f0328cd`.

### Important

**Cancelling a review did not release the parent.** The cancel path moved the attempt
`delivering → needs_review`, but `needs_review` is also active, and the only escape from it
requires `lastFollowResult: "unknown"` — which
`guide_access_attempt_state_follow_result_check` forbids on anything that reached
`delivering`. The parent stayed blocked for the whole window with no surface showing it.
Now terminal. Fixed in `f0328cd`.

**Two cover funnels were being divided by each other.** The two cover recorders write
disjoint halves of what was one stage: the gate records only its send result, the delivery
planner only its plan-time decision. `accepted / selected` was therefore gate exposures
over delivery selections. The panel could read "accepted 100%" and "failed 100%"
simultaneously — `guardedRate` clamps, so both mutually exclusive outcomes hit the ceiling
— or report that nothing had been considered while thirty parents had received an image.
Task 8 reads its expansion thresholds off this panel, so fixing the SQL alone would have
turned a silent zero into a confident wrong number. Split into `cover_gate` and
`cover_delivery`, each rate denominated only from its own stage. Fixed in `0e41e36`.

**A stuck attempt had no remedy.** Every fault routes to `needs_review`, an active state
nothing clears: `markExpired` had no production caller, no route read
`guide_access_attempt`, and the only escape was the parent messaging again *after* their
window lapsed. A parent who gave up stayed blocked, invisibly. One admin release action
now clears it, refusing `delivering` and demanding the same explicit duplicate-risk
acknowledgement the uncertain-unit retry does, audited as `guide_access_owner_action`.
Fixed in `cb51159`.

**The cover/guide integrity check was unreachable.** The resource-mismatch check sat behind
the rollout fence, so while the flag is off — every deployment today — a snapshot paired
with the wrong guide was never detected. Integrity now precedes policy in both cover
paths, with its own `omitted_mismatch` outcome. Fixed in `628a360`.

**Three flag descriptions were wrong in ways an operator would act on.**
`GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT` advertised `pageMayStop: true` while
`resolvePercent` discards stored values for a key `pageMayEnable` forbids.
`GUIDE_DELIVERY_ENABLED` claimed to stop new guide sends, which is false for a
strict-access parent. `GUIDE_RICH_GATE_ENABLED` claimed to govern a check-follow control
that can never be enabled. All three corrected; the percent invariant is now asserted
across the whole registry rather than per key. Fixed in `628a360` and `c8fd16b`.

**A 200 without `coverRates` sat in a permanent skeleton.** The console deploys ahead of
the API here, so that ordering is expected, and react-query does not retry a success.
Absent is now distinguished from empty. Fixed in `0e41e36`.

**A gate cover acknowledged with no message id counted nothing** — the exact class the
runbook tells operators to watch. Fixed in `0e41e36`.

**An unrecognised quick-reply payload was dropped silently.** Returning rather than falling
through is deliberate (a reply's visible title must never reach keyword matching), but a
future quick reply added elsewhere would have vanished without a trace. It now warns.
Fixed in `c8fd16b`.

**Two more stages were declared and never written.** `gate` and `recheck` were admitted by
the vocabulary AND by the SQL, and no code produced either — the same permanent zero as the
`cover` stage, on the same page. `recheck` was the costly one: its outcomes were folded into
`fresh_check`, so the funnel could not separate "was not following when they asked" from
"says they followed and Instagram disagrees", which is the number a follow gate lives or
dies by.

They are now recorded in `guideAccessActionService.authorizeClaimed`, which is the only
layer that can tell them apart — `context.falseResponse === "lag"` is exactly "this parent
has already been asked to follow", and an outcome value alone carries no such information.
Two consequences worth stating:

- The three `fresh_check` entries were removed from `messageHandler`'s outcome map, so
  nothing double-counts on the keyword branch.
- The **token** path — a parent tapping "I'm following" — previously recorded no
  follow-check metric at all, because that map was only consulted on the keyword branch.
  Both callers of `authorizeClaimed` are now counted, so every follow check in the system is
  measured for the first time.

`gate.shown` counts only a provably delivered gate: an uncertain send is excluded because it
would inflate the denominator of every downstream gate conversion, and the follow-lag nudge
is excluded because it is not the gate.

`gate.profile_action_offered` was **removed** rather than wired. The follower gate is
unconditionally plain text by design until the capability spike runs, so nothing could ever
produce it, and a declared-unwritable outcome is the same camouflage as an unread stage.

The structural fix: a test now asserts every stage in the vocabulary has a production
writer, matched on the two forms that actually record rather than on the bare string —
`"gate"` also appears as a `falseResponse` value and would have passed a naive grep while
the stage stayed dead. Verified end-to-end afterwards: all 29 declared (stage, outcome)
pairs survive the real SQL against real PostgreSQL, and a hostile outcome is still dropped.

**Three more Criticals-and-Importants from a third review round, on the commits the earlier
rounds had not seen.** The most serious was self-inflicted: stopping the duplicate follow gate
meant recording the definite follow answer on a review, which makes it terminal, and I applied
that to EVERY review in the non-follower branch — including three where nothing that tells a
parent what to do had reached them. The worst hands a parent a cover image with no
instructions and then refuses them for the rest of their 24-hour window, because
`exposeCoverForGate` returns before the gate copy is sent. It was latent only behind the flag
this branch exists to ship. The rule is now stated where the reader will look for it: pass the
answer only when something that tells the parent what to do provably reached them.

Two coverage gaps behind it, each of which had let a mutation pass the entire suite: the
single `lastFollowResult` write the whole fix rests on had no repository test, because the
action-service harness re-implements that write in its own fake; and `handleUnavailable`'s
requirement to record NO answer was covered by a test that hand-built the resulting state
instead of driving the code that produces it. Inverting that invariant would have wedged every
parent whose live check was unavailable, and it was green.

The release action also refused too little. Its own stated reason was that freeing a
delivery-bearing attempt lets the parent's next message send a second guide — and that hazard
survives one state transition the guard did not cover, because `handleFollower` moves an
attempt back to `needs_review` when the durable delivery fails to start.

### Test and tooling hygiene

- `guideCoverMigrationContract.test.ts` wrote fixed UUIDs with no cleanup, so against a
  persistent contract database it passed exactly once and then failed forever on duplicate
  keys — which reads like a schema regression and is not one. Verified fixed by running it
  twice.
- The Task 5 cancel behaviour was covered only by a test that grepped its own source file
  for two strings, and that silently skipped without a database. Replaced with behavioural
  tests, plus four for `settleAttemptForConversation`, which had none.
- One assertion was proven vacuous by mutation (`coverRates.accepted.pct` cannot fail,
  because `guardedRate` clamps) and removed rather than left reading like a second guard.
- Three fail-closed rollout cases pinned `percent` at the helper default of 0, so they
  would have passed with the guard under test deleted.
- `guideAccessMetrics.record` takes `unknown`, so a whole stage was renamed underneath its
  call sites with no compiler error. Added a typed entry point.
- The E2E fixture had no handler for the new metrics endpoint, so every visual artifact
  captured the panel's error state.
- Nothing at the API boundary asserted that cover shares reach a client at all — which is
  precisely how the discarded-SQL bug survived 53 green backend tests. Added.
- The **mobile** visual artifact was clipped 510px short, ending mid-blurb with the cover
  panel's heading and none of its numbers. `fullPage: true` measures the document height
  once, and the panel resolves on its own later query, so its content landed below the
  measured height. The capture now waits for one of the panel's four terminal states. This
  file already documents the same failure for animations, in the same words: a screenshot
  that misrepresents the page is worse than no screenshot, because it gets believed.

## Privacy

Cover measurement is aggregate-only by schema constraint, not by convention. Every
payload is validated by a `.strict()` Zod schema over a closed stage/outcome
vocabulary, and executed tests confirm `senderId`, `username`, `token`, `copy`, `url`,
`rawError` and `resourceTitle` are all rejected with no event written.

The review DTO carries the unit's `origin` — an enum, not a URL. `dmThreads.routes.ts`
still never selects `textSnapshot`, `mediaUrlSnapshot`, `contentFingerprint`,
`providerMessageId` or `errorTraceId` into the DTO, and that select is asserted as an
exact whitelist rather than a partial match, so widening it fails a test. The review
card asserts nothing URL-shaped reaches the DOM.

## Visual QA

`docs/qa/artifacts/2026-08-16-maison-editorial/{desktop,mobile}/funnels.png` refreshed
in both viewports — the convention on this repo is that a commit updates the artifacts
for surfaces it changes. The cover panel renders with a section separator below the
drop-off table, showing 17.8% of deliveries carrying a cover and 94% accepted, which is
the fixture's arithmetic computed by the server-side rate helper.

Nine other artifacts also changed on a full E2E run and were reverted: they belong to a
dated historical report and nothing on this branch touches those surfaces. Worth
flagging for a human — `visual-qa.spec.ts:17` hard-codes the dated artifact directory,
so any run rewrites a previous report's evidence.

## Known gaps

**No UI for the attempt release action.** The runbook gives the query that finds a stuck
attempt and the curl that clears it, which is enough to run a pilot. A screen for it is
worth deciding on rather than assuming.

**The orphaned-cover storage cleanup worker ships ON**, with no feature flag of its own —
only `WORKERS_ENABLED`, which is restart-only. Its path allowlist is an exact
`guide-cover/<uuid>/<uuid>/<sha256>/(dm|generic).png` match and it removes single paths
with no prefix listing, so the blast radius is contained, but a Storage-deleting worker
without a dedicated switch is inconsistent with the rest of this rollout's discipline. Now
documented in `.env.example`.

**One migration revokes inconsistently.** `20260822010000` runs
`REVOKE ALL ... FROM "anon", "authenticated"` unguarded, while its sibling
`20260822020000` wraps the identical statements in an `IF EXISTS (SELECT 1 FROM pg_roles)`
check. Both roles exist on Supabase and in the contract container, so production is
unaffected; a Postgres without them would abort. **Deliberately not fixed**: the migration
has already been applied in review environments, and editing it would change its checksum
and break `prisma migrate deploy` for anyone who applied it. Pick one form in the next
migration instead.

**`guideFollowGateV2Rollout.ts` dereferences `env` at module scope** to build its
allowlists — the pattern its sibling `guideCoverDeliveryRollout.ts` documents as wrong,
because it breaks every unrelated test that mocks `../config/env.js` without the parser
export. It survives only because three handler test files mock it. Behaviour is unaffected
(`env` is frozen at boot); it is a latent test footgun.

**`resources.routes.ts` DELETE will be blocked** by
`guide_access_attempt_conversation_id_fkey ON DELETE RESTRICT` once any attempt exists for
a resource's conversations. The release action expires an attempt but does not delete it.

**A guide postback without a provider `mid` is dropped** before `routeGuideAction`
(`postbackHandler.ts:14-19`).

**Rollout thresholds are unset.** `docs/guide-delivery-operations.md` describes stop,
inspect, reconcile and rollback procedures but names no numeric abort thresholds for a
controlled run. Those are a human decision.

**Parent-facing copy is partly reviewed.** All of it was agent-written. The owner
reviewed it on 2026-08-23 and made one change: the text-mode follow confirmation now asks
for `DONE` rather than `YES`, matching the gate copy already live on the original path,
because reels and pinned comments already tell people to reply DONE. The opening keeps
`YES` because it answers "Want me to send it here?" rather than "have you followed?".
Neither word is required — the router accepts any genuine reply. The spec's earlier
blanket `YES` was updated rather than left to contradict the code. The remaining strings
(the unavailable line, the follow-lag wording, the card titles, and the three button
labels) have not been changed.

**No attempt sweeper.** An attempt stuck in `delivering` is released lazily by the
parent's next inbound message; `markExpired` has zero production callers (verified by
grep). The cost of a miss is bounded — the conversation self-heals on the next message
— but there is no background job, so a parent who never messages again stays blocked
until the window lapses.

## Final Status

**READY FOR CONTROLLED ROLLOUT**

Every automated pre-production gate passes: 3378 backend tests with zero skips against
a disposable database, 940 web tests, 120 E2E, both typechecks, both builds, lint, the
bypass detector, and a full migration deploy onto a pristine database.

That verdict is only meaningful because of what the reviews found. Six Critical defects
reached this branch. Five were in the same place — **at a boundary the tests mocked** — and
the sixth was created by the fix for one of them, which is its own lesson: a correctness fix
applied uniformly across five call sites was right at two of them and harmful at three. The SQL was mocked, so the reader was never wired to the writer. The two cover
recorders were mocked, so their vocabularies were never reconciled. The API response shape
was mocked, so its absence was never handled. Everything inside those mocks was correct.
That is the pattern to watch for in the next feature, not just the eleven instances fixed
here.

This verdict means only that the local build is ready to be *considered* for a
controlled cohort. It is **not** `CONTROLLED PATH STABLE`: no Meta cohort has been
authorized or run, so there is no evidence at all about real delivery behaviour, and
the capability spike's own live-run task remains unexecuted. It is **not**
`LEGACY REMOVAL AUTHORIZED`.

Two things a human must still decide before Task 8 begins: the numeric abort thresholds
for the controlled run, and whether the attempt release action needs a screen before the
pilot rather than a curl. Parent-facing copy was reviewed on 2026-08-23 and the one change
the owner asked for is in.

The capability spike's own Task 5 also remains unexecuted. It requires explicit owner
authorization, a controlled recipient, fresh controlled comment IDs, and an approved test
window, and it sends real messages from the real account. Nothing in this report
substitutes for it, and `GUIDE_RICH_GATE_ENABLED` stays false until it runs.
