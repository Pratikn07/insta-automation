# Guide delivery operations

The durable guide-delivery path replaces a fire-and-forget sequence sender with a
ledger: every guide send is planned into units, each unit's outcome is recorded,
and an outcome nobody can be sure about becomes an owner decision rather than an
automatic retry.

This document is the procedure for turning that path on. **Nothing here may be
executed until the production-readiness QA report records `READY FOR CONTROLLED
ROLLOUT`.** Writing this runbook is not authorization to run it.

## What is actually deployed while this is disabled

The ledger code, its migration, and its owner-review UI ship together, inert. The
worker is started from `src/server.ts:192` only when `GUIDE_DELIVERY_ENABLED` is
true, so with the flag off no scheduler loop exists in the process at all.

Ownership of a single trigger is decided once, in `messageHandler`, by
`guideDeliveryOwner` (`src/services/guideDeliveryRollout.ts`). It returns
`"legacy"` or `"ledger"` and the handler switches on that one value — the two
paths are mutually exclusive, so a trigger cannot be sent twice by both. The
function fails closed: a non-object input, a disabled flag, a blank
`igUserId`/`triggerId`, a cohort set whose `has` is not callable or throws, a
non-boolean membership answer, or an out-of-range percentage all return
`"legacy"`.

## Safe initial configuration

Deploy with exactly these values. They are also the schema defaults
(`src/config/env.ts:149–154`), so an unset variable is safe, but set them
explicitly so the intent is visible in the environment.

```text
GUIDE_DELIVERY_ENABLED=false
GUIDE_DELIVERY_ROLLOUT_PERCENT=0
GUIDE_DELIVERY_COHORT_IG_USER_IDS=
```

`GUIDE_DELIVERY_ENABLED` is parsed by `booleanFlag`, not `z.coerce.boolean` — the
string `false` really is false. Confirm the parsed value rather than the raw
string when auditing.

The remaining variables tune the worker and need no change for a controlled run:
`GUIDE_DELIVERY_BATCH_SIZE` (10), `GUIDE_DELIVERY_LEASE_MS` (300000),
`GUIDE_DELIVERY_MAX_ATTEMPTS` (3), `GUIDE_DELIVERY_RETRY_BASE_MS` (60000),
`GUIDE_DELIVERY_WORKER_INTERVAL_MS` (60000).

`follow_recovery` exists in the planner's `GuideDeliveryTriggerKind` union but is
not wired to any handler. It remains a separate future trigger and is not part of
this rollout.

## Step 1 — Read-only content audit

Guide text is limited to 1,000 **Unicode code points**, counted as
`[...value].length` by `countInstagramCodePoints`
(`shared/guideMessagePolicy.ts`). This is not a UTF-16 code-unit count: an emoji
or an astral character counts once, not twice.

Run the audit against the target database before deploying:

```bash
npm run audit:guide-message-lengths
```

It reads `resourceMessage` rows and never writes. For each over-limit message it
prints `resourceId`, the resource **name**, `messageId`, `order`, `type`,
`codePoints`, `overBy`, and `activeKeywords`. It prints identity, lengths, and the
guide's name — it does **not** print message bodies. Treat the resource name as
the only human-readable field in that output.

Exit code 1 means at least one over-limit message belongs to a resource with an
active keyword. That is a `NO-GO`.

**Author-only correction rule.** An over-limit message is fixed by its author
rewriting the prose, in the console, into shorter steps. Do not run a SQL update,
do not truncate, and do not add an automatic splitter. The limit exists because
Instagram rejects the send; the remedy is editorial, and only the author knows
which sentence to lose.

## Step 2 — Deploy, migration first

1. Apply `prisma/migrations/20260817010000_add_guide_delivery_ledger` before the
   application starts. It is additive: new tables, enums, and partial indexes. No
   existing column changes meaning.
2. Deploy the application with the disabled values above.
3. Verify no worker is running and behavior is unchanged: a keyword reply still
   arrives through the legacy sender, and no `guide_delivery` row is written.

## Step 3 — Allowlist-only controlled cohort

The percentage stays at 0 for the entire controlled phase. Only the allowlist
opens the ledger path, because a percentage decides by hashing `triggerId` and so
cannot tell you in advance who it will pick.

1. Add exactly one authorized Instagram user ID to
   `GUIDE_DELIVERY_COHORT_IG_USER_IDS`. The value is split on commas and blank
   entries are dropped, so ` 123, , 456 ` yields two IDs.
2. Leave `GUIDE_DELIVERY_ROLLOUT_PERCENT=0`.
3. Set `GUIDE_DELIVERY_ENABLED=true` last.
4. Probe with a non-allowlisted account and confirm it stays on the legacy path.
   Do this by reading its conversation record — not by sending it a test message.

Cohort membership is checked before the percentage, so an allowlisted ID is owned
by the ledger regardless of the hash.

## Step 4 — Cases to verify during the controlled run

**Two text messages.** Two units, positions 0 and 1, both reaching `sent`. The
delivery reaches `completed`.

**Image plus caption.** One authored image message carrying a body compiles into
*two* units at consecutive positions: the media unit first, then a text unit with
the caption, both sharing one `resourceMessageId`
(`guideDeliveryPlanner.ts:99–118`). Expect two units per captioned image, and
expect the caption to arrive as its own Instagram message.

**Definite rejection, then resume.** A permanent provider error marks that unit
`failed` with disposition `permanent`. A whole-plan preflight failure — missing
text, over-limit text, missing media URL — fails the delivery with the stable code
`invalid_plan` before anything is sent. A transient error is retried by the worker
up to `GUIDE_DELIVERY_MAX_ATTEMPTS` with backoff from
`GUIDE_DELIVERY_RETRY_BASE_MS`, and a resumed delivery continues from the first
unsent unit rather than restarting the plan.

**Ambiguous timeout — no automatic retry.** When the provider call cannot be
classified, the unit is marked `uncertain` with failure code
`provider_outcome_uncertain` and the delivery becomes `needs_review`
(`guideDeliveryService.ts:208–223`). The worker does not retry it. This is the
whole point of the ledger: a timeout after dispatch may already have delivered a
message, so the automation stops and asks.

**Closed window.** If the 24-hour messaging window expires with units still
unsent, the delivery is sealed `failed` with failure code
`messaging_window_closed`. Once sealed, both unit actions are rejected by the
server and the review card offers only cancel.

## Step 5 — The three owner actions

All three live in Conversations, on the thread drawer, above the reply draft. They
are served by `src/api/guideDeliveries.routes.ts` and require an authenticated
owner (`owner_auth_required`, 401).

| Action | Route | Accepted when |
| --- | --- | --- |
| Already delivered | `POST /api/guide-deliveries/:deliveryId/units/:unitId/confirm-delivered` | delivery `needs_review` and unit `uncertain` |
| Retry unit | `POST /api/guide-deliveries/:deliveryId/units/:unitId/retry` | same, **and** the send window still open |
| Cancel delivery | `POST /api/guide-deliveries/:deliveryId/cancel` | delivery `needs_review`, or `failed` with `messaging_window_closed` |

**Already delivered** records what Instagram already did. The unit becomes `sent`
with `ownerConfirmedAt` set and its error metadata cleared. If that was the last
unit the delivery finalizes; if the window is still open it resumes; if the window
has closed it is sealed `messaging_window_closed`.

**Retry unit** requires the literal body `{"acknowledgeDuplicateRisk": true}`.
Anything else is rejected with `duplicate_risk_acknowledgement_required` (400).
The acknowledgement is not ceremony: the first attempt may already have arrived,
so a retry can put a second copy on a real person's phone. If the window has
closed the server seals the delivery and rejects with `messaging_window_closed`
(409) rather than sending.

**Cancel delivery** cancels every unit that is not already `sent`. Delivered
messages stay delivered. A delivery already `cancelled` is idempotent; any other
state is rejected with `delivery_state_changed` (409).

Stable error codes and their HTTP statuses: `duplicate_risk_acknowledgement_required`
400, `delivery_not_found` 404, `unit_not_found` 404, `delivery_state_changed` 409,
`messaging_window_closed` 409.

## Safe event fields

Every guide-delivery event payload is built by one of two helpers in
`guideDeliveryRepository.ts`:

- `eventIdentity` — `deliveryId`, `conversationId`, `resourceId`, `triggerKind`,
  `triggerId`.
- `unitEvent` — the above plus `unitId`, `position`, `unitKind`, `attempt`, `at`.

Owner actions add `actor`, `action`, and `unitId` (`guideDeliveryReviewService.ts:136`).

No event, log line, API response, or UI surface carries `textSnapshot`,
`mediaUrlSnapshot`, a provider response body, an access token, or
`errorTraceId`. Provider error metadata is retained on the unit row for
debugging and is deliberately absent from the review DTO. Any new event must use
these helpers rather than spreading a unit or delivery record.

## Rollback

Rollback stops *new* application sends. It never deletes ledger rows.

1. Set `GUIDE_DELIVERY_ENABLED=false` and redeploy. The worker is not started, so
   no unit is claimed or sent, and every subsequent trigger returns to the legacy
   sender.
2. Leave `guide_delivery` and `guide_delivery_unit` rows in place. They are the
   record of what was and was not delivered to real people. A delivery left in
   `needs_review` is unresolved information, not garbage — deleting it destroys
   the only evidence of an ambiguous send.
3. Do not revert the migration. It is additive and inert while disabled.
4. Resolve any outstanding `needs_review` deliveries through the owner actions
   before or after the flag change; those routes do not depend on the worker.

Because the legacy branch is still present, rollback is a flag change, not a code
change. `sequenceSender` and that branch may only be removed after a separate,
named-owner `LEGACY REMOVAL AUTHORIZED` decision that follows a formal
declaration of controlled stability.

## Guide-access incident audit and repair

The access recovery command is read-only by default. It reports aggregate counts,
resource names, open/closed messaging-window counts, and oldest/newest timestamps.
It never prints a parent ID, username, message, token, provider message ID, or
conversation/attempt ID.

Start every repair from a fresh audit:

```bash
npm run audit:guide-access-recovery
```

The three candidate classes are deliberately separate:

- `logically_expired_active_token` is bookkeeping only. Normalizing it changes an
  expired token's status; it does not change an attempt or send anything.
- `counter_constraint_review` is a non-follower attempt stranded by the former
  three-check/two-response database constraint. A guide delivery excludes the row
  because delivery review owns that recovery.
- `swallowed_opening_action` is a captured parent action that arrived after the
  old ten-minute token expired while the full messaging window was still open.
  Replaying it invokes the normal routed-action service and therefore performs a
  fresh Meta follow check; it never bypasses the follower gate.

Every write requires the exact count from the immediately preceding audit and an
actor. A count drift, even by one, aborts before the command opens its write path:

```bash
npm run audit:guide-access-recovery -- \
  --mode normalize-token-status --apply --expected-count <COUNT> --actor <OWNER>

npm run audit:guide-access-recovery -- \
  --mode release-counter-reviews --apply --expected-count <COUNT> --actor <OWNER>
```

Review every counter candidate in Conversations before releasing it. Release is
audited and does not send a guide. It expires the blocked attempt so the parent's
next message can begin a new, fully authorized attempt.

`replay-swallowed-actions` contacts real parents. It requires a second explicit
switch in addition to the exact count and actor, and it only selects candidates
whose messaging window is still open:

```bash
npm run audit:guide-access-recovery -- \
  --mode replay-swallowed-actions --apply --send-instagram \
  --expected-count <COUNT> --actor <OWNER>
```

Do not run that command from generic deployment authorization. First present the
fresh open-window count and resource breakdown to the owner and obtain explicit
authorization to contact those parents. The batch is sequential and stops at the
first uncertain send or `needs_review` outcome; never restart it automatically.
The durable action-event receipt makes an exact rerun idempotent, but an uncertain
Instagram result still belongs in the creator review queue.

After any repair, run the default audit again. Token normalization must leave zero
logically-expired active tokens. Released counter reviews must disappear from the
active review count. For a partial or failed batch, keep the event logs and ledger
rows; rollback means stop, re-audit, and resolve the remaining rows in
Conversations—not deleting evidence or editing attempt state with SQL.

## The guide cover in a parent's delivery

A published cover image can be prepended to a guide as its first message. This is a
separate, later feature layered onto the ledger above, with its own switches. Read
this section as an addendum: everything above still applies.

### What ships inert

`GUIDE_COVER_DELIVERY_ENABLED` defaults false and the cohort defaults to nobody, so
on any deployment that has not been configured the guide goes out exactly as it did
before covers existed — only the image is withheld. The migration adds one enum
value (`generated_cover` on `guide_delivery_unit_origin`) and nothing else; it is
additive and inert while disabled.

There are **two** cover paths and each has its own fence. Both govern the image only —
never follower authorization, and never whether the gate or the guide is sent.

- `eligibleCover` (`src/services/guideDeliveryService.ts`) fences the cover prepended as
  the first unit of a ledger delivery. Consulted once, before the plan is compiled.
- `exposeCoverForGate` (`src/services/guideAccessActionService.ts`) fences the cover the
  follow gate sends **directly** to a non-follower. This one shipped unfenced: publishing
  a cover in the creator console was enough to put an image in front of a real parent
  while every delivery-side switch was off. Both now consult the same selector.

A withheld cover is left `not_shown` rather than claimed, so opening the rollout later
still sends it.

### Safe initial configuration

```text
GUIDE_COVER_DELIVERY_ENABLED=false
GUIDE_COVER_DELIVERY_RESOURCE_IDS=
GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT=0
```

Like `GUIDE_DELIVERY_ENABLED`, the boolean is parsed by `booleanFlag`. Audit the
parsed value, never the raw string.

Bucketing is per **trigger**, not per parent: an explicit redelivery draws
independently of the original request. The percentage is therefore a share of
triggers, which is the right denominator for "how many sends carried an image" and
the wrong one for "how many parents saw one".

### Stop

The three switches stop different things, and only one of them stops a cover.

| To stop | Set | Takes effect |
| --- | --- | --- |
| Covers only; guides keep sending | `GUIDE_COVER_DELIVERY_ENABLED=false` | Next decision. Read per delivery through the flags service. |
| The whole strict follower gate, including its deliveries | `GUIDE_FOLLOW_GATE_V2_ENABLED=false` | Next decision. |
| The retry worker and the original (non-strict) send path | `GUIDE_DELIVERY_ENABLED=false` | Next worker tick. |

Two things about that table are easy to get wrong under pressure.

`GUIDE_DELIVERY_ENABLED=false` does **not** stop a strict-gate delivery.
`guideAccessActionService` wires `startGuideDelivery` to `deliverGuideForTrigger`
directly and never consults `guideDeliveryOwner`, so a strict-gate delivery sends
inline regardless of that flag. The flag gates the legacy-vs-ledger routing in
`messageHandler` and the worker's own per-tick `isEnabled` check
(`guideDeliveryWorker.ts:100`), and nothing else. To stop strict-gate sending, use
`GUIDE_FOLLOW_GATE_V2_ENABLED`.

One asymmetry: the scheduler is only *created* when `env.GUIDE_DELIVERY_ENABLED` is
true at boot (`src/server.ts:196`), so turning the flag ON needs a restart while
turning it OFF takes effect on the next tick. Stopping is immediate; starting is not.

That also means `GUIDE_DELIVERY_ENABLED=false` while the strict gate is on is a bad
combination rather than a safe one: deliveries still start, but the worker refuses to
run, so a unit that came back retryable is never retried and the guide sits unfinished
until its messaging window lapses. If you intend to stop sending, stop the gate.

`GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT` is display-only in the console
(`pageMayEnable: false`), and `resolvePercent` discards any stored value for such a
key. Lowering the percentage in the UI does nothing. The stop is the boolean.

### Inspect

The Funnels page has a **Guide cover** panel. Every percentage there is computed
server-side in `runGuideAccessMetrics`, so the page cannot disagree with the API about
the arithmetic. `npm run funnel` does **not** report cover numbers; there is no CLI
cross-check for this panel yet.

An empty panel reading "no cover has been considered yet" is the expected state before
the pilot starts — it is not a failure. A panel saying the API "does not report cover
numbers yet" means the console is deployed ahead of the API, which is the normal
ordering here.

The two paths are measured as two separate stages, and their numbers must never be
divided by each other. They were one stage briefly, which let a share of gate
exposures be divided by a count of delivery-plan selections; the panel could then read
"accepted 100%" and "failed 100%" at the same time, or report that nothing had been
considered while parents were receiving images.

`cover_gate` — the gate's direct send. Denominated by the exposures actually attempted
(`accepted + failed + uncertain`), so those three sum to 100%:

- `accepted` — the provider took the image.
- `failed` — a definite refusal.
- `uncertain` — no message id, or a transport failure. May or may not have arrived.
- `omitted_not_selected` — the rollout fence held. Not in any send denominator.
- `omitted_mismatch` — see "Reconcile" below.

`cover_delivery` — the plan-time decision for a ledger delivery. These four partition
every plan compilation that had a cover to consider, so they add up to the whole pool.
Read that denominator as "decisions taken", not "deliveries created": two concurrent
calls for one trigger both reach the decision before the insert picks a winner, and the
counter write is fire-and-forget, so the count can run slightly above or below the
delivery count.

- `selected` — the cover went into the plan.
- `omitted_already_shown` — the parent already accepted this cover during the gate.
  Duplicate suppression working.
- `omitted_not_selected` — the rollout fence held. Expected to be almost everything
  during a pilot.
- `omitted_mismatch` — the snapshot pointed at a *different* guide's cover.

This path records **no** send outcome: whether the cover unit reached the parent is the
delivery ledger's business, and the review surface is where an operator sees it.

### The follow-check signals a rollout decision rests on

Task 8 says to hold expansion if the follow-check unavailable rate, the duplicate rate, the
send uncertainty or the owner-review rate crosses a threshold. Three of those come from
these stages, and the first one is **split across two of them** — read both or the number
is wrong:

- `fresh_check.unavailable` — Instagram could not answer when the parent first asked.
- `recheck.unavailable` — could not answer when they came back saying they had followed.
- `recheck.not_confirmed` — they say they followed and Instagram disagrees. This is the
  number a follow gate lives or dies by, and it was unreadable until these two stages were
  separated: both used to be recorded as `fresh_check`.
- `recheck.attempted` — the denominator for the three recheck outcomes.
- `gate.shown` — gates that provably reached a parent. The denominator for any gate
  conversion. An uncertain gate send is deliberately excluded, so this is a floor, not an
  estimate.
- `needs_review.marked` — the owner-review rate.

```sql
SELECT payload->>'stage' AS stage, payload->>'outcome' AS outcome, count(*)
FROM event_log
WHERE kind = 'guide_access_v2_metric'
  AND payload->>'stage' IN ('fresh_check', 'recheck', 'gate', 'needs_review')
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

The thresholds themselves are **not set**. They are a human decision and must be recorded
here before Task 8 begins.

Aggregate rows only. Every payload is validated by a `.strict()` schema against a
closed stage/outcome vocabulary, so a parent identifier, a URL, or a copy string
cannot reach this surface even by mistake — privacy here is a schema constraint, not
a convention. To read the raw rows:

```sql
SELECT payload->>'stage' AS stage, payload->>'outcome' AS outcome, count(*)
FROM event_log
WHERE kind = 'guide_access_v2_metric'
  AND payload->>'stage' IN ('cover_gate', 'cover_delivery')
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

A mispairing also writes its own operator-visible event, which does carry the ids
needed to chase it:

```sql
SELECT payload FROM event_log
WHERE kind = 'guide_cover_resource_mismatch'
ORDER BY created_at DESC LIMIT 20;
```

### Reconcile

**An uncertain cover exposure is never retried automatically.** The exposure is
fenced pessimistically: `guide_access_attempt.cover_exposure` moves
`not_shown → uncertain` *before* the send and settles to `accepted` or `failed`
after. A crash, a duplicate webhook, or a lost provider response therefore leaves
`uncertain`, and `uncertain` counts as shown. The parent may or may not have received
the image; sending it again to find out is the one thing that cannot be undone.

The consequence to expect: a parent whose cover exposure is `uncertain` will not be
sent that cover again on a later delivery in the same attempt. That is deliberate.

An `omitted_mismatch` is a different kind of problem. The delivery went out without
an image, which is the safe outcome, but the *pairing* is wrong — an attempt is
carrying a snapshot belonging to another guide. Nothing is owed to the parent; the
data needs fixing. Find the attempt from the mismatch event's `coverVersionId` and
`deliveryResourceId`, and check whether the guide's published cover changed between
the attempt being opened and the delivery running.

To see where attempts stand:

```sql
SELECT state, cover_exposure, count(*)
FROM guide_access_attempt
WHERE created_at >= now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

### Releasing a stuck attempt

Every fault in this flow parks the attempt in `needs_review`, which is an **active**
state: it blocks the parent's next request for the rest of their messaging window, and
nothing automatic clears it. There is no sweeper. Before the release action below, the
only escape was the parent messaging again *after* their window lapsed — so a parent who
gave up stayed blocked, with nothing on any screen to show it.

Find the conversation with the attempt query above, then:

```bash
curl -X POST "$API/api/guide-deliveries/access/<conversationId>/release"   -H 'Content-Type: application/json'   -d '{"acknowledgeDuplicateRisk": true}'
```

It refuses any attempt that has, or has had, a delivery — with `409
access_attempt_delivering`. That covers `delivering`, and also a `needs_review` attempt
holding a confirmed follow, which is only reachable by having BEEN `delivering`: the durable
delivery can fail to start and move the attempt back, leaving a delivery row whose uncertain
unit the owner review can still fire. Releasing that would free the conversation and let the
parent's next message build a second full guide. Cancel the delivery instead; that releases
its own attempt correctly.

The acknowledgement is required and is not a formality. Releasing authorizes nothing —
a new attempt must earn its own live follow confirmation — but the parent may be sent
something they already received, which is exactly the judgement this system gives to a
human rather than to a retry loop. The release is audited as
`guide_access_owner_action` with the actor and the state it released from.

An attempt stuck in `delivering` is otherwise released lazily by the parent's next
inbound message, not by a sweeper. Until then that conversation is treated as
mid-flight and the parent's next request is refused.
If a completion could not settle its attempt, the log carries
`access_attempt_settle_failed` or `access_attempt_settle_refused`; the latter means
the active attempt was not the one that delivery belonged to and was correctly left
alone.

### Rollback

As above: rollback stops *new* sends and never deletes ledger rows.

1. Set `GUIDE_COVER_DELIVERY_ENABLED=false`. Covers stop being attached on the next
   decision; guides keep sending. No restart is needed.
2. Leave `guide_access_attempt` rows in place. `cover_exposure = 'uncertain'` is the
   only record that a parent may have received an image, and deleting it would let a
   later delivery send that image again.
3. Do not revert the enum migration. Existing `guide_delivery_unit` rows with
   `origin = 'generated_cover'` are the record of what was sent; removing the value
   would orphan them.
4. A cover already in a `needs_review` delivery is resolved through the same three
   owner actions as any other unit. The review card labels it "Guide cover" rather
   than a numbered message, so the owner knows they are deciding about the image and
   not about an authored step.
