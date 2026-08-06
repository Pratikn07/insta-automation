# Expired DONE Recovery Design

## Problem

An inbound Instagram message opens a new 24-hour Meta messaging window, but the
automation only looks for conversations whose internal 48-hour gate window is
still active. When a person replies `DONE` after that internal window expires,
the handler treats the message as unrelated and never reaches the existing
follower check. Confirmed non-followers therefore receive neither the guide nor
the reminder to follow.

## Approved Behavior

- Keep the current flexible any-reply behavior for an active gate.
- When no active gate exists and the inbound text is exactly `DONE`
  (case-insensitive, with the punctuation already accepted by `DONE_RE`), recover
  that user's most recent incomplete conversation, including an expired one.
- Run the recovered conversation through the existing delivery policy:
  - `isFollower === false`: send the existing follow-required reminder, re-arm
    the conversation, and withhold the guide.
  - `isFollower === true` or `null`: deliver the guide using the existing path.
- Do not recover expired conversations for arbitrary text, attachments, or new
  keyword messages.
- Preserve the existing completed-keyword redelivery behavior and idempotent
  inbound-message handling.

## Design

Add a conversation-service query that returns the newest conversation for an
Instagram user whose state is either `awaiting_done` or `expired`, without an
age cutoff, with the same keyword/resource/message graph used by the active
query. The message handler first performs the existing active-gate lookup. Only
when it returns `null` and `DONE_RE` matches does it call the recovery query.

This keeps recovery narrow: a normal DM cannot unexpectedly unlock an old
guide, while an explicit `DONE` uses the fresh Meta window to resume the user's
latest unfinished request. The recovered row passes through the existing
follow gate. If the user is not following, `markGated` changes an expired row
back to `awaiting_done` and starts a fresh internal gate window from the
successfully sent reminder.

## Failure Handling and Observability

Use the existing send, completion, failure logging, and thread-resolution paths.
Add recovery context to the `done_received`/logging path only if it is useful for
distinguishing recovered requests; do not log private message text.

If sending the follow reminder fails, leave the expired conversation unchanged.
If guide delivery fails, do not mark the conversation complete. Existing Meta
message idempotency continues to prevent duplicate webhook processing.

## Tests

- Service test: recovery selects the newest `awaiting_done` or `expired`
  conversation with no time cutoff.
- Handler test: exact `DONE` with no active gate recovers the expired request and
  sends the follow reminder to a confirmed non-follower without delivering the
  guide.
- Handler test: exact `DONE` recovery delivers to a follower.
- Handler test: arbitrary text with no active gate does not recover an expired
  request.
- Run the focused handler/service tests, the full test suite, and the TypeScript
  build.
