# Guide Cover Parent Delivery QA — 2026-08-23

## Commit Under Test

`79b34a3` on `codex/follower-button-flow`, 57 commits ahead of `main`.

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

The fence is `eligibleCover` (`src/services/guideDeliveryService.ts`), consulted once
before the plan is compiled. It governs cover inclusion only: never follower
authorization, never which service owns the send. Verified by grep — the selector has
exactly one consumer and `guideDeliveryOwner` never imports it.

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
- `GUIDE_DELIVERY_ENABLED=false` stops the retry worker (`src/server.ts:196`) and the
  legacy-vs-ledger routing, **at process restart only**, and does *not* stop a
  strict-gate delivery. Setting it false while V2 is on is worse than either state
  alone: deliveries still start with no worker to retry them.
- `GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT` cannot be lowered from the console at all.
  `resolvePercent` discards a stored value for any key `pageMayEnable` forbids, and the
  registry now declares `pageMayStop: false` to match. The stop is the boolean.

## Automated verification

All executed against commit `79b34a3` on 2026-08-23.

| Gate | Result |
| --- | --- |
| Backend suite | **3336 passed / 215 files / 0 skipped** |
| Web suite | **937 passed / 73 files** |
| Playwright E2E | **120 passed** (desktop + mobile) |
| Backend typecheck | clean |
| Web typecheck | clean |
| Backend build (`npm run build`) | clean; compiled SQL verified to contain the cover vocabulary |
| Web production build | clean; bundle grepped for app code, not trusted on exit status alone |
| `eslint .` (web) | clean |
| `scripts/check-guide-delivery-bypasses.mjs` | `guide_delivery_bypass_check_passed` |
| `prisma migrate deploy` on a pristine database | all migrations applied, in order |

One flake observed: `src/api/aiDrafts.routes.test.ts > "does not let an audit write
failure create an unhandled owner retry"` failed once while three full suite runs
were executing concurrently on this machine. It passes in isolation (53/53) and in a
clean full run. The test mocks Prisma entirely, so it is not database contention.
Recorded rather than buried; not reproduced.

### Verification the unit tests could not do

The metrics reader's tests all mock `$queryRawUnsafe`. A mocked query cannot tell a
valid SQL string from a correct one, so the aggregate was additionally run against
real PostgreSQL with 121 seeded rows. That found a **Critical** defect (below) and,
after the fix, produced exactly the shares the mocked tests assert: 20% included, 85%
accepted, 4% duplicate-suppressed, 6% mispaired, with a malformed historical outcome
correctly dropped.

## Defects found and fixed during this pass

Each was found by an independent adversarial review or by execution, not by reading.

**Critical — cover metrics were silently discarded.** `AGGREGATE_SQL` carried a second
hand-written copy of the stage/outcome vocabulary and omitted the `cover` stage. Cover
events were written, validated against the closed vocabulary, stored, and then dropped
by the reader. Every cover count would have read zero through the entire rollout,
including the exposure outcomes from Task 4. The predicate is now generated from
`GUIDE_ACCESS_OUTCOMES`. Fixed in `78a82fe`; three tests verified to fail against the
exact original bug by re-introducing it.

**Critical — cancelling a review did not release the parent.** The cancel path moved
the access attempt `delivering → needs_review`, but `needs_review` is also an ACTIVE
state, and the only escape from it requires `lastFollowResult: "unknown"` — a value
`guide_access_attempt_state_follow_result_check` forbids on any attempt that reached
`delivering`. The parent stayed blocked for the rest of the messaging window, with no
surface showing it: nothing in the API or the metrics reads `guideAccessAttempt`. Now
terminal. Fixed in `f0328cd`.

**Critical — a stale completion could settle the wrong attempt.**
`settleAttemptForConversation` identified its attempt by conversation alone, so a
callback arriving after its own attempt was force-expired and replaced would close the
replacement — releasing the conversation while a second guide was still in flight. A
delivery copies its attempt's `messagingWindowExpiresAt` verbatim into
`sendWindowExpiresAt`, so passing it back is an exact identity handle. Mismatches are
refused and logged, never guessed. Fixed in `f0328cd`.

**Important — the cover/guide integrity check was unreachable.** The
resource-mismatch check sat behind the rollout fence, so while the flag is off — every
deployment that exists today — a snapshot paired with the wrong guide was never
detected. Integrity now precedes policy, with its own `omitted_mismatch` outcome so a
pairing bug cannot hide inside a routine rollout omission. Fixed in `628a360`.

**Important — a safety field that lied.** `GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT`
declared `pageMayStop: true`, but `resolvePercent` discards any stored value for a key
`pageMayEnable` forbids, so the console could not perform that stop. Now asserted
across the whole registry rather than per key. Fixed in `628a360`.

**Test hygiene — a contract suite that could only pass once.**
`guideCoverMigrationContract.test.ts` wrote fixed UUIDs with no cleanup, so against a
persistent contract database it passed once and then failed forever on duplicate keys,
which reads like a schema regression and is not one. Now cleans up; verified by running
it twice. Fixed in `628a360`.

**Browser QA — the panel was only ever captured failing.** The E2E fixture had no
handler for the new metrics endpoint, so every visual artifact recorded the cover
panel's error state. Stubbed in `79b34a3`. The useful half of that finding is that the
page rendered correctly around the failure, which is live proof the cover query cannot
take the cohort funnel down; that behaviour is now asserted in a unit test rather than
observed by accident in a screenshot.

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

**The `gate` and `recheck` metric stages have no writers.** Both are declared in the
vocabulary and admitted by the SQL, and neither is ever recorded: `recheck` outcomes
are folded into `fresh_check`, so the funnel cannot distinguish "failed the first
follow check" from "still not following after claiming to have followed" — the most
decision-relevant number in a follow gate. This is an unfinished item from
`2026-08-22-strict-follower-gate-v2` (its line 225), not from the parent-delivery plan.
Wiring it means threading a distinction through the gate's core path, so it is reported
rather than done. No surface displays those stages today, so no operator is currently
misled by their zeroes.

**Rollout thresholds are unset.** `docs/guide-delivery-operations.md` describes stop,
inspect, reconcile and rollback procedures but names no numeric abort thresholds for a
controlled run. Those are a human decision.

**Parent-facing copy has not had a human review.** The gate and cover copy in this
branch was written by an agent and goes to real parents.

**No attempt sweeper.** An attempt stuck in `delivering` is released lazily by the
parent's next inbound message; `markExpired` has zero production callers (verified by
grep). The cost of a miss is bounded — the conversation self-heals on the next message
— but there is no background job, so a parent who never messages again stays blocked
until the window lapses.

## Final Status

**READY FOR CONTROLLED ROLLOUT**

Every automated pre-production gate passes: 3336 backend tests with zero skips against
a disposable database, 937 web tests, 120 E2E, both typechecks, both builds, lint, the
bypass detector, and a full migration deploy onto a pristine database.

This verdict means only that the local build is ready to be *considered* for a
controlled cohort. It is **not** `CONTROLLED PATH STABLE`: no Meta cohort has been
authorized or run, so there is no evidence at all about real delivery behaviour, and
the capability spike's own live-run task remains unexecuted. It is **not**
`LEGACY REMOVAL AUTHORIZED`.

Two things a human must decide before Task 8 begins: the numeric abort thresholds for
the controlled run, and whether the parent-facing copy is acceptable to send. Both are
named above rather than assumed.
