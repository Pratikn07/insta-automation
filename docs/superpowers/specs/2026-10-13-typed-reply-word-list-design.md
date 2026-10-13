# Typed replies and keyword DMs: which words start a guide

Status: approved 2026-10-13. Owner: Pratik.

## Problem

Two places turn a typed DM into a guide, and both were wrong in opposite directions.

**Replies to an open card are too strict.** Since the DM intent guard went live
(2026-09-16, `enforced: true` on every evaluation), a typed reply to an open card counts
only if the whole message is exactly one of 12 phrases (`CONFIRMATION_PHRASES` in
`src/services/dmGuideIntent.ts`). Anything else goes to owner review and nothing is sent.
In the 30 days to 2026-10-13, 367 replies landed there. About 55 a month were plain yeses
the list missed: "yes send it" / "yes, send it" (20), "yes pls" / "yes plz" (12),
"following" / "i follow" (8), misspelled "done" such as "doen" or "fone" (~8),
"yes send it here", "yes thanks", "sure", "ok".

**Keyword DMs are too loose.** A DM containing a guide keyword starts the guide flow if it
has 3 or fewer distinct words, or any request word (send, share, get, give, want, need). In
the same 30 days that started 101 guide flows. Every real parent ask but one was 20 words or
fewer; the exception was 43 words. Above 40 words, 10 of 11 were brand pitches or promotions ("we're always looking for new
partnerships…", "Hi! I'm Kylie — I make educational printables…") that matched only because
they mentioned a keyword and a word like "get".

## Decisions

### 1. Typed reply to an open card

Normalize the reply as today (uppercase, strip punctuation and emoji, split on whitespace).
It is a confirmation when ALL of these hold:

- it is text and not blank;
- the raw text contains no `?`;
- no token is a negation: `NO`, `NOT`, `DONT`, `NOPE`, `NAH`;
- it STARTS with a lead phrase from the list below;
- every token after the lead phrase is in the filler list.

Lead phrases (longest match first):

| Group | Phrases |
|---|---|
| Yes | `YES`, `YEP`, `YEAH`, `SURE`, `OK`, `OKAY`, `SEND IT`, `PLEASE SEND`, `SEND` |
| Done / follow | `DONE`, `DOEN`, `FONE`, `DOME`, `FOLLOWED`, `FOLLOWING`, `I FOLLOW`, `I FOLLOWED`, `I AM FOLLOWING`, `IM FOLLOWING`, `READY` |

Filler list: `PLEASE`, `PLS`, `PLZ`, `THANKS`, `THANK`, `YOU`, `U`, `THX`, `TY`, `SEND`, `IT`,
`HERE`, `NOW`, `ME`, `SO`, `MUCH`.

Every phrase in today's `CONFIRMATION_PHRASES` still passes, so nothing that works today
stops working. "Thank you" and "please" on their own still go to owner review (owner's
decision: they are not literally a yes).

| Passes | Goes to owner review |
|---|---|
| yes, send it · yes pls · yes send it here please · yes please thank you · yes thanks · sure · ok · done · doen · i follow · im following | thank you · please · yes but is it dairy free? · yes please send it to my email · following up on my order · can i use almond flour · an email address · another business's auto-reply |

### 2. DM that mentions a keyword

Today's rule stays. New check, right after the no-keyword case (so a long DM with no
keyword still logs as `no_keyword`): more than 30 distinct words (the same
`meaningfulTokens` count the guard already logs as `meaningfulTokenCount`) returns a new
kind, `rejected_long`, and goes to owner review. It is logged in `dm_guide_intent_evaluated`
like the other kinds, so the number of pitches stopped is visible.

### 3. Unchanged

- What happens after an accepted reply: the follow check, the follow wall for non-followers,
  the guide for followers. A typed yes reaches the same place as a tap.
- Routing in `messageHandler.ts`. It already treats any kind without a `selected` keyword
  as not accepted, and any non-confirmation reply as owner review.
- No feature flag. The guard is already enforced in production; this narrows and widens
  its rules.

### 4. No backfill

The 132 cards (123 people) in the Funnels "wrote to us, not counted" bucket cannot be re-sent:
Instagram allows a reply only within 24 hours of their last message. The fix applies from
the deploy onward.

## Testing

Unit tests in `src/services/dmGuideIntent.test.ts`, written first, using the real
production phrases above: every "passes" example must be accepted, every "owner review"
example must be rejected, every phrase in the old `CONFIRMATION_PHRASES` must still pass,
and a 31-distinct-word DM with a keyword and a request word must return `rejected_long`
while a 30-word one keeps today's result.

## How we will know it worked

After a week in production, from `dm_guide_intent_evaluated`:
`replyRejectionReason = unrecognized_text` should fall from ~367 a month by roughly 55, and
`replyClassification = accepted_confirmation` should rise by about the same.
`keywordClassification = rejected_long` should be about 10 a month.
