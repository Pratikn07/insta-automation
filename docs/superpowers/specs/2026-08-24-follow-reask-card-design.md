# The follow re-ask card

**Date:** 2026-08-24
**Status:** approved by owner, ready to implement

## The defect

A parent comments `DINNER`, gets the opening card, taps its button, and the gate card
arrives: *"Follow @tinysoho for more ideas like this, then tap below and I'll send it over."*
Correct. They then tap **Send the recipes** on that gate **without following**, Meta answers
definitively that they are not a follower, and we send:

> Almost there 💛 Instagram may take a moment to update. Check that you're following
> @tinysoho, wait a little, then tap I'm following once more.

That message tells someone who never followed that they *did* and merely needs patience. It
apologises on Instagram's behalf for something the parent did not do, and it invites them to
sit in a loop waiting for a propagation delay that is not happening.

Observed on the owner's own account, 2026-08-24 14:23:29 UTC, attempt
`3922fb7a-d772-4e7b-9bcc-b95c77b5aa4b`. The gate went out at 14:23:18 and the tap came 11
seconds later — no one leaves Instagram, follows an account, and returns inside 11 seconds.

## Why it happens

There is no validation behind the choice of words. One line decides it:

```ts
falseResponse: action === "check_follow" ? "lag" : "gate"
```

That reads *"this is their second tap"*, not *"we have reason to believe they followed"*.
The distinction is already **recorded** — `recheck: not_confirmed` is a different metric
stage from `fresh_check: non_follower`, and the code comment beside it says so outright:
*"still not following after telling us they had" is a different fact from "was not following
when they asked"*. It is recorded and then ignored when choosing what to say.

Meta's answer is not ambiguous either. `resolveFollowStatusFresh` is a live, uncached Graph
call to `is_user_follow_business` returning a real boolean, and "could not reach Meta" is a
**separate** third outcome that already has its own copy (`guideAccessCopy.unavailable`). So
on this branch Meta told us plainly: not following. The hedge is doubt we invented.

For contrast, V1 — the path carrying ~1,043 gates/week — has no lag copy at all. It re-asks.
This hedge exists only in V2, which before 2026-08-24 had never executed in production.

## The signal we already have and discard

`reserveFollowResponse` returns `responseNumber: 1 | 2`, derived from
`guide_access_attempt.follow_response_count`, durable, and already capped at
`MAX_FOLLOW_RESPONSES = 2` before the attempt goes to owner review. The gate itself does not
reserve a response — only the lag branch does — so `responseNumber === 1` is exactly "first
re-tap after the gate".

`handleNonFollower` checks that the reservation succeeded and never reads the number.

## Design

### Escalation

| Tap | Meta says | Message |
| --- | --- | --- |
| 1st re-tap (`responseNumber` 1) | not following | **new re-ask card** — "One step left 💛" |
| 2nd re-tap (`responseNumber` 2) | not following | existing `followLag` copy, unchanged |
| 3rd (`limit_reached`) | not following | owner review, unchanged |

Most likely explanation first, benefit of the doubt second. A parent who genuinely hit a
propagation delay is not accused — they are asked to try once more, and the second message is
the sympathetic one. A parent who simply did not follow is told what to do while the guide is
still fresh in mind.

`unavailable` is untouched. This changes only the branch where Meta gave a definite `no`.

### Copy

Owner-selected direction, 2026-08-24. It states the situation without asserting what the
parent did, so it is safe for both the never-followed and the genuine-delay case.

- **Card title:** `One step left 💛`
- **Card subtitle:** `Follow @tinysoho for more ${noun} like this, then tap I'm following.`
- **Text fallback:** `Follow @tinysoho for more ${noun} like this, then reply DONE and I'll send it over.`

The subtitle earns its keep twice: the reason to follow (*more recipes like this*) and the
exact action. The re-ask is the message that has to sell the follow, not merely repeat the
demand — which is why it carries the cover and a profile button rather than being a nudge.

### Category nouns

Following the existing `GUIDE_GATE_CATEGORY_ACTION_LABELS` pattern, so the card reads authored
rather than templated:

| Category | Noun |
| --- | --- |
| `recipes` | recipes |
| `bedtime` | bedtime wins |
| `potty-training` | potty steps |
| `montessori-activities` | activities |
| unknown / absent | ideas |

Subtitle length is `61 + len(noun)`, so the longest ("bedtime wins") is 73 — inside Meta's
80-character subtitle cap with headroom. Asserted in tests for every noun, because an
81-character string is exactly what bit `nonFollowerGateText`.

An unknown category resolves to "ideas" rather than throwing. A copy lookup must never be able
to cost a parent their guide.

**No counts in the copy.** "29 more recipes" is true today (RECIPES 30, SLEEP 7, POTTY 4,
LEARNING 4 published) and drifts the moment a guide is added; "3 more potty steps" undersells.
Worded abundance is true permanently and costs no query.

### Payload

New case `dm_follow_reask_card`: generic template, square cover, title, subtitle, and two
buttons — `web_url` **Visit profile** and `postback` **I'm following** carrying the action
token.

A new case rather than reusing `dm_generic_gate`, whose second button is the per-category
*action* label ("Send the recipes"). Bending it would need two more optional fields and make
one case mean two things, which is precisely how the interpolated-title defect happened.

### Wiring

`sendGuideFollowLag` and the service's `sendFollowLag` dependency gain the cover, the category
and the response number. The dependency field is declared as an **arrow-typed property** with
required fields, not method shorthand, so the compiler rejects an omission — see
`docs/` history for PRs #55–#57, where the same message shipped as text three times because
method-shorthand parameters are checked bivariantly and a silent `?? TEXT_ONLY` default won.

The cover is resolved **before** the send fence and only when the card capability is on: a
lookup inside the fence would put a database round-trip between the fence and the one message
this parent gets, and a cover fetched with the card branch unreachable is a query whose result
cannot be used.

This reverses a documented decision — *"the lag response is a nudge and deliberately carries
no image"*. Deliberately: once the nudge becomes the message responsible for converting the
follow, "it is only a nudge" is no longer true.

## Degradation

| Condition | Behaviour |
| --- | --- |
| No published square for the guide | text re-ask, still sent |
| Cover lookup throws | text re-ask, still sent |
| Card capability off | text re-ask, still sent |
| Unknown / absent category | noun becomes "ideas" |
| Meta unreachable | unchanged — `guideAccessCopy.unavailable` |

Nothing here may block the message. The re-ask is the only thing standing between a
non-follower and abandonment.

## Tests

- Every category noun keeps the card subtitle within 80 characters, counted in code points.
- `responseNumber` 1 selects the re-ask; 2 selects the existing lag copy. Mutation-checked by
  removing the branch and confirming tests fail.
- The text fallback names no button, extending the invariant already asserted for the
  existing pairs.
- No published square → text re-ask is still sent, and the card is not attempted.
- An unknown category slug produces "ideas" and does not throw.
- The re-ask's postback payload is a valid `ts:guide:<uuid>` token that routes to
  `routeGuideAction`.

## Out of scope

- Live guide counts in copy.
- Any timing heuristic. The tap counter is durable, already bounded, and needs no new signal.
- V1's gate, which has no lag concept and re-asks already.
- Turning the second (`responseNumber` 2) response into a card. Its job is sympathy, not
  conversion, and its current shape is correct for that.
