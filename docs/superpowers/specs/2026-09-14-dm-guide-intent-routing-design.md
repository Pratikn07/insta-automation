# TinySoho DM Guide Intent Routing Design

**Status:** Approved in chat; written specification ready for owner review

**Date:** 2026-09-14

**Implementation status:** Not started

**Production base audited:** `origin/main` and Railway production at
`c39290f0d2c613d759ec246faf256b513fe00133`

## Executive decision

TinySoho will stop treating every active keyword found anywhere in an Instagram
DM as a guide request. A deterministic intent classifier will decide whether a
DM is a clear guide request before the existing keyword, follow-check, and guide
delivery path may run.

The same change will stop treating every reply to an open guide request as
confirmation. Only a recognized guide action or a small, exact set of
affirmative replies will advance the request. Other text, stickers, attachments,
and blank messages will remain available for owner review and will not send a
guide or a follow gate.

Comment matching is out of scope and keeps its existing rule: comments with at
most three meaningful tokens scan all tokens, while longer comments scan only
the first token.

## Why this change is required

The deployed DM matcher currently scans every token with no length limit. The
handler applies the safer comment-style length rule only when the person already
completed the same guide. First-time users therefore enter guide delivery when
an ordinary sentence happens to contain an active keyword.

The handler then checks for an open guide request after keyword routing. When a
request exists, any reply within the internal 48-hour gate window is treated as
intent to continue. This includes greetings, unrelated questions, stickers,
attachments, and blank-text webhook shapes.

The production audit ending 2026-09-15 04:39 UTC found:

- 899 inbound DMs in seven days, of which 202 entered the strict guide-action
  path;
- 19 longer DMs with an active keyword buried in the sentence, none protected by
  the existing repeat-delivery-only safeguard;
- 38 non-affirmative text replies and four blank or non-text replies attached to
  open guide requests;
- at least 19 completed guide deliveries and 13 follow gates resulting from
  those 42 non-affirmative or non-text replies; and
- two unrelated-looking replies sent more than 24 hours after the opening that
  still completed guides.

The durable sender is not the cause. In the same seven-day period, 701 guide
deliveries completed without a missing provider receipt or unsent unit. A
current sampled delivery unit also read back from Meta with HTTP 200.

## Goals

- Keep exact and short keyword requests working.
- Keep longer, explicit guide requests working.
- Stop ordinary conversational keyword mentions from starting guide delivery.
- Stop arbitrary replies to open requests from advancing the guide flow.
- Make multi-keyword selection deterministic and explainable.
- Preserve the strict fresh-follow check, delivery ledger, duplicate protection,
  messaging-window enforcement, and provider receipt capture.
- Introduce the policy in shadow mode and on a controlled Instagram account
  before it changes behavior for real users.
- Record aggregate-safe evidence without storing raw DM text in logs or metrics.
- Keep rejected messages visible to the owner instead of marking them resolved.

## Non-goals

- Changing comment keyword matching.
- Changing how keywords are attached to posts or resources.
- Changing the fresh follower requirement.
- Changing guide contents, covers, delivery order, or delivery retries.
- Enabling AI sending or AI engagement follow-ups.
- Using an LLM to classify guide intent.
- Sending a new confirmation message for every ambiguous DM. Rejected messages
  remain an owner-review item; the fix must not replace one unwanted automated
  message with another.
- Cleaning every historical stale access attempt or token in this change. The
  implementation may add operational reporting for them, but data cleanup is a
  separate maintenance task.

## Terminology

- **Meaningful token:** a whitespace-delimited token after dropping `@mentions`,
  removing punctuation and emoji, converting to uppercase, and discarding empty
  values. This is the existing `extractCandidates` behavior.
- **Keyword hit:** a meaningful token equal to an active keyword.
- **Resolved keyword:** the keyword row selected for one keyword hit using the
  existing DM precedence: a global row first; otherwise the newest post-scoped
  row, with the existing stable tie-break.
- **Clear keyword request:** a DM accepted by the new intent classifier.
- **Open-request confirmation:** an accepted text reply or structured guide
  action that advances an existing request.

## New-DM intent policy

The policy is deterministic. It does not use sentiment, fuzzy matching,
embeddings, or an LLM.

### Step 1: Normalize and resolve candidates

The matcher will preserve meaningful-token order and resolve all active keyword
hits needed to make a decision. Database row order must never choose the guide.

For each keyword token:

1. Prefer the active global keyword row for that token.
2. If no global row exists, use the existing newest-post fallback.
3. Preserve the token's position in the original normalized message.
4. Deduplicate repeated appearances of the same keyword row.

When multiple different keyword tokens resolve to different guides, the first
keyword token written by the person wins. The decision and number of distinct
guide candidates are logged. This keeps `Please send me the WAFFLE recipe`
deterministic even when `RECIPE` is also active: `WAFFLE` appears first and is
the selected guide. It replaces the current unordered database `findFirst`.

### Step 2: Reject negative instructions

A message is not a guide request when the normalized text contains an explicit
negative construction directed at sending, including:

- `DO NOT SEND`
- `DON'T SEND`
- `DONT SEND`
- `NO NEED TO SEND`
- `I DO NOT WANT`
- `I DON'T WANT`
- `I DONT WANT`

Negative intent wins over the short-message and explicit-request rules.

### Step 3: Accept clear requests

A message is a clear keyword request when it has at least one resolved keyword
and either condition below is true:

1. It contains one to three meaningful tokens; or
2. it contains more than three meaningful tokens and at least one request signal:
   `SEND`, `SHARE`, `GET`, `GIVE`, `WANT`, or `NEED`, or one of the exact phrases
   `CAN I HAVE`, `COULD I HAVE`, `I WOULD LIKE`, or `I'D LIKE` after apostrophe
   normalization.

The keyword must remain a standalone normalized token. Substring matching is not
introduced.

Examples that must be accepted by tests include the bare keyword, a two-token
polite request, a three-token request, a long request containing `SEND`, and a
long request containing `I WOULD LIKE`.

### Step 4: Reject conversational mentions

A message with more than three meaningful tokens, at least one keyword hit, no
request signal, and no accepted structured action is classified as
`conversational_mention`.

The handler must not open or reuse a journey, send an opening, check follow
status, send a follow gate, or deliver a guide for that classification. It falls
through to the existing owner-draft/unhandled branch. The DM thread stays
unresolved.

This policy applies equally to first delivery and redelivery. The current
repeat-delivery-only buried-keyword safeguard becomes redundant and is removed
after the new classifier's tests cover both cases.

## Open-request confirmation policy

Structured guide quick replies and postbacks continue through
`guideActionRouter`; their opaque action token remains the strongest evidence of
intent.

An ordinary text DM may advance an open request only when the full normalized
message equals one of these phrases:

- `YES`
- `YES PLEASE`
- `PLEASE SEND`
- `SEND`
- `SEND IT`
- `SEND IT PLEASE`
- `DONE`
- `FOLLOWED`
- `I FOLLOWED`
- `I AM FOLLOWING`
- `IM FOLLOWING`
- `I'M FOLLOWING`
- `READY`

Normalization may remove surrounding punctuation and normalize apostrophes, but
it must not accept these words merely because they occur inside a longer
sentence. That prevents negative or unrelated sentences from passing through an
unanchored regular expression.

For an open request:

- accepted confirmation text continues to the existing strict fresh-follow
  check;
- an accepted structured action continues through the existing action router;
- any attachment, sticker, story reply without accepted text, blank message, or
  other text does not advance the request;
- a rejected reply is passed to the existing owner-draft/unhandled path, remains
  unresolved, and leaves the guide request open for a later valid confirmation;
- after the 48-hour internal gate expires, the existing exact `DONE` recovery
  remains available; and
- story mentions, echoes, deletions, reactions, and self-originated messages keep
  their existing earlier exits.

Keyword intent is evaluated before open-request confirmation, as it is today. A
clear request for a different guide starts that guide rather than confirming the
older request. A conversational mention of another keyword does not start a new
guide and does not count as confirmation of the older request.

## Components and boundaries

### Pure intent classifier

A new pure service owns text decisions. It receives normalized tokens and
resolved keyword candidates and returns a discriminated result such as:

- `accepted_short`
- `accepted_explicit`
- `rejected_negative`
- `rejected_conversational`
- `no_keyword`

The accepted result carries the selected keyword row and matched token position.
The rejected result carries only aggregate-safe reason and counts. It never
receives Prisma, environment, logging, or Meta dependencies.

The same service exposes a second pure decision for open-request reply text:
`accepted_confirmation` or `rejected_reply`, with a stable reason.

### Keyword lookup

`keywordService` remains responsible for normalization and Prisma queries. Its
DM function changes from returning one unordered row to returning the ordered,
resolved candidates required by the pure classifier. Comment functions and
their public behavior remain unchanged.

### Message handler

`messageHandler` orchestrates the result:

1. Keep all existing early exits and structured-action routing.
2. Record the inbound message exactly once.
3. Resolve and classify DM keyword intent.
4. Run the existing keyword journey only for an accepted classification.
5. If no keyword request was accepted, load the open guide request.
6. Advance it only for an accepted confirmation.
7. Pass every rejected message to owner review without marking the thread
   resolved.

The strict V2 action service, follower reads, delivery ledger, and Meta sender do
not gain a second code path.

## Rollout control

The change introduces:

- `GUIDE_DM_INTENT_GUARD_ENABLED`, a boolean flag defaulting to `false`; and
- `GUIDE_DM_INTENT_GUARD_IG_USER_IDS`, an environment allowlist for controlled
  Instagram test accounts.

The classifier evaluates every eligible DM after deployment so shadow metrics
exist even when enforcement is off. Enforcement applies when the sender is in
the controlled allowlist or the global flag is true.

The flag registry must say plainly that:

- on means only clear keyword requests and confirmations may send;
- off preserves the legacy permissive routing while shadow evaluation continues;
- it affects new inbound DM decisions only, never in-progress delivery units;
- the console may not turn it on without an approved rollout; and
- the console may stop it if the new classifier causes missed valid requests.

No database migration is required. Existing `flag_override` infrastructure owns
the mutable boolean value.

Turning off `GUIDE_FOLLOW_GATE_V2_ENABLED` is not a rollback for this feature. It
changes follow-gate ownership and exposes the V1 fallback; it does not correct DM
intent classification.

## Metrics and privacy

Record one aggregate-safe event for each eligible text DM evaluation with:

- enforcement active or shadow only;
- classification reason;
- meaningful token count;
- keyword-hit count;
- distinct resolved-guide count;
- selected keyword position when accepted;
- whether an open request existed;
- legacy behavior (`would_start_keyword`, `would_advance_open_request`, or
  `would_not_automate`); and
- guarded behavior (`start_keyword`, `advance_open_request`, or `owner_review`).

Do not record raw message text, raw webhook payloads, usernames, keyword values,
or access tokens in the new event. Existing durable associations remain the
source for authorized per-conversation investigation.

Add runbook queries that report, by UTC time window:

- accepted short requests;
- accepted explicit requests;
- rejected conversational mentions;
- rejected negative instructions;
- accepted and rejected open-request replies;
- legacy-versus-guarded decision differences;
- guide deliveries and follow gates produced by guarded decisions; and
- handler, follow-check, and provider failures.

## Error handling

- A database failure while loading keyword candidates must follow the existing
  handler failure path; it must not fall through and accidentally advance an open
  request.
- When enforcement is active, a classifier exception must fail closed to owner
  review while leaving the thread unresolved. It must not use the legacy
  permissive matcher. In shadow-only mode, the exception is logged and the
  unchanged legacy decision continues because the guard is not yet authoritative.
- A metrics write failure remains best-effort and cannot change the routing
  decision.
- A rejected message must never be marked resolved merely because classification
  completed.
- Once an accepted request reaches strict V2, its existing no-fallback rule
  remains: a V2 failure cannot fall through to V1 and double-send.

## Verification and acceptance criteria

### Automated tests

The implementation is complete only when tests prove:

- exact, two-token, and three-token keyword requests are accepted;
- long requests with each supported request signal are accepted;
- negative instructions are rejected even when short or containing `SEND`;
- long conversational mentions are rejected for both first-time and prior-guide
  users;
- punctuation, emoji, apostrophes, Unicode letters, and `@mentions` retain the
  documented normalization behavior;
- multiple keywords choose the first token deterministically, independent of
  Prisma row order;
- global-first and newest-post fallback remain stable for each token;
- every approved confirmation phrase advances an open request;
- longer text containing an affirmative word does not advance an open request;
- attachments, stickers, and blank text do not advance an open request;
- rejected keyword mentions and rejected open-request replies reach owner review
  and leave the thread unresolved;
- structured quick replies and postbacks still use `guideActionRouter`;
- exact `DONE` recovery after the internal gate window still works;
- comment matcher tests pass unchanged;
- accepted redelivery keeps the existing `explicit_redelivery` behavior;
- strict follow checks and delivery-ledger tests pass unchanged; and
- metrics contain decisions and counts but no raw message text.

### Controlled production verification

Deployment does not authorize customer messages. Using an explicitly approved
internal Instagram account, verify these paths after deployment:

1. exact keyword request;
2. short polite keyword request;
3. long explicit keyword request;
4. long conversational keyword mention;
5. explicit confirmation of an open request;
6. unrelated text on an open request;
7. non-text reply on an open request; and
8. a message containing multiple active keywords.

For accepted paths, verify the database attempt and delivery records, Railway
logs, provider receipt IDs, and a read-only Meta readback. For rejected paths,
verify that no guide access attempt, follow gate, or delivery was created and
that the thread remains available for owner review.

### Rollout gates

1. Deploy with the global guard off and the controlled-account allowlist set.
2. Complete automated tests and the controlled production matrix.
3. Observe shadow decisions for at least 24 hours and review the messages behind
   a bounded sample through authorized existing inbox tooling.
4. Obtain explicit owner approval before enabling the global guard.
5. After enabling, inspect fresh Railway logs, Supabase records, delivery units,
   follow-gate counts, and provider readback.
6. Compare 24-hour and seven-day accepted, rejected, delivery, failure, and owner
   review counts. Do not claim conversion impact without a designed experiment.

## Operational rollback

If valid guide requests are being rejected after global enablement:

1. set `GUIDE_DM_INTENT_GUARD_ENABLED=false` through the approved flag control;
2. leave the code, shadow metrics, attempts, deliveries, and provider evidence in
   place;
3. verify the effective flag value and a fresh inbound decision;
4. investigate the rejected classification using counts and authorized inbox
   context; and
5. fix the pure classifier and repeat the controlled rollout.

Rollback does not toggle V2, replay deliveries, delete attempts, or send messages
to affected users automatically.

## Files expected to change

- `src/services/dmGuideIntent.ts` — new pure keyword-intent and open-reply
  classifiers.
- `src/services/dmGuideIntent.test.ts` — exhaustive decision table.
- `src/services/keywordMatchCore.ts` and its test — ordered multi-keyword
  resolution helpers.
- `src/services/keywordService.ts` — load the full candidate set required for a
  deterministic DM decision.
- `src/handlers/messageHandler.ts` and its test — enforce the decisions while
  preserving structured actions and owner review.
- `src/config/env.ts` and `src/config/env.test.ts` — global guard and controlled
  account allowlist.
- `src/config/flagRegistry.ts` and its tests — operator-visible flag contract.
- `src/config/experimentRegistry.ts` and its tests only if the guard is declared
  as a measured experiment during implementation review; the default design
  treats it as a safety correction, not a conversion experiment.
- `docs/guide-delivery-operations.md` — rollout, verification, metrics, and
  rollback queries.
- `.env.example` — non-secret configuration examples.

No Prisma schema or migration change is expected.

## Definition of done

- All automated acceptance tests pass.
- Type checking and the production build pass.
- Existing comment, strict-follow, action-router, delivery-ledger, and flag
  contract suites pass.
- Controlled-account production verification covers accepted and rejected paths
  without contacting a customer.
- Shadow metrics contain no raw DM content.
- The owner explicitly approves global enablement.
- Post-enable evidence confirms valid requests still deliver and rejected
  conversational/open-gate messages create no guide send or follow gate.
- The final report distinguishes deployed code, effective flag state, database
  completion, Meta acceptance, and unverified customer reading.
