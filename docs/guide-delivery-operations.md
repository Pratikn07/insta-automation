# Durable guide delivery operations

This runbook is the release and incident procedure for Instagram guide delivery. It deliberately does not contain guide text, media URLs, recipient identifiers, provider tokens, or raw provider errors. Use delivery, unit, resource, message, conversation, thread, and trigger IDs when recording evidence.

## Release gate

Run the read-only authoring audit before deploying anything:

```bash
DOTENV_CONFIG_PATH=/absolute/path/to/the/backend.env \
NODE_OPTIONS='-r dotenv/config' \
npm run audit:guide-message-lengths
```

The command prints one structural line per over-limit row: resource/message IDs, resource label, authored order and type, JavaScript UTF-16 code-unit count, amount over 1,000, and active-keyword count. It never prints the message body, media URL, recipient, provider data, or credentials.

- Exit `0`: no active guide has an over-limit message. Inactive or unlinked warnings may still be listed and do not block activation.
- Exit `1`: at least one active guide is over the limit, or the audit could not safely complete. Do not activate guide delivery.

The 2026-08-09 verification measured active message `98d105f9-a676-4dd0-b35a-e3835b4b57c5` at **1,435 UTF-16 code units**, 435 over the limit. That measured value supersedes the stale 1,434-unit wording in the implementation plan. It is a rollout blocker. The same audit listed inactive message `45aafe38-4546-4b84-b861-de3493f6ba53` at 1,753 units; that warning does not by itself block live traffic.

An author must supply and save the exact replacement message or exact additional Text steps. Operators must not use SQL to update content and must not auto-split, truncate, normalize, rewrite, or invent a message boundary.

## Deployment order

1. Confirm the audit exits `0` for active guides. Archive the ID/count-only output with the release evidence.
2. Back up the database according to the normal production procedure.
3. Deploy the complete Prisma migration history first. Confirm the migration that creates `guide_delivery` and `guide_delivery_unit`, their constraints, partial worker indexes, RLS, and revoked public-role privileges is present.
4. Deploy the backend application. Its scheduler starts immediately and has no feature flag. It reconciles stale claims before it claims due work.
5. Confirm the backend is healthy and the worker tick has no database/checkpoint error codes.
6. Deploy the web application. Confirm Conversations can display `Delivery needs review` and its three owner actions.
7. Perform the controlled checks below before allowing ordinary guide traffic.

The backend validates these optional environment variables at startup:

| Variable | Default | Valid range |
| --- | ---: | --- |
| `GUIDE_DELIVERY_BATCH_SIZE` | `10` | integer `1..50` |
| `GUIDE_DELIVERY_LEASE_MS` | `300000` | integer, at least `60000` |
| `GUIDE_DELIVERY_MAX_ATTEMPTS` | `3` | integer `1..10` |
| `GUIDE_DELIVERY_RETRY_BASE_MS` | `60000` | integer, at least `10000` |
| `GUIDE_DELIVERY_WORKER_INTERVAL_MS` | `60000` | integer, at least `10000` |

An invalid value prevents startup. Retry backoff is bounded by the delivery's messaging-window expiry. Changing these values does not turn the scheduler off.

## Controlled pre-production checks

These checks require an isolated non-production deployment, a controlled Instagram account and recipient, an open messaging window, and an approved way to inject provider outcomes. They were **not executed during repository verification** because no controlled account, recipient, or failure-injection environment was authorized. Never run them against an uncontrolled recipient.

Before each check, record only the environment, delivery ID, ordered unit IDs, initial statuses, and messaging-window expiry. After each check, record attempts, final statuses, and the relevant safe event names. Do not paste content, media URLs, recipient/provider identifiers, tokens, or raw errors.

### 1. Text-only completion

1. Create a guide with two authored Text steps, both at or below 1,000 UTF-16 code units.
2. Trigger it once from the controlled recipient.
3. Verify one immutable delivery contains two ordered `text` units.
4. Verify each unit moves `pending -> sending -> sent` with one attempt.
5. Verify the delivery becomes `completed` only after both units are `sent`.
6. Replay the same inbound trigger and verify no new delivery, units, or provider sends are created.

### 2. Image plus caption and definite rejection

1. Create an image step with an authored caption. Verify the plan contains an `image` unit followed by a `text` caption unit.
2. Allow the image call to succeed, then inject a definite provider rejection for the caption call.
3. Verify the image unit remains `sent` with its original attempt and provider checkpoint, while only the caption is failed/retried.
4. Allow the retry and verify processing resumes at the caption; the image is not sent again.

For a definite transient rejection, expect bounded backoff and `guide_delivery_unit_failed`, followed by either a successful caption send, `guide_delivery_attempts_exhausted`, or `guide_delivery_window_closed`. A definite permanent rejection is terminal and is never automatically retried.

### 3. Ambiguous provider outcome

1. Inject a timeout or connection reset after the request may have reached the provider.
2. Verify the active unit becomes `uncertain`, the delivery becomes `needs_review`, and `next_attempt_at` is null.
3. Allow at least two worker intervals to pass. Verify attempts and provider calls do not increase.
4. Open Conversations. Verify `Delivery needs review` and all three actions are visible: **Already delivered**, **Retry sending**, and **Cancel delivery**.

If a process dies while a unit is `sending`, wait past the lease and verify reconciliation produces the same review boundary. Stale provider-boundary work must never return to `pending` or automatic retry.

### 4. Owner resolution paths

Use one new controlled delivery for each path so the evidence is unambiguous.

- **Already delivered:** Use this only after independently confirming the recipient received the uncertain unit. The unit becomes owner-confirmed `sent`. If all units are now `sent`, completion is allowed even when the window has closed. If unsent units remain and the window is open, resume skips every confirmed unit. If unsent units remain and the window is closed, the delivery becomes `failed` with `messaging_window_closed`.
- **Retry sending:** The confirmation must explicitly acknowledge duplicate-delivery risk. It authorizes exactly one retry of the selected uncertain unit and may send a duplicate. It is rejected when the messaging window is closed. Verify earlier `sent` units are unchanged.
- **Cancel delivery:** Confirm the warning. The delivery becomes `cancelled`; no remaining unit is sent. Cancellation remains available after the messaging window closes, but cannot override active `sending` work or a `completed` delivery.

For the required end-to-end resume check, choose **Already delivered** for the ambiguous unit, then verify remaining units resume without resending any earlier provider- or owner-confirmed unit.

## Status and event interpretation

Delivery states are `planned`, `sending`, `failed`, `needs_review`, `completed`, and `cancelled`. Unit states are `pending`, `sending`, `sent`, `failed`, and `uncertain`. Only provider-confirmed or owner-confirmed units may be `sent`. Completion requires a nonempty unit set in which every unit is `sent`.

The following event names and structural fields are approved for operational use:

| Event | Safe structural fields |
| --- | --- |
| `guide_delivery_planned` | delivery/conversation/resource/trigger IDs, trigger kind, unit count |
| `guide_delivery_preflight_rejected` | identity fields, failure/preflight code, resource-message ID, authored order, unit kind/count, actual length, limit, detection timestamp |
| `guide_delivery_claimed` | identity fields, claim timestamp |
| `guide_delivery_unit_sent` | identity fields, unit ID/position/kind, attempt, provider-message ID, owner-confirmed boolean, sent timestamp |
| `guide_delivery_unit_failed` | identity fields, unit ID/position/kind, attempt, disposition, failure timestamp, allowlisted error metadata |
| `guide_delivery_unit_uncertain` | identity fields, unit ID/position/kind, attempt, uncertain timestamp, allowlisted error metadata |
| `guide_delivery_attempts_exhausted` | identity fields, unit ID/position/kind, attempts/cap, exhausted timestamp |
| `guide_delivery_window_closed` | identity fields, optional unit ID/position/kind/attempt, timestamp |
| `guide_delivery_claim_released` | identity fields, release timestamp |
| `guide_delivery_claim_expired_uncertain` | identity fields, uncertain-unit count, reconciliation timestamp |
| `guide_delivery_claim_expired_review` | identity fields, reconciliation timestamp |
| `guide_delivery_claim_expired_terminal` | identity fields, reconciliation timestamp |
| `guide_delivery_claim_expired_released` | identity fields, reconciliation timestamp |
| `guide_delivery_completion_reclaimed` | identity fields, unit count, reclaim timestamp |
| `guide_delivery_owner_action` | owner actor, action, delivery ID, optional unit ID, timestamp |
| `sequence_completed` | identity fields, thread ID, unit count, trigger-time follower flags, completion timestamp |

Here, identity fields are delivery, conversation, resource, and trigger IDs plus trigger kind. Allowlisted provider-error metadata is category, HTTP status, Graph code/subcode, trace ID, and transport code. Never add snapshot text, authored bodies, media URLs, recipient IDs/usernames, request/response bodies, access tokens, or raw error strings to an event.

Application logs use stable error codes such as `guide_delivery_tick_failed`, `guide_delivery_processing_failed`, `guide_delivery_completion_failed`, checkpoint/recipient lookup failures, and `guide_delivery_owner_resume_failed`. Bind only a delivery ID and aggregate counts where applicable. Do not log snapshots, content fingerprints alongside content, media URLs, recipients, provider request/response bodies, or raw exceptions.

## Monitoring

Use restricted backend/database access. Export only IDs, statuses, safe timestamps, failure codes, and counts.

Queue and review dashboard:

```sql
SELECT status, failure_code, count(*) AS delivery_count
FROM guide_delivery
GROUP BY status, failure_code
ORDER BY status, failure_code;
```

Oldest actionable work:

```sql
SELECT id, status, failure_code, next_attempt_at, claim_expires_at,
       send_window_expires_at, updated_at
FROM guide_delivery
WHERE status IN ('planned', 'sending', 'failed', 'needs_review')
ORDER BY updated_at ASC, id ASC
LIMIT 100;
```

Review age and unit counts:

```sql
SELECT d.id AS delivery_id, d.updated_at,
       count(*) FILTER (WHERE u.status = 'sent') AS sent_units,
       count(*) FILTER (WHERE u.status = 'uncertain') AS uncertain_units,
       count(*) AS total_units
FROM guide_delivery AS d
JOIN guide_delivery_unit AS u ON u.delivery_id = d.id
WHERE d.status = 'needs_review'
GROUP BY d.id, d.updated_at
ORDER BY d.updated_at ASC, d.id ASC;
```

Alert on a sustained increase in `needs_review`, `guide_unit_attempts_exhausted`, or `messaging_window_closed`; expired `sending` claims older than the worker interval plus lease; repeated safe worker/checkpoint error codes; or planned/failed due work whose `next_attempt_at` stays in the past. Treat a `sending` unit past its lease as ambiguous, not retryable.

## Rollback and incident containment

1. Stop new backend application sends and the guide worker first by rolling back/stopping the application deployment. There is no runtime feature flag for this scheduler.
2. Preserve `guide_delivery`, `guide_delivery_unit`, and their event history. Do not roll back the ledger migration while rows exist.
3. Do not delete ledger rows, clear provider checkpoints, reset `uncertain`/`sending` units to `pending`, change attempts, or fabricate provider-message IDs.
4. Do not restore or reintroduce `sequenceSender` or any direct guide sender. That would bypass preflight, idempotency, and unit checkpoints.
5. Investigate using delivery/unit IDs, statuses, timestamps, failure codes, attempts, and allowlisted metadata only. Route ambiguous cases to owner review.
6. Resume with the fixed backend only after expired claims have been reconciled and active authored content passes the audit.

Database rollback alone does not stop application sends. Application/worker containment comes first.

## Follow recovery boundary

Proactive follow-gate polling or rechecking is **not implemented** by this release. Expired explicit `DONE` inbound recovery is implemented: a normalized `DONE` may recover the matching expired gate, while arbitrary expired text does not. Any future proactive recovery must create a durable delivery with `triggerKind = follow_recovery` and call the same delivery service. It must not call Meta directly or recreate a sequence sender.

## Release evidence map

Use the complete automated matrix plus the fresh PostgreSQL contract run. The controlled Instagram checks remain a separate manual gate.

| Success criterion | Named automated evidence | Remaining manual evidence |
| --- | --- | --- |
| Supported text and caption writes reject more than 1,000 UTF-16 code units | `guide message length > POST/PATCH rejects 1,001 code units without echoing text`; `guide message length > rejects an over-limit image/pdf caption with the shared error` in `src/api/messages.routes.test.ts` | Controlled authoring save, then no send while invalid |
| A legacy-invalid plan makes zero Graph calls | `preflights a later invalid legacy caption before either tracked sender is called` in `src/services/guideDeliveryService.test.ts` | Controlled invalid legacy fixture only if a production-shaped rehearsal is required |
| The UI never invents message boundaries | `renders one preview bubble for one over-limit authored text step` and `applies the same validation to image/pdf captions` in `web/src/pages/SequenceEditor.test.tsx` | Visual author review |
| Provider- or owner-confirmed units are not automatically resent | `keeps a confirmed image sent and resumes only its transiently rejected caption` in `src/services/guideDeliveryService.test.ts`; `authorizes exactly one retry and beginUnit atomically consumes it without resetting sent units` in `src/services/guideDeliveryRepositoryContract.test.ts` | Controlled image/caption rejection and owner-resolution checks |
| Ambiguous outcomes require owner action | `marks a timeout uncertain, requires review, and never begins a later unit` in `src/services/guideDeliveryService.test.ts`; `persists an uncertain outcome with only allowlisted metadata and never makes it due` and `turns an expired sending unit uncertain and clears the claim into review` in `src/services/guideDeliveryRepositoryContract.test.ts`; `does not retry until duplicate risk is confirmed` in `web/src/components/conversations/GuideDeliveryReviewCard.test.tsx` | Controlled ambiguous timeout and Conversations review |
| Completion requires a nonempty all-sent unit set | `refuses completion for a zero-unit/pending-unit/sent-unit-missing-sentAt delivery` in `src/services/guideDeliveryCompletion.test.ts`; `refuses completion for zero units, non-sent units, and stale claims without state drift` in `src/services/guideDeliveryRepositoryContract.test.ts` | Controlled two-text completion |
| Webhook replay creates one immutable plan | `collapses concurrent planning to one immutable delivery and one exact unit set` and `returns the first snapshot when a trigger replay carries edited content` in `src/services/guideDeliveryRepositoryContract.test.ts`; `replays the first persisted snapshot without loading edited resource messages` in `src/services/guideDeliveryService.test.ts` | Controlled replay with provider-call count |
| No database transaction spans a Meta call | `checkpoints each provider ID before beginning the next unit and paces calls by 800ms` and `leaves a provider-accepted unit sending when its success checkpoint fails/throws` in `src/services/guideDeliveryService.test.ts`, plus code review of the awaited repository/sender boundaries | Controlled provider/checkpoint trace if required by release approver |
| Expired explicit `DONE` recovery works and arbitrary expired text does not | `recovers an expired DONE and delivers to a follower`, `recovers an expired DONE and asks a confirmed non-follower to follow`, and `does not recover an expired request for non-contract text` in `src/handlers/messageHandler.test.ts` | Controlled expired-gate check only if release approver requires an external rehearsal |

## Manual evidence template

Keep controlled-check evidence structural and redact environment secrets:

```text
check=<text-only|image-caption-retry|ambiguous-review|owner-resolution>
environment=<controlled-non-production-name>
executedAt=<ISO timestamp>
operator=<approved operator>
deliveryId=<UUID>
unitIds=<ordered UUID list>
initialDeliveryStatus=<status>
initialUnitStatuses=<ordered statuses>
attemptsBefore=<ordered integers>
action=<trigger|inject-definite-rejection|inject-ambiguous-timeout|confirm-delivered|acknowledged-retry|cancel>
finalDeliveryStatus=<status>
finalUnitStatuses=<ordered statuses>
attemptsAfter=<ordered integers>
eventNames=<safe event names only>
providerCallsObserved=<integer>
result=<pass|fail>
```

Never attach guide content, screenshots containing content/recipient details, media URLs, provider IDs, access tokens, request/response bodies, or raw errors to this evidence.
