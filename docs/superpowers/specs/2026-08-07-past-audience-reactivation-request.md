# Feature request: reactivate the past audience

**Status:** request — not designed, not scheduled
**Raised:** 2026-08-07
**Relates to:** DM Recovery Reminders (`feat/instagram-read-recovery-reminders`)

## What we want

Reach people who commented a keyword, received the gate DM, and never replied
`DONE` — including journeys from a month or more ago — by posting a public reply
on their original comment to bring them back.

## Why the recovery feature does not already do this

DM Recovery Reminders is strictly forward-looking. A `dm_recovery_reminder` row is
created at gate-send time, from exactly two call sites — `commentHandler` and
`gateQueueWorker` — waits `DM_RECOVERY_DELAY_HOURS` (default 10), then posts or is
suppressed. There is no backfill script and no path that constructs a row for a
journey that already happened.

Classifying the whole audience does not unlock this. Even with every user
classified, nothing creates a reminder for a past journey.

## The audience, measured 2026-08-07

| Conversation state | Total | ≤7d | 7–30d | >30d |
|---|---|---|---|---|
| `expired` — got the DM, never replied `DONE` | 2,304 | 429 | 623 | 1,252 |
| `completed` | 1,734 | 546 | 472 | 716 |
| `awaiting_done` | 265 | 265 | 0 | 0 |

`awaiting_done` never exceeds 7 days — journeys age into `expired`. So the target
population is the 2,304 `expired` rows, of which 1,875 are older than 7 days.

## Blocking unknown — settle this before anything else

**Can Instagram accept a public reply to a 30-day-old comment?**

Private replies have a documented 7-day window. For public replies via
`POST /{ig-comment-id}/replies`, Meta documents only two restrictions: top-level
comments only, and not hidden comments. No age limit is documented — but absent
documentation is not confirmation.

Cheapest possible test: take one `expired` conversation from ~30 days ago,
resolve its comment ID from `event_log`, and attempt a single public reply. If
that fails, this feature is not possible in this form and nothing else here
matters.

## What it would need

1. **Comment ID recovery.** `conversations` has no `comment_id` column. The link
   exists only in `event_log` `comment_received` payloads and `gate_queue`. A
   reactivation pass has to reconstruct it, the way `backfill-keywords.ts` does —
   but that only looks back 7 days, so its window would have to widen.
2. **Liveness check.** The comment may be deleted. Error code 100 covers deleted,
   expired, and already-replied comments indistinguishably, so a failure cannot be
   interpreted — see `docs/meta-verification.md`.
3. **Eligibility rules.** Which of the 2,304 qualify, and on what evidence.
4. **Idempotency.** Must never post twice to one comment, across reruns. The
   recovery feature gets this from a unique `comment_id` on the reminder row; a
   reactivation pass needs its own equivalent.
5. **Pacing.** At the existing 30/hour cap, 1,252 people is roughly 42 hours of
   continuous public commenting on our own older posts.
6. **Reuse rather than rebuild.** The audience filter, person cooldown, circuit
   breaker, and the DM recovery dashboard lens all apply and should not be
   duplicated.

## Risks to weigh during design

- **Visibility.** This is a large volume of public comments on older posts, all
  from us, concentrated in time.
- **The premise weakens with age.** Read recovery rests on "you probably never saw
  it." A DM sent a month ago was most likely seen and ignored, so the same message
  is a materially different proposition — the copy should not be reused unchanged.
- **No measurement unless designed in.** The recovery feature earns its lift
  numbers from a 90/10 holdout. A reactivation pass without one produces activity,
  not evidence.

## Recommended sequencing

Ship DM Recovery Reminders first. It starts working on the 265 live journeys
immediately and produces real conversion numbers from the holdout. Decide on the
2,304 backlog with that evidence in hand, rather than committing 42 hours of
public comments to find out whether a public nudge converts at all.
