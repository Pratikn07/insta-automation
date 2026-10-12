# Link guides: send a button to the site instead of a follow-gated guide

**Date:** 2026-10-12
**Status:** Design approved in conversation, awaiting written-spec review
**Pilot:** Halloween collection, `https://mycuratedhaven.com/halloween`, live by 2026-10-19

## Summary

The creator chooses, per post, between today's **gated guide** (follow @tinysoho, then the guide
arrives in DMs) and a new **link guide** (one DM with a button to a page on mycuratedhaven.com, no
follow needed). The URL lives on the guide, so many reels can share one link guide.

Example: a parent comments `GHOST` on a Halloween reel. They get the usual public reply, then one DM:
a card titled "Your Halloween recipes" with an **Open the recipes** button. Tapping it goes through
our redirect, which records the click, to `mycuratedhaven.com/halloween?utm_source=instagram&…`.
No tap-to-request, no follow check, no gate.

The pilot is judged on **site clicks**. Follows are optional: the card carries a second, non-blocking
**Follow @tinysoho** button.

## Why

Last 30 days of the gated flow (`guide_access_v2_metric` events and `guide_access_attempt` rows,
read 2026-10-12):

| Step | Count |
|---|---|
| First DM accepted by Meta (`opening.accepted`) | 11,510 |
| Parent tapped or replied (`action.received`) | 6,042 (52%) |
| Already following (`fresh_check.follower`) | 3,150 |
| Not following, gate shown (`gate.shown`) | 2,821 |
| Followed after the gate (`recheck.confirmed`, events) | 1,175 |
| Guide delivered (`guide_access_attempt.state = delivered`) | 4,239 |

The gate earns about 1,175 follows a month. `recheck.confirmed` counts events, so read it as an
upper bound. Link guides give these up on the posts that use them, by choice. The largest loss is
before the gate: 5,468 parents (48%) never answer the first DM. A link guide puts the link in that
first DM, so it can reach every parent who gets one, not only the 4,239 who reach delivery today.

## Meta constraint and the launch test

Meta's Private Replies documentation says only one message can be sent to a commenter, within
7 days of the comment, and follow-ups need the parent to respond first. Its example shows a plain
text message. It does not say whether a button card (generic template) is allowed in that one
message. Our own capability run (`docs/meta-verification/2026-08-24-guide-gate-capability-results.json`)
left `private_generic` and `private_text` as `not_verified`. `dm_generic_gate` (a button card in an
already-open thread) is `supported`.

So the first DM's shape is **unverified**, and the first task is a controlled test under the
existing runbook (`docs/meta-guide-gate-capability-runbook.md`): owner sign-off, one controlled
recipient account, two fresh comments.

| Case | Pass condition |
|---|---|
| Link card as the private reply | Meta returns 200 with a message id; the card lands in Message Requests; tapping the button on a phone opens the site without accepting the request first |
| Plain text with a link as the private reply | Same, for a text link |

The result is committed as a dated file in `docs/meta-verification/` under the runbook's
`supported` / `unsupported` / `not_verified` rules.

| Outcome | What ships |
|---|---|
| Card passes | Link card (`LINK_GUIDE_CARD_ENABLED` on) |
| Card fails, text passes | Text DM with the link (`LINK_GUIDE_CARD_ENABLED` off) and the `go.mycuratedhaven.com` redirect domain (see Click tracking) |
| Both fail | Stop. Redesign as "tap first, then the card" before writing code |

The test runs on 2026-10-13, before implementation starts.

## Parent flow

### Comment path

1. Keyword match: unchanged (`keywordService.ts`, post-scoped).
2. `claimComment`: unchanged.
3. Audience block: unchanged (`commentHandler.ts:299`). A `south_asian` verdict means no public reply and no DM.
4. Journey dedupe: unchanged. One DM per person per keyword per 48 hours.
5. Public reply: unchanged mechanism. The form's default copy for link guides is "Sent you the recipes 💛 Check your DMs (and Requests)!"
6. **New:** the guide's `delivery_mode` is `link`, so the handler sends the link DM as the private reply and records a `guide_link_send` row. It never calls `guideFollowGateV2Selector`, never creates a `guide_access_attempt`, and never reads follow state.
7. The conversation moves to the new state `link_sent`.
8. The 2-hour public reminder is scheduled the way V2 schedules it today: through `scheduleAcceptedGateRecovery` from the opening message id, under `DM_RECOVERY_TWO_HOUR_ALL_ENABLED`. PR #75 added that flag with a default of off; whether it's on in production is unverified, so the reminder for link guides fires only if it's on. Link guides get their own wording: "@handle I sent you the link 💛 Instagram may have tucked it into your Message Requests…". The settings-blocked and tracking-unavailable reminders keep their current wording.

### Link DM content

- **Card** (`LINK_GUIDE_CARD_ENABLED` on, and the guide has a published square cover): a generic template.
  - Image: the guide's published square cover. A guide without one gets the text shape. The gated card follows the same rule, because a card with no image is a worse message than plain text.
  - Title: `link_card_title`, falling back to the guide name. Subtitle: `link_card_subtitle`, falling back to the guide description.
  - Button 1: `web_url`, label `link_button_label`, pointing at the tracked `/r/<token>` URL.
  - Button 2: `web_url`, "Follow @tinysoho", pointing at `GUIDE_PROFILE_URL`.
  - `default_action`: the tracked URL.
- **Text** (`LINK_GUIDE_CARD_ENABLED` off, or no published square cover): `"<title>\n<tracked URL>"`, built from the same fields. Example: "Your Halloween recipes 👻 / https://go.mycuratedhaven.com/r/x7k2", where the emoji is part of the title.

### DM keyword path

A parent who DMs `GHOST` (for example after the settings-blocked public reply) gets the card as an
ordinary DM in the open thread, the `dm_generic_gate`-verified shape, with a `guide_link_send` row
on channel `dm`. No follow check. A repeat DM of the keyword sends the card again.

### Replies inside a link conversation

A `link_sent` conversation is **not** an open guide request. `findActiveAwaitingDone` only matches
`awaiting_done`, so a reply such as "yes" or "thanks" never reaches the V1 DONE branch or the V2
`runStrictGuideRequest` fence (`messageHandler.ts:849`). A reply that matches the keyword takes the
DM keyword path above. Any other reply falls through to the existing handling for messages with no
open request.

This is the main correctness reason for the new state. Without it, `awaiting_done` would route a
"yes" under a link DM into the follow gate for a guide that has no steps.

### Completion

The first **human** click on a send calls the existing conversation completion in
`conversationService`. That marks the conversation `completed`, marks the journey intent completed,
and suppresses any waiting reminder, which is correct: someone who clicked doesn't need one.

Link completion must **not** write `sequence_completed`, so the guide → follow funnel stays
gated-only. The implementation plan verifies this against the completion function.

A `link_sent` conversation with no click does not expire. A new comment after the 48-hour journey
window starts a new journey and a new send, as today.

## Failure paths

| Situation | Behaviour |
|---|---|
| Temporary send error (network, 5xx) | Existing `recoverFailedPrivateReply` → `gate_queue`. For link guides, the row's `gate_queue.gate_message` is the text-with-link DM, built at enqueue time with that send's token. `gateQueueWorker` resends it as a text private reply, the shape production sends daily. The link branch sits beside the owner choice at `gateQueueWorker.ts:233` |
| Parent's settings block DMs | Existing `scheduleSettingsBlockedRecovery` public reply ("DM us GHOST") → DM keyword path |
| Permanent or auth error | Dropped and logged, as today |
| Sent but unseen after 2 hours | Existing public reminder, with link wording |
| Link guide has no valid `link_url` at send time | No public reply, no DM. Logged `link_guide_misconfigured`. Unreachable once API validation holds, but checked at send time because the row can be edited between save and comment |
| `LINK_GUIDE_ENABLED` off | Posts with link guides get no public reply and no DM. Logged `link_guide_disabled` |

## Data model

### `resources` (guides): new columns

| Column | Type | Rule |
|---|---|---|
| `delivery_mode` | enum `guide_delivery_mode` (`gated`, `link`), not null, default `gated` | All 116 existing guides stay `gated`. No backfill |
| `link_url` | text, nullable | Required when `link`. Must be `https`, with a host in `LINK_GUIDE_ALLOWED_HOSTS` |
| `link_button_label` | text, nullable | Required when `link`. 1–20 characters (Meta's button title limit, confirmed in the launch test) |
| `link_card_title` | text, nullable | Optional, up to 80 characters. Falls back to `name` |
| `link_card_subtitle` | text, nullable | Optional, up to 80 characters. Falls back to `description` |

The existing `resources.kind` column is **not** reused. It records what a guide is (`guide`,
`recipes`, `activity`, `product_links`), and its migration marks `product_links` "NEVER routable as
advice". Delivery mode is a separate fact. Current distribution: 89 null, 11 `guide`, 7 `recipes`,
6 `activity`, 3 `product_links`.

Switching a guide between `gated` and `link` keeps its `resource_messages` (steps), so switching
back restores them. A guide with any `guide_link_send` row can't be deleted
(`resource_has_link_history`), matching the existing delivery-history guards.

### `conversations`

`ConversationState` gains `link_sent`. Every reader of the enum must handle it explicitly. The plan
lists them; TypeScript's exhaustive switches surface the rest at compile time.

### New table `guide_link_send`

One row per link DM attempt.

| Column | Notes |
|---|---|
| `id` | uuid |
| `token` | unique, 11 URL-safe characters (8 random bytes, base64url), carries no user data |
| `conversation_id`, `resource_id`, `keyword_id` | foreign keys |
| `media_id` | reel or post, for per-reel metrics |
| `ig_user_id` | the parent |
| `channel` | `private_reply` or `dm` |
| `shape` | `card` or `text` |
| `status` | `pending`, `sent` or `failed` |
| `provider_message_id` | nullable |
| `created_at`, `sent_at` | |

### New table `guide_link_click`

| Column | Notes |
|---|---|
| `id` | uuid |
| `send_id` | foreign key to `guide_link_send` |
| `clicked_at` | |
| `destination_url` | the exact URL redirected to, with UTM tags |
| `is_bot` | true for known preview agents (`facebookexternalhit`, `meta-externalagent`) and `HEAD` requests |
| `ua_family` | coarse label only |

No IP address is stored. A unique human click is the first `is_bot = false` row per send.

`keywords` is unchanged. The plan confirms the 48-hour dedupe still holds on `keyword_id`.

## Routing in code

The owner choice gains a third answer before the existing selector runs:

```
guideOwnerFor({ deliveryMode, igUserId, resourceId }):
  deliveryMode === "link" → "link"
  otherwise              → guideFollowGateV2Selector.owner({ igUserId, resourceId })  // unchanged, v1 | v2
```

`guideFollowGateV2Selector` and its fail-closed-to-`v1` behavior stay untouched. The keyword lookup
loads `resource.deliveryMode` in the same query, so the mode is never a second read that can fail
on its own.

Call sites that branch on the owner today, all of which gain the `link` branch:

- `src/handlers/commentHandler.ts:420`: comment path.
- `src/handlers/messageHandler.ts:77` (`strictGateOwnerFor`), used by the DM keyword path and the typed-reply fence at `:849`.
- `src/services/gateQueueWorker.ts:233`: retry path.

New sending code sits next to the existing Meta senders:
- `sendLinkGuidePrivateReply` (card or text, private-reply recipient);
- `sendLinkGuideDm` (card or text, open thread);
- a payload builder beside `guideGatePayloads.ts`.

`deliverGuideForTrigger` and the guide delivery ledger are not used for link guides. A link DM is
one message with its own record (`guide_link_send`).

The audience checks at `commentHandler.ts:299` and in the DM keyword path (`mayStartGuideAction`)
apply unchanged.

## Click tracking

`GET /r/:token` on the Railway API, public and unauthenticated. Every hit redirects. At most 20 click rows are recorded per send, so a scraper can't grow the table without limit. The repo has no rate-limit library, and this cap does the same job:

1. Look up `guide_link_send` by token. If none is found, redirect `302` to `https://mycuratedhaven.com/`. A parent never sees a 404.
2. Read the guide's **current** `link_url`, so a fixed URL also reaches DMs already sent.
3. Append UTM tags:
   - `utm_source=instagram`
   - `utm_medium=dm`
   - `utm_campaign=<guide slug>` (lowercased, hyphenated guide name)
   - `utm_content=<media_id>`
4. Insert a `guide_link_click` row with the bot flag. A failed insert never blocks the redirect.
5. `302` to the destination.

Domain: the card's button hides the URL, so the Railway API domain is acceptable for the card. If
text ships, the URL is visible, so `go.mycuratedhaven.com` (one DNS record plus a Railway custom
domain) becomes a launch requirement.

The redirect counts taps only. What parents do on the page needs analytics on mycuratedhaven.com;
the Halloween page showed no analytics script on 2026-10-12.

## Console

### Attach keyword form (`web/src/components/KeywordForm.tsx`)

- **New "After they comment" switch:** Gated guide, or Link to a page.
- **Link mode:**
  - The guide picker shows only `link` guides, plus a "New link guide" option with inline fields for name, URL and button text.
  - A summary of the selected guide's URL and button text, with an "Edit guide" link.
  - The Gate DM field is hidden. `keywords.gate_message` stays required in the database, so the form saves a fixed placeholder that link guides never send. The retry text is built per send (see Failure paths).
  - The public reply default becomes the link copy.
- **Gated mode:** today's form, unchanged.
- **Guide picker:** each option shows its mode.

### Guide page (`/guides/:id`, `SequenceEditor.tsx`)

- New **Type** setting at the top: Gated or Link.
- A Link guide shows a link panel instead of the step editor:
  - `link_url`, `link_button_label`, `link_card_title`, `link_card_subtitle`;
  - the existing `GuideCoverPanel`;
  - a live preview of the card.
- Steps are hidden, not deleted.

### Badges

The Guides list and Content post rows show **Link** or **Gated**.

### API validation

`POST`/`PATCH` on guides rejects:
- a `link` guide without a valid `https` `link_url` on an allowed host;
- a `link_button_label` outside 1–20 characters;
- card fields over 80 characters.

Errors follow the console's existing copy rules.

## Metrics

- **New funnel definition "Comment → link click"**, per reel, added as a definition and not a new page (`docs/funnels.md`). It reads `keyword_matched` events joined to `guide_link_send` and `guide_link_click`. Stages:
  - comments matched;
  - links sent (`status = sent`);
  - unique human clicks;
  - click rate.

  Example row: "GHOST reel: 412 matched, 398 sent, 171 clicked, 43%".
- **Guide → follow funnel and strict guide-access metrics:** link guides are excluded, so the gated baseline isn't diluted. For link guides, the `keyword_matched` event carries `deliveryMode: "link"`, and the guide-follow and drop-off cohorts skip those rows. Link guides never write `guide_access_v2_metric`.
- **"Followed anyway":** a parent who clicked has a `completed` conversation, so the existing `followRecheckWorker` already re-reads them about 3 days later. No worker change is needed. The link funnel reports the share following among rechecked clickers. Before most recipes move to links, this is the number that prices the move in follows.
- **Writers:** the link funnel's stages read rows that only the link sender (`guide_link_send`) and the redirect (`guide_link_click`) write. A contract test runs the funnel SQL against real rows from both, so no stage can sit at a permanent zero unnoticed.

## Switches

Both are declared in `src/config/env.ts` with `booleanFlag` (never `z.coerce.boolean`) and
registered in `src/config/flagRegistry.ts` with `pageMayEnable: false, pageMayStop: true`, matching
the existing guide outbound flags.

| Flag | Default | Effect |
|---|---|---|
| `LINK_GUIDE_ENABLED` | off | When off, link-guide posts get no public reply and no DM |
| `LINK_GUIDE_CARD_ENABLED` | off | Card when on, text-with-link when off. Turned on only after the card case is `supported` |
| `LINK_GUIDE_ALLOWED_HOSTS` | `mycuratedhaven.com,www.mycuratedhaven.com` | Comma list for URL validation, compared lowercase |
| `LINK_GUIDE_REDIRECT_BASE_URL` | unset | The public `https` origin for `/r/<token>` links: the Railway API domain, or `go.mycuratedhaven.com`. Boot fails if `LINK_GUIDE_ENABLED` is on without it |

## Testing

- **Contract database tests** (real Postgres, `insta-contract-pg` on port 5433, no mocks at the database boundary):
  - the migration defaults every guide to `gated`;
  - a link-guide comment writes a `guide_link_send` row, moves the conversation to `link_sent`, and creates no `guide_access_attempt`;
  - a typed "yes" in a `link_sent` conversation never reaches `runStrictGuideRequest` or the V1 DONE branch;
  - the keyword DM path sends the card;
  - the first human click completes the conversation, suppresses the reminder, and writes no `sequence_completed`;
  - a bot click doesn't complete it;
  - an unknown token redirects to the home page;
  - a retry row for a link guide resends the text-with-link DM.
- **Unit tests:**
  - `guideOwnerFor`;
  - URL and label validation;
  - UTM building, including the slug;
  - bot detection;
  - card and text payload builders.
- **Metrics:** every new funnel stage has a writer.
- **Web:**
  - the form's two modes, the guide page's link panel and the badges;
  - the production build runs with `VITE_SUPABASE_*` set, and the bundle is checked for app code.
- **Real-phone end-to-end check before merge:** a test reel on a link guide, verifying:
  - comment → public reply → card in Requests → tap → click row → page with UTM tags;
  - reply "yes" → no gate;
  - DM `GHOST` → card;
  - `LINK_GUIDE_ENABLED` off → silence.

## Rollout

Merging to `main` deploys Vercel and Railway. Both switches default off, so the merge changes nothing for parents.

| Date | Step |
|---|---|
| 2026-10-13 | Meta launch test; ship decision recorded |
| 2026-10-13 to 10-16 | Build |
| 2026-10-17 | Real-phone end-to-end check; merge with switches off |
| 2026-10-19 | `LINK_GUIDE_ENABLED` on; one Halloween reel on the link guide; watch the first ~50 sends for Graph error codes, bot share and click rate |
| 2026-10-20 to 10-31 | All Halloween reels on the link guide |
| 2026-11-01 to 11-07 | Read clicks per reel and the "followed anyway" rate against the gated baseline; decide whether most recipes move to link guides |

## Risks

- **Meta's handling of link DMs at volume (~380 first DMs a day at current rates) is unverified.** Mitigations: the single-reel start, watching Graph error codes, and the off switch.
- **The collection on the landing page is "Opening soon".** Parents can't buy it yet. That's acceptable for a clicks goal, and the owner was told.
- **No site analytics are visible,** so the UTM tags only pay off once mycuratedhaven.com records them.

## Non-goals

- Per-post URL overrides. The URL lives on the guide only.
- A "tap first, then the card" path. It is built only if the launch test fails both cases.
- A/B splitting a reel between gated and link.
- Purchase attribution from reel to checkout.
- Any change to gated guides, the V2 selector, covers, or the delivery ledger.
