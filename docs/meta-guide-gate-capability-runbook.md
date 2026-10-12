# Meta guide-gate capability verification runbook

## Purpose

This runbook proves what TinySoho's current Instagram login and Graph API version actually render and return for the proposed guide-access controls. It is a controlled provider test, not a production rollout.

The five cases are:

| Case | Messaging context | What it proves |
| --- | --- | --- |
| `private_text` | One private reply allowed from a fresh comment | The text-only release fallback |
| `private_quick_reply` | One private reply allowed from a different fresh comment | Whether a quick reply is accepted in the comment-private-reply slot |
| `private_generic` | One private reply allowed from a different fresh comment | Whether a generic image/button card is accepted in that slot |
| `dm_quick_reply` | Standard DM after the controlled recipient responds | Quick-reply rendering and `messages` webhook shape |
| `dm_generic_gate` | Standard DM after the controlled recipient responds | Image crop, profile URL, postback button, and `messaging_postbacks` shape |

## Hard release rule

A capability is usable only when the committed sanitized result marks its exact case `supported` and the required mobile/desktop/webhook checks pass. Missing evidence, a missing result file, an incomplete check, or `not_verified` is treated as unsupported. The text fallback remains available regardless of rich-case results.

This runbook does not authorize:

- a production parent's comment or inbox as a test target;
- batch testing;
- retrying an initial private-reply case against the same comment;
- enabling `GUIDE_RICH_GATE_ENABLED`;
- delivering a real guide during the capability test.

## Required authorization and controlled assets

Do not begin until all of the following are recorded in the private operator ticket:

- explicit TinySoho owner authorization for the named test window;
- one Instagram professional account controlled by TinySoho;
- one separate controlled recipient account with the required app/account role;
- one fresh controlled comment for each private-reply case;
- confirmation that no selected comment has received a private reply;
- one publicly retrievable, non-sensitive test cover image;
- the production login type, Graph API version, and granted permissions;
- `messages` and `messaging_postbacks` webhook subscriptions enabled;
- a reviewer responsible for comparing the restricted raw evidence with the sanitized record.

Store real account IDs, comment IDs, action UUIDs, access tokens, request/response bodies, usernames, and unredacted screenshots only in the approved restricted evidence store. None belongs in Git, application logs, the sanitized JSON, or the operator screenshots committed here.

## Harness safety contract

The command runs exactly one case and refuses to call Meta unless `--confirm-controlled-send` is present:

```bash
npm run verify:meta-guide-gate -- --case private_text --confirm-controlled-send
```

There is deliberately no `--all` mode. Validation happens before the Graph sender boundary.

The harness reads only the variables needed by the selected case:

| Variable | Used by |
| --- | --- |
| `META_SPIKE_GUIDE_NAME` | Every case |
| `META_SPIKE_COMMENT_ID` | `private_text`, `private_quick_reply`, `private_generic` |
| `META_SPIKE_RECIPIENT_IG_USER_ID` | `dm_quick_reply`, `dm_generic_gate` |
| `META_SPIKE_ACTION_TOKEN` | Every rich/action case |
| `META_SPIKE_PROFILE_URL` | Generic-template cases |
| `META_SPIKE_COVER_URL` | Generic-template cases |

The application continues to obtain its own account/token from the existing server-only configuration. Do not paste values into a command line, shell history, screenshot, ticket comment, or document. Load them through the approved secret environment.

A successful or rejected provider request writes one JSON object to stdout with only:

- case;
- Graph version;
- accepted Boolean;
- numeric HTTP status when available;
- numeric Graph code/subcode when available;
- whether a provider message ID was present;
- check timestamp.

Raw request/response data, provider messages, trace IDs, payloads, URLs, recipient/comment IDs, usernames, and tokens are intentionally absent.

## Before each case

1. Confirm the approved test window is still open.
2. Confirm the recipient/account roles and current permissions.
3. For a private-reply case, create a new controlled comment and verify it is fresh, present, and has not received any private reply attempt.
4. Set only the required secret-environment values for that case.
5. Start sanitized webhook capture. Preserve raw webhooks only in the restricted store.
6. Record the mobile and desktop client versions in the private operator ticket, not the Git artifact if they identify the tester.
7. Run one command once.

If a private-reply command times out or has an unknown outcome, do not repeat it on that comment. Mark the result `not_verified` or preserve the sanitized uncertain result and move to a new comment only after reviewer approval.

## Case sequence

### 1. Text-only private reply

```bash
npm run verify:meta-guide-gate -- --case private_text --confirm-controlled-send
```

Check that one private reply appears in the controlled recipient's Instagram conversation and that no button is present. This is the baseline fallback.

### 2. Private quick reply

Use a different fresh comment:

```bash
npm run verify:meta-guide-gate -- --case private_quick_reply --confirm-controlled-send
```

Do not infer support from HTTP acceptance alone. Confirm the button is visible in the current mobile app, tap it once, and capture the resulting `messages` event with `message.mid`, visible `message.text`, and `message.quick_reply.payload` present. Quick replies are documented as unavailable on desktop, so desktop must preserve a usable text-reply path rather than being marked supported because mobile worked.

### 3. Private generic card

Use another different fresh comment:

```bash
npm run verify:meta-guide-gate -- --case private_generic --confirm-controlled-send
```

Check acceptance, card image crop/safe area, title/subtitle readability, request button, default profile action, and the returned webhook. Do not retry the same comment if Meta rejects or the outcome is unknown.

### 4. Standard-DM quick reply

First have the controlled recipient send a genuine response so the standard messaging context is open. Then run:

```bash
npm run verify:meta-guide-gate -- --case dm_quick_reply --confirm-controlled-send
```

Tap once on mobile and capture the `messages` webhook. On desktop, confirm the plain-text conversation remains usable even if quick replies are absent.

### 5. Standard-DM generic follower gate

With the controlled DM context still valid, run:

```bash
npm run verify:meta-guide-gate -- --case dm_generic_gate --confirm-controlled-send
```

Check:

- image crop and text safe area on mobile and desktop;
- **Visit profile** opens the exact TinySoho profile and returns to the conversation cleanly;
- **I'm following ✓** produces one `messaging_postbacks` event with sender identity, timestamp, `postback.mid`, `postback.title`, and opaque payload;
- tapping/replaying the same action again does not cause any guide send in this capability harness;
- the fallback conversation can still accept an ordinary typed response.

## Follow-flag propagation observation

This observation records provider latency; it never relaxes the follower gate.

1. Read the controlled recipient's live `is_user_follow_business` value before following.
2. Follow TinySoho in the controlled Instagram app.
3. Record fresh live Boolean checks at approximately immediate, 15 seconds, 60 seconds, and 5 minutes, stopping once `true` is observed.
4. Record only elapsed milliseconds, Boolean/null result, and safe error code in the sanitized result.
5. If no authoritative Boolean is available, mark the observation unavailable. Never substitute a cached value.

## Screenshot and evidence rules

For each supported presentation case, capture the smallest screenshot that proves the UI behavior. Before committing:

- crop or mask usernames, avatars, account IDs, message IDs, comment text, timestamps that identify a person, device notifications, and unrelated conversations;
- remove URL query strings and every token/payload value;
- preserve only the visible TinySoho copy, button layout, crop, and generic test artwork needed for review;
- store the restricted original outside Git;
- have a second reviewer compare the redacted image and sanitized JSON with the restricted original.

Committed screenshots go under `docs/qa/artifacts/2026-08-22-meta-guide-gate/` with a README explaining what each redacted image proves. Never commit a screenshot merely because it was captured.

## Decision rules

Use only these values:

- `supported`: Meta accepted the request and the required real-client/webhook behavior was observed;
- `unsupported`: Meta definitively rejected it or the required control/presentation is unusable;
- `not_verified`: the run was not performed, evidence was incomplete, or the outcome was ambiguous.

HTTP 200 by itself is insufficient for `supported`. A screenshot without a correlated sanitized send/webhook is also insufficient. Desktop absence of quick replies is expected provider behavior; the case may support mobile quick replies only when the text fallback is independently usable.

Copy `docs/meta-verification/guide-gate-capability-results.template.json` to a dated result only after review. Keep every unused row `not_verified`.

## Cleanup

1. Stop the test window and clear all `META_SPIKE_*` values from the shell/secret session.
2. Remove controlled comments/messages only according to the test-account retention policy; do not delete evidence needed for review.
3. Confirm no guide delivery, recovery campaign, or production flag was enabled.
4. Review server logs for numeric/safe metadata only.
5. Retain restricted raw evidence according to policy and commit only the sanitized result, redacted screenshots, and artifact README.

## References

- [Meta Instagram Private Replies](https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514)
- [Meta Instagram Quick Replies](https://www.postman.com/meta/instagram/request/23987686-df99e677-3390-449c-a016-8e94dd09ec77)
- [Meta Instagram Generic Template](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-26e7999c-fc7e-44c8-8f71-ab2de8d35c32)

## Link guide cases (added 2026-10-12)

These are two more one-shot private-reply cases, for link guides. The authorization, controlled accounts and one-comment-per-case rules above all apply. Each case spends one fresh comment from the controlled recipient on a TinySoho test post.

| Case | Command | Pass condition |
|---|---|---|
| `private_link_card` | `npm run verify:link-guide -- --case private_link_card --confirm-controlled-send` | Output shows `accepted: true`. The card lands in the recipient's Message Requests. Tapping **Open the recipes** on a phone opens the page without accepting the request first |
| `private_link_text` | `npm run verify:link-guide -- --case private_link_text --confirm-controlled-send` | Output shows `accepted: true`. The link in the text can be tapped from Message Requests on a phone |

Environment for both cases:
- `META_SPIKE_COMMENT_ID`: a fresh comment.
- `META_SPIKE_LINK_URL`: `https://mycuratedhaven.com/halloween?utm_source=spike`.

Card case only:
- `META_SPIKE_COVER_URL`: a public square image.
- `META_SPIKE_PROFILE_URL`: `https://www.instagram.com/tinysoho/`.

Record the results in `docs/meta-verification/2026-10-13-link-guide-capability-results.json`:

```json
{
  "schemaVersion": 1,
  "run": { "graphVersion": "v21.0", "reviewedBy": "<owner>", "reviewedAt": "<ISO time>" },
  "cases": [
    { "case": "private_link_card", "decision": "supported | unsupported | not_verified", "sanitizedResult": {}, "mobileTapFromRequests": "pass | fail | not_verified", "notes": [] },
    { "case": "private_link_text", "decision": "supported | unsupported | not_verified", "sanitizedResult": {}, "mobileTapFromRequests": "pass | fail | not_verified", "notes": [] }
  ]
}
```

`sanitizedResult` is the JSON the command printed. A case is `supported` only when Meta accepted it AND the phone tap from Message Requests passed. A result with `accepted: false` and `httpStatus: null` (or the `outcome_unknown_do_not_retry` line on stderr) means the outcome is unknown: mark that case `not_verified`, never re-run it on the same comment, and use a fresh comment only after review.
