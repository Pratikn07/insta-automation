# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Two people, one shared login, two different jobs.**

Confirmed by the user: they sign in with a single account and want it kept that
way for now. (`ADMIN_EMAIL` currently allowlists 2 addresses, so the backend
would permit separate logins — but that is configuration, not how it is used.)
**Decided: no role separation.** Do not design separate creator and operator
views, or per-role permissions, unless this is revisited.

**Pratik — CPO/CTO.** Owns analytics and all technical work: the webhook service,
the background workers, the data model, and the console itself. Reads the console
to interpret what the numbers mean and to keep the automation healthy. Works in it
roughly 80% on desktop; occasionally on a phone for quick edits.

**The content creator — the account's main marketer.** Makes the content and owns
the marketing decisions. She is non-technical relative to this system and should
never need to know its internals.

- **What she does in the console today:** setup, daily. She posts a reel or
  carousel, logs in, attaches keyword(s) to that post, and edits sequences. That
  is the whole of her current usage.
- **What she is responsible for deciding:** what to film next, whether the last
  thing worked, what to fix in the funnel, and the day-to-day setup she already
  does.

**This gap is a confirmed product fact, not a bug report:** the analytics half of
the console is built for the reader who is not yet reading it. She logs in for
setup; the decisions the analytics exist to support are hers.

### The audience the product acts on

Not console users — the people on the other side of the automation. US/Western
parents of toddlers who comment a keyword on a reel. Confirmed by the system's
own targeting: the Gemini reel prompt scores US-vs-India cultural fit, the
recovery gate has a Western-only mode, and the brand-voice default is written
about parents.

## Product Purpose

Turn Instagram engagement on `@tinysoho` into followers and delivered guides — and
measure honestly whether that is working.

The flow: someone comments a keyword on a reel → the bot replies publicly and DMs
a gate message → they follow and reply `DONE` → the bot delivers a configured
sequence (text / image / PDF).

**Two jobs, equally first-class** (confirmed): deciding what to do next to grow,
and keeping the automation running. Neither is subordinate to the other. Analytics
are not decoration on an ops tool, and ops are not plumbing under a dashboard.

### The console interprets; it does not only report

Confirmed 2026-08-16, and it changes what this product *is* rather than how it
looks. The console states a finding — what is true today and what to do about it,
ranked — instead of presenting numbers and leaving the reading to the user.

This follows directly from the confirmed fact in `## Users`: the analytics are
built for a reader who does not read them. She opens the console daily for setup
and leaves. A page of correct figures does not reach her; a sentence does.

**What it commits us to.** The interpretation is a *capability*, not a copy
exercise, and most of it is backend work: comparing cohorts, attributing a lift
to its cause, ranking losses by what they cost, and — the hard part — knowing
when a sample is too thin to say anything at all.

**What it may never become.** A sentence is a claim, and this product does not
make claims its samples cannot carry. Every clause must be derived from a
measurement; where it cannot be derived, nothing is printed. An invented or
smoothed-over finding is worse than a blank, because a blank is honest and a
reader can act on a wrong sentence.

**Status:** the first version ships derived from data that already exists —
settled week-over-week velocity and the funnel's largest eligible measured loss.
The richer version (attributing a lift to specific reels, ranking across several
signals) is real unbuilt work, not a wording problem.

**Measurement contract.** A week-over-week interpretation requires exactly two
contiguous seven-day Pacific calendar windows. Every day must be a settled,
single-day `diff` with a known US count. A missing, duplicated, stale,
provisional, pending, no-snapshot, no-prior-day, or multi-day catch-up point
withholds the interpretation; the code does not shorten or backshift the window
to find a more convenient answer. Descriptive charts may still show provisional
and catch-up data with their qualifications. The restriction applies to claims,
not visibility.

The funnel sentence and ranked action use the largest absolute loss between
adjacent measured stages. A transition marked `bypassable` or `coverageOnly` is
not eligible, because its apparent difference is not measured attrition. The
funnel's predefined headline remains useful on the funnel page but is not
allowed to masquerade as the largest loss on Home.

**Home evidence states.** Home has four explicit readiness states:

- `checking`: at least one required source is still loading and none has failed;
- `ready_with_attention`: all required sources answered and verified items exist;
- `ready_clear`: all required sources answered and no verified item exists;
- `incomplete`: at least one required source failed, while verified items from
  the sources that answered remain visible.

The required all-clear sources are system stats and the guide funnel. “Nothing
is waiting,” “nothing is failing,” and equivalent reassurance may appear only
in `ready_clear`. Every required-source failure names itself and retries its own
query. Follower flow and feed-follow attribution are no longer Home dependencies.

**Dashboard reporting scope, Oct 4, 2026.** General audience growth, geography and
content-performance reporting is monitored elsewhere and removed from Home and
Insights. Home keeps reply-rate evidence, operational attention and system pulse.
Insights keeps AI content analysis, per-reel automation conversion counts,
commenter-origin evidence and content-experiment results. Collectors and stored
history remain intact; removing reporting does not retire those data sources.

### Success metric

**US followers gained.** Confirmed as the goal. Everything else the system
measures — guides delivered, capture rate, 21-day retention, funnel conversion —
is a supporting detail that explains movement in this number.

Two qualifiers, both confirmed and both binding:

1. **It is one measure, not the organizing principle.** It belongs as a single
   measure, monitored outside this dashboard. The console must not be restructured
   so that every surface
   becomes a view onto US follower growth. The two first-class jobs above still
   hold; the score does not outrank them.
2. **Reporting stays all-country.** The *goal* is US-focused; the *reporting* is
   not. Visibility across every country Meta reports must be preserved — it
   remains in collected history and must not be narrowed to US-only
   in service of the metric. The Home country picker was retired Oct 4, 2026.
   Note the hard ceiling: Meta reports exactly 45
   countries (see Capabilities and Constraints), so "all countries" means all
   reported countries, and `followers_count` remains the true total.

## Positioning

*Derived from the codebase, not yet confirmed by the user — correct if wrong.*

Not a generic comment-to-DM tool. Three things a neighboring product could not
truthfully claim:

1. **Cohort truth over event counts.** A funnel picks the conversations that
   *entered* in a window and follows them forward however long they take. Every
   stage is a boolean per conversation, never a row count — because `markGated`
   re-arms on every reply and completions land outside the window.
2. **Measurement honesty enforced in code, not policy.** Rates below `minSample`
   return `null` and callers render the raw counts instead. Absence of evidence
   renders as its own state, never as zero and never as a color. Stages reachable
   without passing the previous one are marked `bypassable` and print no step
   conversion.
3. **Content scored against the audience it is trying to win.** Gemini watches
   each reel and returns a US-cultural-fit profile (accent, setting, cultural
   references), so "what to film next" is tied to who actually followed.

## Operating Context

**The daily rhythm.** The creator posts → logs in → attaches a keyword to that
post → the automation runs unattended. The console is always read against a
machine already in motion: webhooks arrive continuously and background workers
tick on their own schedules.

**Devices.** ~80% desktop. Phone is real but narrow in scope — quick edits like
adding a keyword, not analysis.

**Where it runs.**

- API + workers: Railway. Console: Vercel. Data, storage, and auth: Supabase.
- A second private Railway service (`codex-runtime`) holds the ChatGPT OAuth
  session on its own volume for AI features.
- The Vercel project **is** git-connected to `github.com/Pratikn07/insta-automation`
  (root directory `web`), so **merging to `main` deploys the console** — no
  `vercel --prod` required, and even a docs-only merge rebuilds it.
- **A "Canceled" preview in Vercel is the setting working, not a failed build.**
  The Ignored Build Step is `if [ "$VERCEL_ENV" = "production" ]; then exit 1;
  else exit 0; fi`, so every branch push clones, skips, and reports Canceled in a
  couple of seconds. Verified from a build log: *"The Deployment has been canceled
  as a result of running the command defined in the Ignored Build Step setting."*
- The **API is still a manual `railway up`**. Only the console is automated, so a
  backend change is not deployed by merging.
- Local dev tunnels to Meta's webhook via ngrok.
- Analytics days are Pacific, not UTC.

**External truth.** The Meta Graph API is the only source of external reality.
`docs/meta-verification.md` records what has actually been *observed* from the
Graph API versus what is documented — absent documentation is not confirmation.

### There is no dev environment

Established 2026-08-16 and load-bearing for anyone about to run this locally.
There is **one** of everything: one database (`DATABASE_URL` points at production
Supabase), one Instagram account with a live token, and a CORS allowlist pinned
to the deployed origin. Nothing here is a staging copy.

The consequence is sharper than it sounds. `src/server.ts` starts **seven workers
unconditionally** — gate queue, snapshots, feed-follow snapshots, Gemini queue,
follow recheck, follow-through, token refresh — and the listen callback fires a
token refresh and a snapshot on boot, before any interval elapses. Only the AI
drafts and recovery workers are flag-gated. So a second server started on a
laptop is not a second environment; it is a second set of workers acting on
production beside Railway's, sending real private replies to real people and
racing the deployed token refresher.

`WORKERS_ENABLED` exists for exactly this. It defaults **true**, so production is
unchanged by its absence and Railway needs no new variable. Set it false and the
API, the routes and the database reads all work with no timers:

```
WORKERS_ENABLED=false npm run dev
```

**It is not fully read-only, and the flag does not claim to be.** One startup
write survives: stale reply-draft sends are reconciled with an `updateMany`
against production. It is deliberate — leaving drafts stuck in `sending` is
worse than the write, and it never contacts Instagram — but it is a write, and
anyone treating `WORKERS_ENABLED=false` as an inert observer should know that.

**Reads are otherwise safe; writes through the console never are.** Editing a
keyword or sequence writes to the same production row the live automation reads.

Two related traps, both cost time on 2026-08-16:

- The `.env` `IG_ACCESS_TOKEN` is a **stale seed**, not the live token. The real
  one lives in the `ig_token` table and self-renews. Any script that bypasses the
  token store falls back to the seed and gets Graph code 190, which looks
  exactly like a token crisis and is not one. The server seeds the token cache on
  boot whether or not workers are enabled, for the same reason: a cold cache
  serves the stale seed, and the first Graph calls would fail.
- A local frontend talks to `localhost:3000`, so the console shows empty states
  whenever the API is not up. Those are connection failures, not empty data.

## Capabilities and Constraints

### Console surfaces (11 destinations)

Home sits above four groups — **Measure / Publish / Audience / System** — as built in
`web/src/lib/navigation.ts`, which is the single definition the rail and the mobile
titles both read.

| Route | Group | What it is for |
| --- | --- | --- |
| `/` Home | — | Reply-rate evidence, operational attention, best next move and system pulse. |
| `/insights` | Measure | Reel-scoped: leaderboard, recipe (top-vs-bottom US-fit contrast), experiments. |
| `/funnels` | Measure | Conversation-lifecycle-scoped cohort funnels with drop-off drill-down. Deliberately separate from Insights. |
| `/content` | Publish | Pick a post, attach a keyword. Reels and carousels. |
| `/keywords` | Publish | The words that trigger a sequence. Scoped per post, so one word can send different guides. |
| `/sequences`, `/sequences/:id` | Publish | The DMs sent after a follower replies `DONE`. Text / image / PDF. |
| `/conversations` | Audience | Every comment that triggered a keyword, with its full event log and AI reply drafts. Also the People lens. |
| `/dm-recovery` | Audience | Prospective recovery. **Automatically publishes a public comment** on the original post when policy says so; there is no approval step and no way to force a send. |
| `/historical-recovery` | Audience | Reviewing and approving contact with people whose requests are weeks old. One approval posts publicly on hundreds of real posts. |
| `/activity` | System | Every event the system records, including undeliverable DMs. The diagnostic feed. |
| `/assistant` | System | A read-only business advisor on a persistent thread. Can ask and navigate; cannot send, approve, or configure. |

`/users` is **not** a destination. It redirects to `/conversations?lens=people` —
the same dataset indexed by person, with the same lineage drawer — so old bookmarks
land on the People lens rather than the default Needs reply one
(`AppRoutes.tsx:37`).

### Backend capabilities

Webhook handlers (comments, messages, seen, reactions, postbacks); gate queue with
bounded retry; sequence delivery; follow recheck; DM recovery reminders;
historical recovery campaigns with holdout arms; public recovery dispatch; journey
reconciliation; AI reply drafts and advisor via the Codex runtime; Gemini reel
analysis with a daily spend cap; insights, cohort funnels, follower flow, geo
demographics, feed-follow attribution, spike detection.

#### Durable guide delivery (built, disabled)

A guide send can be planned into a ledger of units, each with its own recorded
outcome, so a resumed delivery continues from the first unsent unit instead of
replaying the whole guide. A captioned image compiles into two units — the media,
then the caption — because Instagram sends them separately.

Delivery states are `planned`, `sending`, `needs_review`, `failed`, `completed`,
and `cancelled`. Unit states are `pending`, `sending`, `sent`, `retryable`,
`failed`, `uncertain`, and `cancelled`.

**`uncertain` is never retried automatically.** When a provider call cannot be
classified, the request may already have delivered a message to a real person, so
the unit is recorded `uncertain`, the delivery moves to `needs_review`, and the
automation stops. The owner resolves it in Conversations with one of three
actions: confirm it was already delivered, retry it while explicitly
acknowledging the duplicate risk, or cancel the delivery. Retry disappears once
Instagram's messaging window closes, because a send is then impossible.

**This path owns no production traffic.** `GUIDE_DELIVERY_ENABLED` is false,
`GUIDE_DELIVERY_ROLLOUT_PERCENT` is 0, and the cohort allowlist is empty, so every
real trigger is still delivered by the legacy sequence sender. Ownership per
trigger is decided once and the two paths are mutually exclusive. Enabling it is a
separate authorized phase; see `docs/guide-delivery-operations.md`.

Guide text is limited to 1,000 Unicode code points, counted as `[...value].length`
— not UTF-16 code units, which would charge an emoji twice.

#### DM recovery states are automation states, not an approval queue

`Scheduled` and `Due` describe what the worker will do and when — they are not a
queue awaiting a human decision. Nothing on the DM recovery page has to be approved
for a reminder to be published; the policy already decided, and there is
deliberately no way to force a send from the dashboard. The only owner actions are
cancel (prevents a future attempt) and mark reviewed (records that a failure was
looked at). Neither can retract a comment Instagram already accepted.

`send_uncertain` is a fourth thing again: the attempt was dispatched and its
outcome was never confirmed. **It is never retried automatically.** Resolving it is
an explicit owner action, because the alternative is publishing the same public
comment twice on a real person's post.

Historical Recovery keeps its own destination and its own safety boundary. One
approval there posts public comments on hundreds of real posts, so the two recovery
surfaces are grouped in the rail but never made peer tabs — tabs are the
habituation surface.

#### Client transport guarantees

Two properties the console now depends on, recorded because the UI's copy is built
on them:

- **Reads are abortable.** A read that exceeds its deadline aborts the request
  rather than abandoning it, so a page settles into a real error state instead of
  holding skeletons, and a cancelled read stops costing the user data. Retry is
  once, and only for a timeout, a transport failure, or a 5xx.
- **A mutation's outcome can be unknown.** Once the request is dispatched, a
  timeout, a dropped connection, or a 502 all leave the same question open, so the
  console reports *"Still confirming"* rather than *"failed"*, and never retries on
  the owner's behalf. Recovery is reconciliation: read the canonical state and find
  out. Every route's canonical read is written down in
  `docs/client-operation-contracts.md`.

### Hard constraints

- **One permission level.** `ADMIN_EMAIL` is a comma-separated allowlist and every
  allowlisted address gets identical full access. There are no roles today — the
  creator and the operator see exactly the same console.
- **A person defines every sending policy; AI never decides to send.** Every AI
  capability ships OFF and is enabled deliberately; AI-authored copy requires
  human approval. Template-driven gate, sequence, and recovery automation may
  execute only after the owner configures it, and turning AI off must never
  disable that existing automation. `AI_SEND_ENABLED` is separate from drafting.
  The Assistant has no send, approve, or settings control anywhere in it, by
  construction.
- **Never `z.coerce.boolean` for an env flag** — it parses the string `"false"` as
  `true`. Use `src/config/booleanFlag.ts`.
- **Meta demographics report exactly 45 countries.** Summing them undercounts
  followers by ~5%; use `followers_count` for the true total.
- **The IG token lives in the `ig_token` table and self-renews every 6h.** The env
  var is the seed and the expired-token rescue, nothing more.
- **`100:2534025` must never enter the settings-blocked allowlist.** It is the
  invalid-comment family, not a recipient-settings rejection, and it is 1,347 of
  1,356 historical `dm_failed` events. Refused at startup.
- **Supabase MCP is read-only.** Analyze there; write through a `scripts/*.ts`
  Prisma one-off that supports `--dry-run` before `--write`.
- **Rate limits and spend caps are load-bearing**, not tuning: gate retry batch,
  Gemini daily USD budget, recovery hourly and global daily caps, worker
  self-throttling on snapshot age.

### Information architecture

Settled 2026-08-16. **This section is the record of which destinations exist and
what they are called.** DESIGN.md owns how the rail looks; the rail's code
follows both and carries no roadmap of its own — an earlier `Sidebar.tsx` comment
predicted three merges, two of which were later rejected, and a component
predicting the future is design authority nobody agreed to.

Four groups, eleven destinations:

| Group | Destinations |
| --- | --- |
| **Measure** | Insights · Funnels |
| **Publish** | Content · Keywords · Sequences |
| **Audience** | Conversations · DM recovery · Historical recovery |
| **System** | Activity · Assistant |

Home sits above the groups.

**Decided:**

- **Insights and Funnels stay separate.** They answer different questions —
  *which content worked* versus *where the journey loses people* — and operate on
  different units, reels versus conversation cohorts. Home presents operational
  evidence and attention; general audience reporting is monitored elsewhere.
- **People becomes a view inside Conversations.** *Built — the People lens;
  `/users` redirects.* It is an index over the same data: `users.routes.ts`
  sources its directory from `Conversation.igUserId`, the page was ~109 lines of
  list and search, and it opens the same `UserLineage` drawer Conversations
  opens.
- **Why People folds in and DM recovery folds out, in the same change.** The test
  is not how related the data is — both are the same conversations. It is what
  the control does. Every lens in that filter row reads what already happened;
  People reads, recovery sends. Recorded because the two moves look contradictory
  and the next person to reorganise this row will need the rule, not the outcome.
- **DM recovery leaves Conversations and becomes its own destination.** *Built —
  `/dm-recovery`.* It was a fourth lens inside an 892-line page, carrying ~679
  lines of its own machinery with holdout cohorts and experiment measurement.
  That is a distinct job, not a filter on the inbox. The sharper reason emerged
  while building it: every other control in that filter row reads what already
  happened, and this one can automatically publish a reminder on the original
  Instagram comment. A publishing control does not belong in a row of reading controls. Asserted in
  `Conversations.test.tsx` so the pill cannot come back.
- **DM recovery and historical recovery stay separate destinations, grouped but
  never tabbed.** `HistoricalRecovery.tsx` states the reason and it is a safety
  boundary, not a preference: *"one approval here posts public comments on
  hundreds of real posts. The two must not be one screen where a habitual click
  means something different."* Peer tabs are precisely the habituation surface.
  Grouping in the rail is free; a shared page is not.

**Explicitly still open, and not to be treated as agreed:**

- **Keywords into Content.** Overlap, not duplication. Content attaches a
  keyword to a post and then defers: *"Manage or delete keywords from the
  Keywords page."* Keywords holds the account-wide inventory, editing, pausing,
  deletion, and the legacy global rows. Needs its own workflow review.
- **Assistant into a command palette.** Assistant is a 264-line surface with a
  persistent thread, history, evidence, connection and disabled states, and a
  multi-line composer — not a question field. A global drawer behind a visible
  control *and* a shortcut may be right; a shortcut alone would cost
  discoverability, mobile access, and history. Needs its own design review.
  (The `cmdk` dependency is not evidence either way: it is used for the country
  picker and nothing else.)

**Eleven destinations is the honest count, and it did not shrink.** Removing
Users and adding DM recovery was net zero, as predicted. The gain is that every
destination is now one distinct job rather than two overlapping ones —
coherence, not brevity. A count reduction is only worth taking when the receiving
surface genuinely absorbs the destination it removes.

*Audience group built 2026-08-16: `/dm-recovery` added, `/users` folded into the
Conversations People lens and left as a redirect. Measure, Publish and System
were unchanged by that work.*

### Terminology (use these words; they are the product's vocabulary)

*keyword*, *gate* / *gate message*, `DONE`, *sequence*, *resource* / *guide*,
*conversation*, *journey*, *capture*, *funnel stage*, *bypassable*, *cohort*,
*DM recovery* (prospective) vs *historical recovery* (weeks-old requests),
*US-fit score*, *spike*.

### Explicitly undecided

- **Whether this ever opens to other creators.** Not answered. It is explicitly
  **not** being designed for: build for the single shared login until told
  otherwise, and do not add multi-tenant seams speculatively.
- **Positioning** (below) is still derived from code rather than confirmed.

## Brand Commitments

- **Name:** Tiny Soho / `@tinysoho`.
- **Follower-facing voice, binding:** "Warm, practical, concise, and supportive.
  Never diagnose or shame a parent." It governs DMs and public replies. The
  console's own copy should sit in the same register. Held as a working
  commitment rather than a frozen contract — the user allowed a small chance the
  wording changes.

The console already has a visual system in code. It is **not** recorded here on
purpose; run `/impeccable document` if it should be captured as design authority.

## Evidence on Hand

**Real, in production, on one live account:**

- ~1,353 backend tests, 0 skipped.
- 1,356 historical `dm_failed` events, 1,347 of them the `100:2534025` signature.
- Gemini origin classification measured on 50 real gate users: the name-token list
  caught 3, the model caught 22, with no Western false positives.
- 1,107 conversations with no read tracking — unknown, not unseen.
- Guide follower retention measured at ~22% yield; 11 of 12 converts stayed 21
  days.

**Documents:**

- `docs/meta-verification.md` — observed Graph API behavior vs documented.
- `docs/funnels.md` — the cohort-funnel doctrine.
- `docs/backlog/2026-08-14-*.md` (2 files) and
  `docs/feature-requests/2026-08-13-*.md` — swept, unstarted feature requests.
  Currently untracked in git.

**What does not exist, and must never be fabricated:** customers, testimonials,
case studies, press, pricing, licensing, or benchmarks. This is a personal
automation for one account. There are no external users.

## Product Principles

1. **Never assume — verify against the real source.** Every claim traces to
   production data, the Graph API, research, or code. Line numbers get re-grepped;
   counts get re-run. Absent documentation is not confirmation.
2. **A number that cannot be trusted must not be printed as a number.** "15.6%"
   over 32 people and over 3,200 are different claims, and only one of them is a
   number. Unknown renders as unknown, never as zero.
3. **Two jobs, equally first-class.** The growth decision and the running machine.
   Work that serves one at the other's expense is a regression.
4. **Human authority over sending.** A person configures every template and
   automation policy. AI drafts and proposes; a human approves AI-authored copy.
   Configured template automation may execute within its recorded safety gates.
5. **Two readers, one console.** It must be legible to the creator without her
   knowing the internals, and complete enough for the operator who built them.

## Accessibility & Inclusion

No product-specific standard has been established. Recorded as observation, not
requirement: `lang="en"` is set and there are ~61 accessibility affordances in the
console (`aria-label`, `aria-live`, `focus-visible`), but **no
`prefers-reduced-motion` handling anywhere**, despite framer-motion animating page
entrances throughout. A known gap, not yet a commitment.
