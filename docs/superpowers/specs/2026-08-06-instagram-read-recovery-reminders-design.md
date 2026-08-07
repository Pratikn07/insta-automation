# Instagram Read-Recovery Reminders Design

**Date:** 2026-08-06  
**Branch:** `feat/instagram-read-recovery-reminders`  
**Status:** Approved design  
**Scope:** Prospective comment-origin keyword journeys only

## 1. Problem

People comment a keyword such as `PROTEIN`, `SLEEP`, or `POTTY`, and the automation sends a private gate message asking them to follow and reply. A large share of these journeys later expire without a completing reply.

Meta accepting the private-reply API request proves only that the API accepted the message. It does not prove that the recipient opened it. The message might be unread, in Requests or Hidden Requests, blocked after initial acceptance, or read without an available receipt. The existing dashboard groups these outcomes under `No reply`, which overstates what the system actually knows.

The feature will use Meta's positive read and engagement signals to suppress unnecessary public comments. When the system has no confirmed read or engagement ten hours after an accepted gate DM, it will post one public reminder on the original comment. A separate immediate path handles a verified message-settings rejection.

## 2. Goals

1. Capture Meta read, reaction, postback, quick-reply, and inbound-message signals.
2. Correlate those signals with the exact accepted gate DM using Meta's `message_id`.
3. Automatically post a public reminder ten hours after acceptance when there is no confirmed read or engagement.
4. Immediately post a different fallback only when a verified structured Meta error proves message settings blocked delivery.
5. Prevent duplicate, stale, excessive, and unsafe public comments.
6. Ensure worker downtime never causes a follower to lose the recovery opportunity.
7. Show precise, uncertainty-aware states in the Conversations dashboard.
8. Measure incremental benefit using a deterministic 90/10 treatment-control experiment for two weeks.
9. Preserve an auditable history without storing raw provider errors, tokens, or unnecessary private content.

## 3. Non-goals

- Retrospectively contacting historical `No reply` users. That remains Feature Request 4 because historical read receipts are unavailable.
- General journey deduplication and reconciliation. That remains Feature Request 3, although this feature includes the minimum idempotency and cooldown rules required to prevent duplicate public reminders.
- Proving that every person without a read receipt was genuinely unread. Meta does not provide enough evidence for that claim.
- Scraping or reading the gray warning displayed in Meta Business Suite.
- Automatically deleting a public reminder after it is posted.
- Adding a general-purpose `Send now` dashboard action.
- Changing the existing gate or guide copy.
- Applying public recovery to DM-origin journeys. Those journeys have no source comment to reply to.

## 4. Approved product decisions

### 4.1 Public copy

No-confirmed-read reminder:

> I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “{KEYWORD}”.

Verified settings-blocked fallback:

> I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “{KEYWORD}”.

`{KEYWORD}` is replaced only with the snapshotted configured keyword. No user-authored text is inserted.

### 4.2 Timing

- The ten-hour clock starts when Meta accepts the gate DM, not when the original comment arrived.
- A no-confirmed-read reminder becomes eligible at `acceptedAt + 10 hours`.
- A verified settings-blocked fallback is eligible immediately.
- Reminders never expire because a worker was unavailable.
- After recovery from downtime, overdue records are re-evaluated and processed gradually.

### 4.3 Per-person cooldown

- A person can receive at most one automated public recovery comment in any rolling 24-hour period.
- If several different keywords are eligible, the most recently eligible keyword is selected.
- Other eligible records for that person are suppressed with a machine-readable cooldown/supersession reason.
- Repeated processing of one source comment can never create another reminder.

### 4.4 Experiment

- The first two weeks use 90% treatment and 10% control.
- Assignment is deterministic per Instagram user and experiment version, so repeated comments cannot move a person between cohorts.
- The control applies only to the ten-hour no-confirmed-read reminder.
- Verified settings-blocked failures always receive the immediate fallback and are excluded from the experiment.
- Control records are never sent retroactively after the experiment.
- When the experiment ends, new eligible records enter treatment after owner review of results.

## 5. Evidence and Meta constraints

Meta's official Instagram documentation establishes the signals used by this design:

- The `messaging_seen` webhook contains `read.mid`, the ID of the message that was read: <https://www.postman.com/meta/instagram/request/23987686-a71fb850-457c-4b82-a56a-1dea1785f2a2>
- The reactions webhook contains `reaction.mid` and `react`/`unreact` actions: <https://www.postman.com/meta/instagram/request/23987686-90143a77-738c-4ca4-a4d6-228710dc0376>
- Ordinary message webhooks can include text, attachments, and quick-reply payloads: <https://www.postman.com/meta/instagram/request/23987686-95cce6f6-b811-41dc-b560-d43741c5002a>
- A successful private reply normally returns a recipient ID and message ID. Non-followers receive private replies in Requests: <https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514>

The official webhook surface does not expose the gray Business Suite warning as a separate delivery-status event. Consequently, the system must not infer that warning from missing read telemetry.

## 6. Current codebase gaps

The current repository already has useful foundations: outbound DM capture, inbound-message idempotency, a paced gate retry worker, event logging, conversation detail drawers, and background-worker patterns.

The relevant gaps are:

1. `src/types/meta.ts` models only ordinary `message` entries; it has no `read`, `reaction`, or `postback` shapes.
2. `src/handlers/webhookRouter.ts` routes every messaging entry to `handleMessage`; non-message entries are then ignored.
3. The comment gate flow calls `sendTrackedPrivateReply` but discards its returned Meta `message_id`.
4. `DmMessage.instagramMessageId` can store Meta IDs, but gate-to-reminder correlation is not persisted.
5. The setup documentation subscribes only to `comments` and `messages`; it must also document `messaging_seen`, `message_reactions`, and `messaging_postbacks`.
6. Conversation states express journey outcome, not read or recovery state.
7. The `No reply` summary currently claims that a person never replied, even though the data can include other journeys and ambiguous delivery/read outcomes.
8. No durable public-reminder state machine, per-person cooldown, control cohort, or recovery UI exists.
9. Comments authored by the business account are intentionally ignored to prevent self-trigger loops. Consequently, the app cannot reliably infer that the owner handled a recovery manually in Instagram; the owner cancellation control is the explicit suppression mechanism.

## 7. Architecture choice

### 7.1 Selected approach: dedicated recovery-reminder state machine

A dedicated relational record represents every prospective recovery decision. Focused webhook handlers update it, a pure policy determines eligibility, a leased worker performs public sends, and a dedicated dashboard lens reports its status.

This approach provides:

- Exact message-ID correlation
- Durable outage recovery
- Atomic idempotency
- Explicit uncertainty states
- Reliable filtering and counts
- Treatment-control assignment
- Auditable decisions
- A clean boundary from the existing private-DM retry queue

### 7.2 Rejected approach: derive from `EventLog`

Reconstructing eligibility from JSON event records would reduce schema additions, but it would make exact joins, pagination, concurrency, duplicate prevention, state transitions, and experiment reporting fragile.

### 7.3 Rejected approach: reuse `GateQueue`

`GateQueue` retries an unsuccessful private DM. A recovery reminder follows a successful private DM. Their timing, error classifications, terminal states, and idempotency risks differ, so combining them would couple unrelated responsibilities.

## 8. System components

The implementation is divided into five bounded components.

### 8.1 Meta event ingestion

Extend the webhook types and router to recognize:

- `messaging_seen`
- `message_reactions`
- `messaging_postbacks`
- Normal inbound messages, attachments, and quick replies

Read, reaction, and postback entries go to focused handlers. Normal inbound messages remain with the existing message handler. Each handler validates the event, preserves Meta's timestamp, deduplicates replays, correlates the exact `mid`, records safe observability, and updates recovery state. No webhook handler posts a public comment directly.

### 8.2 Recovery persistence

A dedicated `DmRecoveryReminder` row is the authoritative record for one public-recovery decision.

### 8.3 Decision policy

A pure function evaluates one current-state snapshot and returns:

```text
wait
holdout
suppress(reason)
send_settings_fallback
send_no_confirmed_read_reminder
```

A coordinating service loads database evidence and invokes the pure policy.

### 8.4 Durable worker

A paced worker atomically claims due records with leases, reloads all suppression evidence immediately before sending, calls Meta outside the database transaction, and finalizes the result.

### 8.5 Dashboard and measurement

The Conversations page gains a DM recovery lens, detailed timeline, owner cancellation, operational attention states, and experiment metrics.

## 9. Data model

### 9.1 `DmRecoveryReminder`

| Field | Type/shape | Purpose |
| --- | --- | --- |
| `id` | UUID | Primary key |
| `conversationId` | UUID | Source automation journey |
| `igUserId` | string | Instagram-scoped person ID |
| `keywordId` | UUID | Source keyword configuration |
| `keywordSnapshot` | string | Stable substitution value for public copy |
| `templateVersion` | integer/string | Version of the fixed recovery template |
| `publicReplyText` | string | Exact rendered public copy for audit and UI |
| `commentId` | string | Exact original comment to reply to |
| `mediaId` | string nullable | Original Reel/post ID |
| `gateDmMessageId` | UUID nullable | Local outbound `DmMessage` row |
| `instagramGateMessageId` | string nullable | Exact Meta gate `message_id` |
| `triggerKind` | enum | `no_confirmed_read` or `settings_blocked` |
| `status` | enum | State-machine status |
| `cohort` | enum | `treatment`, `control`, or `not_applicable` |
| `acceptedAt` | timestamptz nullable | Meta acceptance time |
| `eligibleAt` | timestamptz | Ten-hour or immediate eligibility |
| `seenAt` | timestamptz nullable | Matching read timestamp |
| `engagedAt` | timestamptz nullable | First reply/reaction/postback timestamp |
| `suppressedAt` | timestamptz nullable | Suppression time |
| `suppressionReason` | string/enum nullable | Stable decision reason |
| `claimedAt` | timestamptz nullable | Worker claim time |
| `claimExpiresAt` | timestamptz nullable | Lease deadline |
| `nextAttemptAt` | timestamptz nullable | Definitely-safe retry time |
| `attempts` | integer | Public send attempts |
| `publicReplyId` | string nullable | Meta's public reply ID |
| `sentAt` | timestamptz nullable | Confirmed public reply time |
| `lastErrorCategory` | string nullable | Safe allowlisted category |
| `reviewedAt` | timestamptz nullable | Owner reviewed an attention item |
| `cancelledAt` | timestamptz nullable | Owner cancellation time |
| `createdAt`, `updatedAt` | timestamps | Audit timestamps |

The source `commentId` is unique for recovery purposes, preventing replayed comment webhooks from creating multiple records. The worker also performs an atomic per-person cooldown check, so concurrent records cannot produce multiple public comments.

### 9.2 Recovery statuses

```text
waiting
control
suppressed
sending
sent
send_failed
send_uncertain
tracking_unavailable
cancelled
```

Eligibility is derived from `status = waiting` and `eligibleAt <= now`; a separate `ready` database state is unnecessary.

### 9.3 Existing model changes

- Add nullable `seenAt` to `DmMessage`.
- Make the tracked private-reply service return enough information to persist both the local outbound row and Meta message ID.
- Keep raw reaction and postback observability in safe event records; persist the first engagement time and suppression reason on the recovery row.

## 10. Trigger and decision flow

### 10.1 Verified settings-blocked path

1. The Graph request returns an error.
2. The safe classifier compares the structured numeric code/subcode with a verified allowlist.
3. Only an allowlisted message-settings rejection creates an immediate `settings_blocked` recovery.
4. The existing private-DM retry queue does not retry this permanent settings rejection.
5. The control experiment does not apply.
6. The worker posts the settings-specific fallback on the source comment.

The settings allowlist begins empty. It is populated only after observing and verifying the actual structured Meta response. The following never prove settings blockage:

- Missing `messaging_seen`
- A generic HTTP 400
- A rate limit
- A network timeout
- Business Suite's gray warning
- Graph subcode `2534025`, which the current code classifies as rate limiting

### 10.2 Accepted-DM path

This path is created only for comment-origin journeys with a source `commentId`. DM-origin journeys are explicitly classified as having no public-reply route and never enter the recovery worker.

1. Meta accepts the gate private reply.
2. The send service persists the exact `message_id` and acceptance time.
3. If `message_id` is absent, create a terminal `tracking_unavailable` record and do not comment automatically.
4. If `message_id` is present, create `waiting` with `eligibleAt = acceptedAt + 10 hours`.
5. Assign the person deterministically to treatment or control.
6. Process incoming read and engagement signals during the waiting period.
7. At eligibility, evaluate the complete suppression policy.
8. Treatment records that remain eligible are sent; control records remain unsent.

### 10.3 Complete send predicate

A no-confirmed-read reminder may be sent only when all conditions are true:

```text
Meta accepted the gate DM
AND the exact gate message_id is known
AND ten hours have elapsed
AND no matching messaging_seen exists
AND no inbound DM exists after acceptance
AND no reaction or postback exists
AND the source journey has not completed
AND no matching journey for the same person and keyword completed elsewhere
AND the owner has not cancelled the reminder
AND no recovery comment was already sent for the source comment
AND no recovery comment was sent to the person in the previous 24 hours
AND this is the most recently eligible candidate for the person
AND the feature and circuit breaker permit sending
AND the hourly send cap has not been reached
AND the person is in treatment
```

Original comment deletion or comment disabling may only become known when Meta rejects the public reply. That rejection becomes a permanent send failure.

Failure of the initial public acknowledgement does not by itself suppress recovery. Ten hours later, the worker may still attempt the agreed recovery reply against the original comment; Meta's result determines whether the comment remains replyable.

### 10.4 Suppression signals

The following suppress a pending reminder:

- `messaging_seen` matching the exact gate `message_id`
- Any inbound DM after acceptance, including text, image, video, audio, file, share, sticker, story mention, or quick reply
- An inbound message remains proof of engagement even if the person later deletes it; a deletion event for an otherwise unknown message is not sufficient evidence by itself
- A reaction to the exact gate message; later unreacting does not undo the proof of engagement
- A relevant postback/button interaction
- Source journey completion
- Completion elsewhere for the same person and keyword
- Manual owner cancellation
- A more recent eligible candidate selected under the per-person cooldown

A later public comment does not prove the DM was read and does not suppress by itself.

### 10.5 Races

The worker claims atomically, reloads all evidence, and performs a final policy decision immediately before the Meta call. A read can still arrive after the external call begins. If its Meta timestamp is later than the public send, record `seen_after_reminder`. If the webhook arrives later but carries a timestamp earlier than the public send, record a confirmed delayed-webhook false positive.

## 11. Worker and idempotency

1. Select due `waiting` records ordered by `eligibleAt`.
2. For a person with multiple candidates, suppress older candidates and retain the most recently eligible candidate.
3. Atomically transition the selected record to `sending` with a bounded lease.
4. End the database transaction.
5. Reload all suppression and health evidence.
6. Return to `waiting`, `control`, or `suppressed` when the policy does not allow a send.
7. Call Meta only when the final decision remains sendable.
8. Store Meta's public reply ID and mark `sent`.

Duplicate Meta webhooks are idempotent. Duplicate worker claims cannot pass the state/lease transition. Duplicate source comments cannot create duplicate recovery records.

If a worker dies in `sending`, the system cannot prove whether it died before or after Meta accepted the public reply. An expired sending lease therefore becomes `send_uncertain` and is never retried automatically.

## 12. Error classification

Graph outcomes are classified as:

```text
settings_blocked
rate_limited
temporary_provider
definite_permanent
transport_uncertain
unknown
```

### 12.1 Private gate errors

- `settings_blocked`: immediate recovery fallback, no private retry.
- `rate_limited` or `temporary_provider`: existing bounded gate retry flow; no public fallback yet.
- `transport_uncertain`: do not infer settings blockage; retain ambiguity and existing retry safeguards.
- `definite_permanent` or `unknown`: owner-visible failure; never use settings-specific copy without the verified classification.

### 12.2 Public reply errors

| Outcome | Transition |
| --- | --- |
| Success with reply ID | `sent` |
| Success without reply ID | `send_uncertain`; no retry |
| HTTP 429/rate limit | `waiting` with bounded exponential backoff |
| Definite provider rejection before processing | Retry only when classified safe and bounded |
| Network timeout/connection reset | `send_uncertain`; no retry |
| Comment/post deleted or comments disabled | `send_failed` permanent |
| Authentication/permission failure | Open circuit and alert owner |
| Unknown response | `send_uncertain` |

The public-reply client must return the provider reply ID instead of discarding it.

## 13. Operational controls

Configuration includes:

- Master feature kill switch
- Ten-hour eligibility delay
- 24-hour per-person cooldown
- Worker interval and batch size
- Maximum public replies per hour
- Safe retry backoff and attempt cap
- Holdout percentage
- Experiment version, start, and end timestamps
- Circuit-breaker thresholds

### 13.1 Circuit breaker

Pause new public sends when:

- Instagram authentication or permissions fail
- Webhook processing stops while account activity continues
- A meaningful volume of accepted gates produces no read events
- Eligible volume exceeds an anomaly threshold
- Public-reply failures exceed a threshold
- The hourly send cap is reached
- Database claim/state transitions repeatedly fail

Opening the breaker leaves records pending. Nothing expires. The dashboard displays the reason. After recovery, overdue records are processed gradually, oldest first across people, while selecting the most recent candidate within each person's eligible set.

## 14. Dashboard design

### 14.1 DM recovery lens

Add a `DM recovery` lens to the existing Conversations page. Do not mix recovery states into legacy journey-state filters.

Filters:

```text
All
Scheduled
Ready
Sent
Suppressed
Control
Attention
```

Counts show both unique people and automation records, for example `18 people · 21 journeys`.

### 14.2 Row content

Each row shows:

- Username
- Keyword
- Original post/reel
- Time since gate acceptance
- Due or sent time
- Recovery status
- Concise reason

### 14.3 User-facing statuses

```text
Waiting for read confirmation
No confirmed read
Seen—reminder not needed
Replied—reminder not needed
Reacted—reminder not needed
Completed—reminder not needed
Another reminder was recently sent
Reminder scheduled
Reminder ready
Reminder sent
Reminder sent late after worker delay
Settings blocked
Control group—reminder intentionally withheld
Tracking unavailable
Cancelled by owner
Couldn’t post public reminder
Send outcome uncertain—check Instagram
```

The UI never labels missing telemetry as `Unread`.

Tooltip for `No confirmed read`:

> Meta accepted the DM, but we received no read confirmation. It may be unread, in Requests or Hidden Requests, blocked after acceptance, or read without an available receipt.

### 14.4 Detail drawer

The drawer displays:

1. Original keyword comment
2. Initial public acknowledgement
3. Gate DM acceptance and exact correlation status
4. Ten-hour monitoring window
5. Read/engagement evidence or absence of confirmation
6. Recovery decision
7. Public reminder result
8. Later response or completion

Actions:

- Cancel a waiting/ready reminder
- View user journey
- View original post
- Mark an uncertain item reviewed

There is no v1 `Send now` action.

### 14.5 Existing journey language

Replace claims such as `@user never replied` with:

> No reply completed this journey before it expired.

Prospective rows may show a secondary recovery badge. Pre-feature rows show:

> Read status unavailable—journey predates read tracking.

Historical rows never enter the automatic worker.

## 15. API design

Authenticated endpoints:

```text
GET  /api/recovery-reminders
GET  /api/recovery-reminders/counts
GET  /api/recovery-reminders/metrics
GET  /api/recovery-reminders/:id
POST /api/recovery-reminders/:id/cancel
POST /api/recovery-reminders/:id/mark-reviewed
```

List endpoints use cursor pagination and support status, keyword, and cohort filters. The server calculates unique-person counts and experiment metrics.

Cancellation is allowed only before a confirmed or uncertain public send. It cannot undo an already posted public comment.

## 16. Measurement

### 16.1 Experiment metrics

- Eligible unique people
- Treatment and control sample sizes
- Public replies accepted by Meta
- DM replies within 24 and 48 hours of eligibility
- Guide completions within 24 and 48 hours
- Treatment and control completion rates
- Absolute and relative completion lift
- Median reminder-to-reply time
- Failure and uncertain-outcome rates
- Per-keyword results

Raw counts appear alongside percentages.

### 16.2 Accuracy measurements

1. **Read-event coverage:** among eventual repliers, the share with a prior `messaging_seen` event.
2. **Confirmed delayed-webhook false positives:** events received after the reminder whose Meta timestamp predates the public send.
3. **Recovery response:** reads, replies, and completions after treatment reminders.
4. **Treatment-control difference:** the primary evidence of incremental effect.
5. **Operational accuracy:** duplicate attempts, cooldown suppression, stale leases, failures, and uncertain sends.
6. **Settings-classifier audit:** every structured code/subcode classified as settings-blocked, without raw provider text.

## 17. Observability and privacy

Structured events:

```text
dm_recovery_created
dm_recovery_control_assigned
dm_seen_received
dm_recovery_suppressed
dm_recovery_ready
dm_recovery_claimed
dm_recovery_sent
dm_recovery_sent_late
dm_recovery_send_failed
dm_recovery_send_uncertain
dm_recovery_cancelled
dm_recovery_cooldown_suppressed
dm_recovery_circuit_opened
dm_recovery_circuit_closed
```

Logs may contain identifiers, timestamps, stable reasons, and safe numeric Graph codes. They must not contain access tokens, raw Graph URLs, raw provider errors, full DM contents, private media URLs, or user-authored text.

## 18. Test strategy

### 18.1 Decision-policy unit tests

- Not eligible before ten hours; eligible at exactly ten hours
- No maximum age cutoff
- Matching seen suppresses; unrelated seen does not
- Every inbound DM type suppresses
- Reaction suppresses even after unreact
- Postback and quick reply suppress
- Current or same-keyword completion elsewhere suppresses
- Public comment activity does not count as a DM read
- Manual cancellation suppresses
- Control withholds treatment reminder
- Settings block bypasses timing and control
- One person receives at most one reminder in 24 hours
- Most recent eligible keyword wins for a person
- Missing Meta ID becomes tracking unavailable
- Unknown/transient failures never become settings-blocked

### 18.2 Webhook tests

- Parse seen, reaction, unreact, postback, ordinary message, media, and quick reply
- Preserve suppression after an already-captured inbound message is deleted; ignore an unmatched deletion as read evidence
- Match exact Meta message IDs
- Ignore self-generated and malformed events
- Deduplicate replays
- Preserve delayed Meta timestamps
- Handle unknown outbound IDs safely
- Route each payload to exactly one handler

### 18.3 Gate integration tests

- Persist Meta message ID and local outbound row
- Start clock at acceptance
- Create exactly one source-comment recovery
- Retry private delivery without duplicate recovery creation
- Do not create a tracked waiting record before acceptance
- Accepted response without ID becomes tracking unavailable

### 18.4 Worker tests

- Atomic claim and concurrent-worker exclusion
- Final suppression recheck
- Most-recent-candidate and per-person cooldown
- Overdue processing after downtime
- Oldest-first processing across people
- Pacing and hourly caps
- Safe retry classification
- Expired send lease becomes uncertain
- Ambiguous send is never auto-retried
- Circuit pause and resume
- Late-worker send is recorded

### 18.5 API and frontend tests

- Authentication, validation, filters, cursor pagination, and counts
- Metrics and detail responses
- Valid and invalid cancellation/review transitions
- All filters, badges, tooltip, countdowns, timelines, and banners
- Unique people versus journey counts
- Historical state
- Loading, empty, and error states
- No UI claim of `Unread`

### 18.6 End-to-end scenarios

1. Accepted → seen → suppressed
2. Accepted → inbound reply → completion → suppressed
3. Accepted → ten hours → reminder sent
4. Accepted → outage → reminder sent after recovery
5. Accepted → control → no reminder
6. Verified settings block → immediate fallback
7. Accepted without ID → attention
8. Public send timeout → uncertain, no duplicate retry
9. Multiple keywords for one person → one reminder in 24 hours
10. Delayed pre-send read timestamp → confirmed accuracy incident

## 19. Deployment

1. Apply the additive Prisma migration.
2. Deploy ingestion, persistence, UI, and worker with public sending disabled.
3. Subscribe the Meta app to `messaging_seen`, `message_reactions`, and `messaging_postbacks` in addition to existing fields.
4. Verify real signed webhook samples and exact message-ID correlation.
5. Keep the settings-error allowlist empty until a real response is verified.
6. Enable public reminder sending on the same launch day.
7. Begin the 90/10 two-week experiment.
8. Audit the first records that reach ten hours.
9. Monitor circuit, caps, duplicates, delayed webhooks, and failures.
10. Review treatment versus control after two weeks.
11. Move new records to 100% treatment only after owner review.

The ten-hour waiting period provides time to verify read ingestion before the first public reminder becomes eligible while still making the feature automatic from day one.

## 20. Rollback

The kill switch stops new public sends immediately while ingestion and persistence continue. Pending and historical rows remain intact, existing public comments are not changed, and the additive schema migration is not reversed. After correction, the worker resumes with fresh suppression checks and paced backlog processing.

## 21. Acceptance criteria

The feature is complete when:

- Every new accepted comment-origin gate DM with a Meta message ID gets a durable recovery record, while DM-origin journeys remain excluded.
- Known reads and engagements suppress reminders.
- Eligible treatment users eventually receive one reminder, including after worker downtime.
- No person receives more than one recovery comment in 24 hours.
- Duplicate webhooks and concurrent workers do not create duplicate comments.
- Settings-specific copy is used only for verified settings errors.
- Historical journeys never enter automatic recovery.
- Dashboard language distinguishes evidence from uncertainty.
- Treatment-control results are measurable by unique people and keyword.
- Prisma validation/migration checks, root build/tests, web build/tests/lint, and targeted Playwright scenarios pass.

## 22. Baseline

The isolated worktree baseline was verified before design work:

```text
Test Files  43 passed | 1 skipped (44)
Tests       514 passed | 9 skipped (523)
```

The first test invocation lacked the ignored `.env` file in the new worktree. Re-running with non-secret schema-valid placeholder environment values produced the clean baseline above.
