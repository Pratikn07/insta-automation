# Maison Editorial Production Readiness Design

## Context

The Maison Editorial branch establishes the right visual and information-design
direction: Home interprets instead of only reporting, the navigation groups one
distinct job per destination, and the light paper system gives Tiny Soho a more
specific identity than the earlier generic dark SaaS shell.

The production-readiness review found that several implementation details do not
yet carry the product claims the new interface makes. The risks are behavioral,
not merely visual:

- a seven-day interpretation can be generated from incomplete or unequal
  calendar coverage;
- an invalid guide step can be skipped while the conversation is recorded as
  completely delivered;
- unavailable Home data can render as an all-clear;
- DM Recovery describes a manual outbound DM even though the worker
  automatically posts a public comment;
- the generic client timeout can report failure while an uncancelled mutation
  later succeeds;
- browser coverage, chart contrast, semantic redirects, mobile titles, and
  product records did not move with the new architecture.

This design makes those contracts explicit before further implementation. The
branch remains blocked from production until every release gate in this document
passes.

## Approved Product Decisions

The following decisions were approved on 2026-08-16 and are binding for the
implementation plans:

1. DM Recovery remains an automatic public-comment recovery system. It is not a
   manual release queue and it does not send an outbound recovery DM.
2. This remediation covers branch release blockers and their integration QA.
   The inherited Express async-error risk and dependency advisories belong to a
   linked production-hardening effort.
3. Guide delivery is fail-closed, durable, resumable, and complete only when
   every required provider call is confirmed.
4. Week-over-week interpretation is withheld unless both seven-day calendar
   windows are complete, settled, and comparable.
5. Home degrades section by section. It may say all clear only when every
   required attention source succeeded.
6. A timed-out mutation has an unknown outcome. It is not automatically retried
   or described as a confirmed failure.
7. The work is delivered as reviewable vertical slices with one shared release
   gate.

## Scope

### In scope

- follower-growth comparison eligibility and qualification;
- dynamic funnel-loss ranking;
- Home loading, incomplete, attention, and all-clear states;
- guide authoring limits, whole-guide preflight, durable unit delivery,
  reconciliation, review, and completion;
- truthful DM Recovery terminology and state presentation;
- separate read and mutation transport contracts;
- chart contrast on the paper theme;
- semantic People redirects and URL-addressable Conversations lenses;
- one source of truth for route labels and mobile titles;
- route-correct Playwright coverage, deterministic clock tests, documentation,
  rollout, and QA evidence.

### Out of scope

- changing DM Recovery from automatic to manual approval;
- merging DM Recovery with Historical Recovery;
- splitting, truncating, normalizing, or rewriting creator-authored guide text;
- broad visual redesign beyond correcting illegible or inconsistent elements;
- general Express 4 async error containment;
- upgrading dependencies solely to clear inherited audit findings;
- a staging environment project;
- deploying, merging, or enabling production workers as part of plan creation.

## Delivery Structure

One design governs four independently reviewable implementation slices:

1. **Measurement truth** — comparable calendar windows, dynamic loss ranking,
   and explicit Home evidence states.
2. **Guide-delivery integrity** — complete preflight, durable send units, safe
   resume, uncertain outcomes, and confirmed completion.
3. **Recovery and client-operation truth** — accurate public-comment language,
   automation states, read cancellation, and idempotent mutation reconciliation.
4. **Interface and release QA** — chart tokens, semantic routing, shared route
   metadata, browser migration, documentation, and rollout gates.

Each slice must be independently testable and reviewable. Production remains
blocked until the combined release gate passes. Changes from separate slices
must not be collapsed into one commit merely because they share a release date.

## 1. Measurement Truth

### 1.1 Comparable follower windows

“Today’s read” compares the latest seven fully settled Pacific calendar days
with the seven immediately before them. Eligibility is based on calendar
coverage, not array length or point count.

Both windows must contain:

- exactly seven distinct expected Pacific dates;
- one measured single-day point for each date;
- no `stale`, `pending`, `no_snapshot`, or `no_prior_day` basis;
- no provisional point;
- no `multi_day_span` catch-up point;
- no duplicate date.

A multi-day point remains valid for descriptive charts and rate calculations
that divide by covered days, but it cannot support a sentence comparing one
named week with another. The newest provisional days remain visible in the
chart with their qualification; they are not silently removed from the chart
and are not promoted into the comparative read.

The comparison layer returns a discriminated result rather than overloading
`null`:

```ts
type ComparableWeekResult =
  | {
      status: "ready";
      current: ComparableWeek;
      prior: ComparableWeek;
      changePct: number;
      trend: "faster" | "slower" | "steady";
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
```

`ComparableWeek` carries its actual inclusive `from` and `to` dates, seven day
records, US total, and covered-day count. The UI derives its qualification from
those fields. It must not hardcode “Last 7 days against the 7 before.”

Only a `ready` result may produce a comparative interpretation. An
`insufficient` result explains why the sentence is withheld. Raw descriptive
counts may still appear under “Show the evidence,” with their own basis and
coverage.

### 1.2 Funnel loss ranking

The Home composer must not relabel a funnel definition’s preferred headline as
the largest loss. It calculates candidate losses from the selected funnel
result at render/composition time.

A candidate stage is rankable only when:

- the denominator and numerator are measured non-negative counts;
- the stage represents a meaningful transition for that funnel;
- the stage is not marked bypassable or otherwise non-comparable;
- loss (`denominator - numerator`) is greater than zero.

Rank by absolute measured loss because the UI says “ranked by what is lost.” If
no stage qualifies, omit the largest-loss clause. The actual funnel window is
carried into the evidence label. The composer keeps follower and funnel clauses
separate because they describe different cohorts and windows.

### 1.3 Home evidence state

Home tracks section readiness independently and derives its overall state from
the three required page sources: follower flow, operational stats, and the guide
funnel. Operational stats and the guide funnel are specifically required for an
all-clear attention claim; follower flow and the guide funnel are required for a
complete interpreted read. Home derives this state explicitly:

```ts
type HomeAttentionState =
  | { status: "checking" }
  | { status: "ready_with_attention"; items: AttentionItem[] }
  | { status: "ready_clear"; items: [] }
  | { status: "incomplete"; failedSources: HomeSource[]; items: AttentionItem[] };
```

The behavior is exact:

- `checking`: show checking language and no all-clear claim;
- `ready_with_attention`: rank only verified items and show the best verified
  next move;
- `ready_clear`: and only this state may say nothing is waiting or failing; it
  requires successful operational stats and funnel responses, while the page
  still reports `incomplete` if follower flow failed;
- `incomplete`: keep reliable sections and verified items visible, label failed
  sections, and state that the overall check is incomplete.

One successful source must not hide another source’s failure. If a follower read
can be composed while the funnel request failed, the follower clause may remain,
but the evidence panel and overall status disclose that funnel evidence is
unavailable. Retry actions target the failed source rather than discarding
successful data.

## 2. Guide-Delivery Integrity

This section adopts the durable architecture in
`2026-08-09-guide-message-limits-and-resumable-delivery-design.md` and corrects
one stale contract in that document: the older design counts JavaScript UTF-16
code units, while current production evidence shows that messages above 1,000
UTF-8 bytes but below 1,000 Unicode code points are accepted. This
design therefore makes 1,000 Unicode code points, measured by
`[...text].length`, the shared policy. The older design and implementation plan
must be updated before execution so they do not reintroduce code-unit counting.

### 2.1 Authoring and API policy

- Text bodies and media captions may contain at most 1,000 Unicode code points.
- Exactly 1,000 is valid; 1,001 is invalid.
- The editor shows a live count, warning treatment near the limit, and an error
  above the limit.
- An invalid local draft remains visible and editable but cannot be saved.
- Create and update APIs independently enforce the same shared policy and
  return a stable error containing `error`, `limit`, and `actual`, never the
  submitted private text.
- Active and inactive legacy guides are audited without printing content.
- The author, not the system, decides how an invalid message is shortened or
  divided.

### 2.2 Whole-guide preflight

Before any Meta call, compile the authored sequence into the exact ordered
provider units:

- Text step: one text unit.
- Image step: one image unit and, when present, one caption text unit.
- PDF step: one file unit and, when present, one caption text unit.

Validate the complete plan. Every text unit must satisfy the shared limit and
every media unit must have a usable URL. If any unit is invalid, send zero units,
leave the conversation incomplete, record only safe configuration metadata, and
surface the guide and affected conversation as needing attention. Skipping the
invalid unit and continuing is forbidden.

An invalid trigger is persisted as a failed delivery with a stable
`invalid_plan` failure code and safe unit position/type/length metadata, but no
sendable unit is claimed. Correcting the guide does not mutate that historical
attempt. The owner starts an explicit redelivery with a new trigger identity so
the corrected snapshot remains distinct and auditable.

### 2.3 Durable delivery boundary

Persist one delivery per `(trigger_kind, trigger_id)` and one immutable unit per
actual provider call. The trigger key collapses webhook or job replay while
permitting a later intentional redelivery with a different trigger.

The delivery snapshots the authored content used for this attempt so later
edits affect future deliveries, not an in-progress delivery. Snapshotted text
and media URLs are protected application data; they never enter application
logs or event payloads.

Delivery states are `planned`, `sending`, `completed`, `failed`,
`needs_review`, and `cancelled`. Unit states are `pending`, `sending`, `sent`,
`retryable`, `failed`, `uncertain`, and `cancelled`. A concrete schema may use
enums with equivalent names, but it may not collapse `retryable`, `failed`, and
`uncertain` into one ambiguous state.

### 2.4 Sending, retry, and reconciliation

1. Atomically get or create the delivery by trigger key.
2. Compile, validate, and persist the complete snapshot.
3. Claim the delivery with a bounded lease.
4. Claim one pending or retryable unit before calling Meta.
5. Call Meta outside the database transaction.
6. Store the provider message ID and mark `sent` after confirmed acceptance.
7. Classify a definitive rejection as retryable or permanent and stop the
   sequence.
8. Classify timeout, connection loss, missing acceptance identity, or stale
   `sending` lease as `uncertain`; never automatically retry it.
9. Resume from the first unit that is known not to have been sent. Never resend
   a confirmed unit.

Only a definite transient rejection may retry, with bounded attempts and
backoff while the messaging window remains open. A permanent failure requires a
new corrected delivery. An uncertain outcome requires owner review because the
external message may already exist.

### 2.5 Completion and owner review

Conversation completion, thread resolution, follow-up scheduling, and the
`sequence_completed` event run only after every required unit is confirmed
`sent`. Finalization is idempotent and recoverable: if all units are sent but
the process stops before bookkeeping completes, a reconciliation tick performs
the remaining bookkeeping without another Meta call.

Conversations show confirmed units, the unit requiring review, and unsent
remainder. For an uncertain unit the owner may:

- mark it already delivered after checking Instagram, then resume;
- explicitly retry while acknowledging duplicate risk;
- cancel without marking the conversation complete.

The current legacy `sequenceSender` is removed only after every production call
path uses this service and search confirms no bypass remains.

## 3. Recovery and Client-Operation Truth

### 3.1 DM Recovery product contract

DM Recovery is a prospective, automatic public-comment recovery system. When
the configured wait has passed and there is no confirmed read or engagement,
the worker may post one public reply to the original Instagram comment after
its policy, experiment, cooldown, health, circuit-breaker, and rate-cap checks.

The destination’s introductory copy must state that behavior plainly. It must
not say:

- nothing sends on its own;
- an operator releases a reminder;
- the recovery action is an outbound DM.

The UI states are:

| UI state | Meaning |
| --- | --- |
| Scheduled | Waiting for the eligibility time. |
| Due | Eligible and waiting for worker capacity or final safety checks. |
| Sending | Claimed for a public-comment attempt. |
| Sent publicly | Meta confirmed the public reply and returned an identity. |
| Suppressed | Policy or evidence prevented the send, with a safe reason. |
| Control | Intentionally held out from the experiment. |
| Failed | Meta definitively rejected the public reply. |
| Outcome uncertain | The reply may have posted; no automatic retry is permitted. |

The creator may cancel a record only before a send is claimed. Cancellation
copy must state that it cannot remove a comment already posted. The page exposes
high-level worker health, caps, and circuit state without presenting internal
implementation noise as user decisions.

DM Recovery and Historical Recovery remain separate destinations. The former
is a bounded per-journey automatic worker; the latter can approve public contact
across a large historical campaign. They may be adjacent in the rail but never
peer tabs in one habitual action surface.

### 3.2 Separate read and mutation clients

The generic timeout wrapper is replaced by explicit read and mutation
contracts.

**Reads** accept the caller’s abort signal, compose it with an actual deadline,
and abort the underlying fetch when either fires. Reads may retry only according
to the query’s documented safe retry policy. A timeout must not leave a first
database-heavy request running while a retry starts another one from the same
client.

**Mutations** never retry automatically. A client deadline produces
`outcome_unknown`, not a confirmed failure. The UI disables an immediate repeat,
shows “Still confirming,” and invokes the operation’s reconciliation rule.

Every mutation route is inventoried and assigned one of these contracts:

1. **Naturally idempotent update/delete** — refetch canonical state and compare
   the intended result.
2. **Create or external action with a business key** — reuse the existing unique
   key to retrieve the result.
3. **Non-idempotent create/send/approve** — accept a client-generated operation
   key, persist or bind it to the result, and reuse the same key for an explicit
   retry.

The transport helper supplies primitives; it does not invent one generic
reconciliation rule for every mutation. Only after canonical state proves that
the operation did not happen may the UI offer a safe retry.

## 4. Interface Consistency and Release QA

### 4.1 Paper-theme chart tokens

Chart marks use named design tokens documented in `DESIGN.md`, not Tailwind
colors selected for the retired dark surface. Every meaningful line, bar,
boundary, and state marker must reach at least 3:1 contrast against both
`ground` and `raised` paper surfaces.

Rolling means and provisional outlines use explicit ink-derived colors rather
than translucent white. Color is not the only distinction for provisional or
uncertain data: dash or pattern treatment remains visible without color.
Automated contrast tests include SVG attributes and computed opacity; visual QA
checks the rendered chart at desktop and mobile sizes.

### 4.2 Semantic navigation

The active Conversations lens is URL-addressable. `/users` redirects to
`/conversations?lens=people`, and Conversations initializes from and writes to
that parameter. Unknown lenses fall back to the default inbox lens without
breaking navigation.

One route metadata module owns destination path, navigation label, mobile title,
and group membership. Sidebar and mobile header consume that source. Dynamic
sequence-editor titles remain an explicit route matcher. A route contract test
asserts every navigable destination has a mobile title.

### 4.3 Browser coverage

The Playwright harness mounts the real route structure needed by each journey.
DM Recovery tests navigate to `/dm-recovery`; they do not click a removed lens
inside Conversations. Tests cover automatic-public-comment copy and Scheduled,
Due, Sent, Failed, Suppressed, Control, and Outcome uncertain states on desktop
and mobile.

Clock-controlled tests establish the app/auth state before freezing time, or
install a deterministic clock before navigation without preventing hydration.
They must pass repeatedly in both projects; a desktop-only pass in the full
suite is not sufficient evidence.

### 4.4 Documentation authority

The implementation updates, in the same slice that changes behavior:

- `PRODUCT.md` route inventory and recovery terminology;
- `DESIGN.md` chart and semantic-state tokens;
- the older guide-delivery design and plan’s stale counting rule;
- comments that describe Today’s Read surface or recovery behavior;
- test-count and route-count records when those counts are retained.

Components do not carry speculative navigation roadmaps. `PRODUCT.md` owns
destination names and behavior; `DESIGN.md` owns visual expression; route
metadata implements both.

## Testing Strategy

### Measurement contracts

- five measured current days cannot produce a seven-day sentence;
- a multi-day catch-up point cannot produce a named week comparison;
- provisional points withhold comparison;
- two exact, contiguous, settled seven-day windows produce dated evidence;
- dynamic funnel ranking chooses the actual greatest eligible absolute loss;
- bypassable or unmeasured stages cannot win;
- Home never renders all-clear during loading or partial failure;
- a successful follower source plus failed funnel source remains incomplete.

### Delivery contracts

- exact 1,000-code-point text is accepted; 1,001 is rejected;
- astral Unicode and production-shaped over-1,000-byte messages are counted by
  code point rather than byte or UTF-16 unit;
- one invalid later unit prevents every earlier provider call;
- replay creates one delivery snapshot;
- confirmed units are not resent;
- a definitive transient failure resumes at the failed unit;
- timeout and stale lease become uncertain and never auto-retry;
- completion and follow-up occur exactly once and only after all units are sent;
- snapshots and logs satisfy the privacy contract;
- database concurrency contracts pass against disposable PostgreSQL.

### Recovery and transport contracts

- page copy names the action as automatic and public;
- cancellation cannot target sending, sent, or uncertain rows;
- ambiguous public-send outcome remains uncertain;
- read deadline aborts the underlying fetch;
- read retry does not overlap an uncancelled prior request;
- mutation timeout produces unknown outcome and no automatic replay;
- each mutation inventory entry has a reconciliation or idempotency test.

### Interface and integration contracts

- chart marks meet 3:1 on both paper surfaces, including opacity blending;
- `/users` lands on the People lens and the URL follows lens changes;
- every rail route produces the correct mobile title;
- all recovery journeys pass in desktop and mobile Playwright projects;
- clock tests pass repeatedly;
- backend tests, frontend tests, builds, lint, and complete Playwright pass with
  zero failures.

## Rollout

There is no staging environment, so rollout is additive, flag-controlled, and
fail-closed.

1. Land and verify measurement/UI-only slices without changing worker behavior.
2. Apply the additive delivery schema with the new delivery worker disabled.
3. Run the read-only active-guide audit. An author corrects every invalid active
   guide; scripts do not rewrite content.
4. Deploy delivery persistence and review UI while the old sender remains the
   only active sender.
5. Enable the new path for a controlled cohort or low batch cap. A trigger must
   be owned by exactly one sender; dual sending is forbidden.
6. Reconcile provider IDs, unit states, uncertain outcomes, completion events,
   follow-ups, and thread resolution before expanding.
7. Expand gradually, retain the kill switch, and stop on unexplained uncertain
   growth, duplicate evidence, completion mismatch, or worker health breach.
8. Remove the legacy sender only after the controlled path is stable and every
   production call site has migrated.

## Shared Release Gate

Production remains blocked until all of the following are recorded in a dated
QA report:

- focused tests for every vertical slice pass;
- complete backend and frontend unit suites pass;
- backend TypeScript build, frontend build, and frontend lint pass;
- complete Playwright suite passes on desktop and mobile with zero failures;
- delivery schema and concurrency contracts pass against disposable PostgreSQL;
- route, title, redirect, timeout, reconciliation, and privacy contracts pass;
- automated and manual chart contrast checks include SVG marks;
- active-guide audit reports no invalid active guide;
- controlled delivery rollout has no unexplained duplicate, uncertain, or
  completion mismatch;
- product and design records agree with code;
- the worktree is clean and exact command outputs are attached to the QA report.

Inherited dependency advisories and Express async-error containment are not
silently called clean. The QA report records their accepted baseline and links
the separate production-hardening plan. This remediation may add no new
advisory.

## Success Criteria

- No interpretive sentence claims a cohort or period the evidence does not
  support.
- Home never converts loading or failure into reassurance.
- No invalid guide sends partially.
- No conversation is completed until its full guide is confirmed.
- No ambiguous external outcome is retried automatically.
- DM Recovery accurately states that it may automatically post publicly.
- No client timeout encourages a duplicate mutation.
- The paper interface remains legible in text and data graphics.
- Every navigation destination preserves its meaning on desktop, mobile, and
  legacy URLs.
- The complete release gate passes before production activation.
