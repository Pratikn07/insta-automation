# Client operation contracts

Every mutation the console can perform, and what the browser does when it cannot
tell whether that mutation happened.

The rule this document exists to enforce: **an unknown outcome is never retried
automatically.** Once `fetch` has been called the request may have been performed,
so the recovery is always to read the canonical state and find out. A second
attempt is the owner's decision, and only after a canonical read has confirmed the
first one did not land.

Each row names its own canonical read. "Same as the row above" is not allowed —
two routes that look alike can be proved by different reads, and a generic
invalidation is how a false "done" reaches the screen.

## How to read the columns

- **Business key** — what makes two requests the same request. A client UUID for
  creates; the entity's own identity for everything else.
- **Canonical read** — the request whose result decides what actually happened.
- **Proves success** — the specific field or state that settles it. Not "a 200".
- **Same-key retry** — whether the owner may repeat the operation unchanged, and
  on what evidence.

---

## Entity creates

Keyed by a UUID the browser mints when the attempt begins (`useOperationId`) and
sends in both the body and `Idempotency-Key`. The route answers `201` for a
genuine create, `200` with the stored row for an exact replay, and `409
idempotency_conflict` when one key was reused for two different intents.

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /resources` | Sequences, Keyword Form | body `id` | `GET /resources` | a row with that `id` | Yes — the route itself is the reconciliation; a replay returns the row. |
| `POST /keywords` | Keyword Form | body `id` | `GET /keywords` | a row with that `id` | Yes. An active exact replay re-enqueues the idempotent backfill. |
| `POST /messages` | Sequence Editor | body `id` | `GET /messages/by-resource/:resourceId` | a step with that `id` | Yes. `order` is server-assigned and excluded from the replay comparison. |
| `POST /insights/experiments` | Insights | body `id` | `GET /insights/experiments` | an experiment with that `id` | Yes. A replay never re-measures `baselineUsPct`. |
| `POST /upcoming-automations` | Content, upcoming setups | body `id` | `GET /upcoming-automations` | a row with that `id` | Yes. `triggerWord` is compared after normalization, so a differently cased repeat is the same create. A `409 upcoming_keyword_reserved` is a **different** open setup owning that word — a definite refusal, not an unknown. |

## Entity patch, delete and reorder

No client key: the entity's own id is the identity, and these operations are
idempotent in effect. The canonical read compares the *intended* fields, because a
200 that was never received is indistinguishable from one that was.

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `PATCH /resources/:id` | Sequence Editor | resource id | `GET /resources/:id` | `name` equals the intended name | Yes — reapplying the same name is a no-op. |
| `DELETE /resources/:id` | Sequences | resource id | `GET /resources` | the id is absent | Yes. A second delete of an absent row is harmless; a `409 resource_has_delivery_history` is a definite refusal, not an unknown. |
| `PATCH /keywords/:id` | Keywords (active toggle), Keyword Form | keyword id | `GET /keywords` | the row's fields equal the intended ones | Yes. |
| `DELETE /keywords/:id` | Keywords | keyword id | `GET /keywords` | the id is absent | Yes. |
| `PATCH /messages/:id` | Sequence Editor | message id | `GET /messages/by-resource/:resourceId` | `body`/`mediaUrl` equal the intended values | Yes. |
| `DELETE /messages/:id` | Sequence Editor | message id | `GET /messages/by-resource/:resourceId` | the id is absent | Yes. |
| `POST /messages/reorder/:resourceId` | Sequence Editor | resource id + the submitted id list | `GET /messages/by-resource/:resourceId` | the returned `order` sequence matches the submitted list | Yes — the request states the whole desired order, so reapplying it converges. **Never roll back to the pre-drag order after an unknown outcome**: the reorder may have landed, and a rollback would then undo it. |
| `PATCH /insights/experiments/:id` | Insights | experiment id | `GET /insights/experiments` | `status`/`conclusion` equal the intended values. `measure: true` is **not** idempotent — it re-reads the current US% into `measuredUsPct`, so an unknown outcome must be reconciled by reading, never by repeating. | Only for status/conclusion edits. Never for `measure`. |
| `PATCH /upcoming-automations/:id` | Content, upcoming setups | setup id | `GET /upcoming-automations` | the row's fields equal the intended ones | Yes. The write is `updateMany` fenced on `status IN (waiting, needs_attention)`, so a setup that bound between the read and the write answers `409 upcoming_automation_resolved` instead of editing a row the worker already resolved. |
| `PATCH /flags/:key` | Things we're testing | flag key | `GET /flags` | the row's `valueBool` / `valuePercent` equals the intended value, and `source` reads `override` | Yes — reapplying the same value is a no-op upsert. Two 403s are **definite refusals, not unknowns**: `flag_enable_not_permitted` means that flag can only be switched on by a deploy, and `flag_not_controllable` means it offers no console control at all. Neither should be retried. The route refreshes the cache before answering, so the value it reports is the value the workers will read. |
| `POST /upcoming-automations/:id/cancel` | Content, upcoming setups | setup id | `GET /upcoming-automations` | the row is absent from the list, or present as `cancelled` | Yes. Fenced the same way; `409 upcoming_automation_resolved` means binding won the race, which is a definite answer. Note the canonical read stops returning `cancelled` rows 24h after `cancelledAt`, so **absence is only proof once the row has been seen as cancelled** — an absent id alone could equally be an expired receipt. |
| `POST /upcoming-automations/:id/retry` | Content, upcoming setups | setup id | `GET /upcoming-automations` | `status` is `waiting` and `errorCode` is null | Yes. A second retry against an already-`waiting` row answers `409 upcoming_automation_not_retryable` — a definite refusal, not an unknown. Retry only clears local lifecycle fields; it sends nothing and contacts no one. |

## Recovery actions

These publish public comments to real people. The server's state transition is
authoritative; the browser never infers one.

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /recovery-reminders/:id/cancel` | DM Recovery list, drawer | reminder id | `GET /recovery-reminders/:id` plus the list and counts | `status` is `cancelled` | No automatic retry. Unchanged state is **not** absence while the first request may still be executing. |
| `POST /recovery-reminders/:id/mark-reviewed` | DM Recovery list, drawer | reminder id | `GET /recovery-reminders/:id` | `reviewedAt` is set | No automatic retry. |
| `POST /recovery-reminders/settings-verifications/:id/activate` | DM Recovery list | verification id | `GET /recovery-reminders/settings-verifications` plus metrics | the record's active state | No automatic retry. |
| `POST /recovery-reminders/settings-verifications/:id/retire` | DM Recovery list | verification id | `GET /recovery-reminders/settings-verifications` | the record is retired | No automatic retry. |

## Historical campaign actions

A campaign action can dispatch hundreds of public comments. Sealed state and
stable ids are the proof; an HTTP timeout is never grounds to repeat one.

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /historical-recovery/campaigns/:id/:action` (start, pause, resume, stop, approve) | Historical Recovery | campaign id + action | `GET /historical-recovery/campaigns` | the campaign's `state` is the action's target state | **No.** Never repeat a start or approve because the request timed out. |
| `POST /historical-recovery/campaigns/:id/stage` | Historical Recovery | campaign id + stage caps | `GET /historical-recovery/campaigns` | the stored caps equal the submitted caps | Only after a read shows the caps unchanged **and** the campaign is not running. |
| `POST /historical-recovery/rollout-groups/:id/pause` | Historical Recovery | rollout group id | `GET /historical-recovery/campaigns` | every campaign in the group is paused | Yes — pausing an already-paused group is a no-op, and pausing is the safe direction. |
| `POST /historical-recovery/candidates/:id/mark-reviewed` | Historical Candidate Drawer | candidate id | `GET /historical-recovery/candidates/:id` | `reviewedAt` is set | No automatic retry. |

## AI draft actions

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /ai/dm-threads/:threadId/drafts` | DM Thread Drawer | thread id + latest inbound id | `GET /dm-threads/:threadId` | a draft exists for the current `latestInboundMessageId` | Yes — the server coalesces on that key and returns the existing draft rather than making a second. |
| `PATCH /ai/dm-threads/:threadId/drafts/:id` | DM Thread Drawer | draft id | `GET /dm-threads/:threadId` | `workingText` equals the intended text | Yes. |
| `POST .../regenerate` | DM Thread Drawer | prior draft id | `GET /dm-threads/:threadId` | a draft with a higher `revision` | **No.** A second regenerate spends another model call and supersedes the draft the first one produced. |
| `POST .../dismiss` | DM Thread Drawer | draft id | `GET /dm-threads/:threadId` | the draft's status is dismissed | Yes. |
| `POST .../approve` | DM Thread Drawer | draft id | `GET /dm-threads/:threadId` | the draft's status left `pending_approval` (`sent`, `send_failed`, or `send_uncertain`) | **No.** This is the route that puts a message in front of a real person. Never resend approved text because the response was lost; a `send_uncertain` draft is resolved by the retry-send action with its own confirmation. |
| `POST .../retry-send` | DM Thread Drawer | draft id | `GET /dm-threads/:threadId` | the draft's status left `send_uncertain` | **No.** Requires the owner's explicit `confirmedNotDelivered`. |

## Advisor

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /ai/advisor/messages` | Assistant | `clientMessageId` | `GET /ai/advisor/history` | a turn with that `clientMessageId` carrying a parsed response | Yes, **with the same key**. The key belongs to the question, not the click: it is reused while that question is still in the composer, so the runtime recognises a replay instead of spending a second turn. `409 advisor_outcome_pending` means wait and re-read; `409 idempotency_conflict` means the key was reused for different text. The composer stays locked while the key is unresolved. |

## AI connection

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /ai/connection` | AI Connection Card | none (device login) | `GET /ai/connection` | `connected` is true | **No.** Never start a second login while the first is unresolved — it would issue a second device code and invalidate the one the owner is typing. |
| `POST /ai/disconnect` | AI Connection Card | none | `GET /ai/connection` | `connected` is false | Yes — disconnecting twice is a no-op. |

## Upload

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /upload/sign` | Media Upload | body `id` | — the route is pure derivation: the same id yields the same `kind/<uuid>.<ext>` path | the returned `path` | Yes. |
| `PUT <signed storage URL>` | Media Upload | the upload id, which owns exactly one object path | `HEAD <publicUrl>` | `200` whose `content-length` equals the file size and whose `content-type` matches | Only after a **confirmed 404**. A failed HEAD is `still_unknown`, never absence; a 200 with a different size is `mismatched`. |

## Analysis enqueue

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /insights/reels/:mediaId/analyze` | Insights | media id | `GET /insights/reels/:mediaId` | the reel's job state moved, or a profile exists | Yes — the media id is the key, and a repeated pending state is the same job, not a second one. |

## Guide owner review

| Route | Callers | Business key | Canonical read | Proves success | Same-key retry |
| --- | --- | --- | --- | --- | --- |
| `POST /guide-deliveries/:deliveryId/units/:unitId/confirm-delivered` | Guide Delivery Review Card | delivery id + unit id | `GET /dm-threads/:threadId` | the unit's status is `sent` | Yes — confirming twice is a local no-op. |
| `POST /guide-deliveries/:deliveryId/units/:unitId/retry` | Guide Delivery Review Card | delivery id + unit id | `GET /dm-threads/:threadId` | the unit left `uncertain` | **No.** Requires the literal `{ "acknowledgeDuplicateRisk": true }` each time, because this is the action that can put a second copy on a real person's phone. |
| `POST /guide-deliveries/:deliveryId/cancel` | Guide Delivery Review Card | delivery id | `GET /dm-threads/:threadId` | the delivery is absent from `deliveryReviews` | Yes — cancelling an already-cancelled delivery is idempotent server-side. |

---

## Enforcement

- No production code calls a generic `api()`. Every call is visibly `apiRead` or
  `apiMutation`, so the read/write distinction is legible at the call site.
- `mutations: { retry: false }` is set globally in `main.tsx`. No component may
  raise it.
- `apiMutation` classifies by dispatch phase: before `fetch` a failure is
  `MutationNotDispatchedError` and safe to repeat; after `fetch` it is
  `MutationOutcomeUnknownError` and is not.
- A `5xx` counts as unknown even though it is a response. Only a definite `4xx` or
  a success settles the question.
