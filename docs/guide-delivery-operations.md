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
