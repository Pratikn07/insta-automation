# Guide Message Limits and Resumable Delivery Design

## Context

Instagram rejects an individual text message above 1,000 characters. The guide
editor currently gives the author no character count, and the messages API
accepts bodies up to 2,000 characters. `sendSequence` discovers an invalid body
only after delivery has started, so an earlier guide step can succeed before a
later step is rejected.

The sequence sender also has no durable per-send checkpoint. If Meta accepts an
early step and a later step fails, a retry starts the sequence again. If the
process is replaced after Meta accepts a message but before local completion is
recorded, the conversation can remain incomplete even though some or all of the
guide reached the recipient.

## Goals

- Make Instagram's 1,000-character limit visible while an author edits every
  text body or media caption.
- Keep message boundaries under the author's control so each DM is coherent on
  its own.
- Reject invalid guide content before the first outbound send.
- Resume a multi-message delivery without resending steps already confirmed by
  Meta.
- Treat an ambiguous provider outcome conservatively instead of risking an
  automatic duplicate.
- Mark a conversation complete only after every outbound unit in that delivery
  is confirmed.

## Non-goals

- Do not split, truncate, or rewrite an author's text automatically.
- Do not promise exactly-once delivery across the external Meta API boundary.
- Do not add follow-gate rechecking in this change. Follow recovery is a
  separate feature and must use the delivery machinery designed here when it is
  implemented.
- Do not modify existing guide prose automatically during rollout.

## Decisions and Rejected Alternatives

### Chosen: author-controlled boundaries plus backend enforcement

An author may type past the limit locally so pasted or legacy content remains
visible and editable, but an over-limit step cannot be saved. The UI tells the
author to shorten the step or add another Text step. The API independently
enforces the same limit.

### Rejected: automatic splitting

Splitting at a character, sentence, or paragraph boundary can still separate a
qualification, warning, link, or call to action from the statement it belongs
to. Authors must decide where one message ends and the next begins.

### Rejected: UI-only validation

The UI is not the only write path. Existing rows, scripts, imports, and direct
API callers could still create or deliver invalid content without server-side
validation.

### Rejected: retrying the entire sequence

Repeating confirmed steps can confuse or annoy recipients. Delivery retries
must begin at the first unit that is known not to have been delivered.

## Authoring Experience

The existing sequence editor remains step-based. No new composition model is
introduced.

For the `body` field on Text, Image, and PDF steps:

- Show a live `current / 1,000` character count below the textarea.
- Count Unicode code points, as `[...value].length`, in the web app and API alike,
  so one shared definition decides the limit and the UI can never accept text the
  server rejects. An emoji or other astral character counts once, not twice — a
  UTF-16 code-unit count would have charged it double.
- Use the normal counter below 900 characters, a warning treatment from 900 to
  1,000, and an error treatment above 1,000.
- Above 1,000, show: **“Instagram allows 1,000 characters per message. Shorten
  this message or add another Text step.”**
- Do not run the blur-save mutation while the local body is over the limit.
- Keep the complete local draft in the textarea so the author can edit it down
  or move part of it into a new step.
- Show the sequence save status as needing attention while any step is invalid;
  do not show “All changes saved.”
- Keep the phone preview faithful to authored steps. It must not display an
  automatic split that will not exist at delivery time.

Exactly 1,000 code points is valid. Empty-body and media requirements retain
their existing behavior.

## API Validation

Define one shared limit constant for guide text and apply it to both message
creation and update validation. This replaces the current 2,000-character API
limit.

- `POST /messages` rejects a `body` above 1,000.
- `PATCH /messages/:id` rejects a `body` above 1,000.
- The response uses a stable application error such as
  `message_body_too_long` and includes `limit` and `actual` numeric fields.
- Text bodies and optional Image/PDF captions use the same rule because every
  caption is sent as a separate text DM after its media.
- The server never truncates submitted content.

The web app maps `message_body_too_long` to the same inline guidance rather than
showing a generic save-failed toast.

## Delivery Preflight

Before sending any part of a guide, compile the authored resource messages into
the actual ordered Meta send units:

- Text step: one text unit.
- Image step: one image unit and, when present, one caption text unit.
- PDF step: one file unit and, when present, one caption text unit.

Validate the complete compiled plan before the first Graph call. Every text unit
must be non-empty where required and no longer than 1,000 code points; every
media unit must have a usable URL. If any unit is invalid:

- Send nothing from that delivery.
- Leave the conversation incomplete.
- Record a configuration failure containing IDs, unit type, and measured length,
  never private message text.
- Surface the invalid guide to the owner as needing author attention.

This preflight protects against legacy rows and write paths that did not pass
through the current API.

## Durable Delivery Model

Persist a delivery and its compiled send units before the first external call.
The names below are descriptive; the implementation plan may adapt them to
existing repository conventions without changing their contracts.

### `guide_deliveries`

- `id`
- `conversation_id`
- `trigger_kind`: inbound reply, follow recovery, or explicit redelivery
- `trigger_id`: the durable inbound/recovery identifier
- `resource_id`
- `status`: `planned`, `sending`, `completed`, `failed`, or `needs_review`
- claim/lease fields for exclusive processing
- created, started, completed, and updated timestamps
- unique idempotency key across `trigger_kind` and `trigger_id`

The trigger key permits an intentional later redelivery while collapsing
replays of the same inbound webhook or recovery job.

### `guide_delivery_units`

- `id`
- `delivery_id`
- source `resource_message_id`
- stable ordered unit number
- unit kind: text, image, or file
- snapshotted text or media URL used for this delivery
- content fingerprint for audit and comparison
- `status`: `pending`, `sending`, `sent`, `failed`, or `uncertain`
- provider message ID when Meta returned one
- attempt count and allowlisted provider error fields
- claimed, sent, and updated timestamps
- unique constraint across delivery and unit number

One authored Image or PDF step can produce two delivery units. Checkpointing at
the unit level prevents an accepted image from being resent merely because its
caption failed.

Snapshotting makes a delivery deterministic: editing the guide after a delivery
starts affects future deliveries, not the in-progress one.

## Delivery State Machine

1. Atomically get or create the delivery by its trigger idempotency key.
2. Compile, validate, and persist the complete ordered unit snapshot.
3. Claim the delivery with a bounded lease so only one process can send it.
4. Process units in order:
   - Skip `sent` units.
   - Move a `pending` or retryable `failed` unit to `sending` before calling
     Meta.
   - When Meta returns success, store the provider message ID and mark the unit
     `sent`.
   - When Meta definitively rejects the request, mark the unit `failed`, store
     allowlisted error metadata, classify it as transient or permanent, and stop
     the sequence.
   - When the result is ambiguous because of a timeout, connection loss, or
     process interruption, mark or reconcile the stale `sending` unit as
     `uncertain`, move the delivery to `needs_review`, and stop.
5. When and only when every unit is `sent`, run the existing conversation
   completion, follow-up scheduling, thread-resolution, and
   `sequence_completed` bookkeeping once, then mark the delivery `completed`.

A reconciliation tick also finalizes any delivery whose units are all `sent`
but whose delivery or conversation completion was interrupted. It performs no
Graph send in that case; it only completes the remaining idempotent bookkeeping.

The database transaction cannot include the external Meta send. A process can
therefore die after Meta accepts a message but before `sent` is recorded. The
`uncertain` state makes that boundary explicit. It must never be silently
treated as either delivered or safe to retry.

## Retry and Review Behavior

- Retry only a transient unit failure with a definitive rejection that indicates
  no message was accepted, using bounded attempts and backoff while the messaging
  window is open.
- Permanent failures such as invalid content are not retried. They remain failed
  until the author corrects the underlying guide and starts a new delivery.
- Never auto-retry an `uncertain` unit.
- A stale `sending` lease becomes `uncertain`, not `pending`.
- The owner sees `Delivery needs review`, the number of confirmed units, the
  uncertain unit, and the remaining units in the conversation surface.
- After checking the Instagram thread, the owner may choose one explicit action:
  - **Already delivered:** mark the uncertain unit confirmed and resume the
    remaining units.
  - **Retry unit:** acknowledge the duplicate risk and retry that unit.
  - **Cancel delivery:** stop without marking the conversation complete.
- If the messaging window has closed, resume/retry actions are disabled and the
  owner is told that fresh inbound contact is required.

Owner decisions must be audited with actor, action, delivery/unit IDs, and
timestamp. They must not copy private message text into logs.

## Existing Over-limit Content

Rollout starts with a read-only audit of all resource-message bodies. Existing
over-limit rows are not split or truncated automatically.

- The sequence list and editor mark each affected guide as needing attention.
- The author must rewrite or manually divide the content into meaningful steps.
- A legacy invalid guide remains protected by delivery preflight, which sends
  none of it rather than allowing a predictable partial delivery.
- The known active 1,434-character step must be corrected by an author before
  relying on its guide automation.

## Observability

Record aggregate-safe events for:

- delivery planned and preflight rejected
- unit claimed, sent, definitively failed, or uncertain
- delivery completed or moved to review
- owner resolution of an uncertain unit
- retry skipped because the messaging window closed

Logs and events include IDs, unit position/type, lengths, provider status/code,
and timestamps. They exclude access tokens, URLs containing credentials,
request bodies, and private guide text.

Operational views should distinguish:

- recipient received the entire guide
- delivery is safely retryable
- partial delivery needs owner review
- invalid authored content prevented any send

## Testing

### Authoring UI

- Counter is correct below, at, and above 1,000.
- Warning begins at 900; exactly 1,000 remains saveable.
- Over-limit blur does not call the update API and does not discard the draft.
- Save status cannot claim all changes are saved while a step is invalid.
- Guidance tells the author to shorten the message or add another Text step.
- Image/PDF captions receive the same validation.
- Query refetches do not overwrite an invalid local draft.

### API

- Create and update accept 1,000 and reject 1,001.
- UI and API use the same conservative counting behavior for surrogate pairs.
- The stable error payload contains no submitted message text.

### Delivery preflight

- A later invalid unit prevents every Graph call, including earlier valid units.
- Text, media, and optional captions compile into the correct ordered units.
- Missing media and over-limit legacy bodies fail before sending.

### Checkpoint and recovery

- A retry skips confirmed units and resumes at the first failed unit.
- A media unit is not resent when only its caption failed.
- Replaying the same trigger creates one delivery and cannot run two senders.
- A stale `sending` unit becomes `uncertain` and is not automatically retried.
- A definite rejection follows bounded retry policy.
- Completion bookkeeping runs once and only after all units are confirmed.
- Owner `Already delivered`, `Retry unit`, and `Cancel delivery` actions follow
  their state and audit contracts.
- Closed-window deliveries cannot resume automatically.

## Rollout

1. Audit existing over-limit rows and have the author correct active content.
2. Add the durable delivery schema and state-machine tests.
3. Add preflight and route all guide sends through the delivery service.
4. Add the editor counter, inline validation, stable API error, and invalid-guide
   indicators.
5. Add the owner review surface for uncertain deliveries.
6. Verify with controlled text-only and media-plus-caption deliveries, including
   a forced failure after an earlier confirmed unit.
7. Monitor preflight failures, uncertain units, duplicate-trigger collapses, and
   completed deliveries before using this delivery service from follow recovery.

## Success Criteria

- No guide text or caption above 1,000 is accepted through the supported API.
- No invalid legacy guide begins delivery.
- Authors, not software, decide message boundaries.
- Confirmed units are never resent by an automatic retry.
- An ambiguous send is visible and requires an explicit owner decision.
- A conversation is marked complete only when every planned delivery unit is
  confirmed sent.
