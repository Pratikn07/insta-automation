# Unstarted Feature Requests — Instagram Automation

**Compiled:** 2026-08-14
**Source:** sweep of all 102 session transcripts in
`~/.claude/projects/-Users-pratik-nandoskar-Documents-working-mch-insta-automation/`
(113 MB, 2026-06-27 → 2026-08-11), cross-checked against `main` at `6e6834d`.

**Audience:** an agent picking up one of these cold, with no memory of the
conversations that produced them.

---

## How to use this document

Each request below is self-contained. Pick **one**, read it end to end, then
follow the repo's normal flow:

1. `superpowers:brainstorming` → design doc in `docs/superpowers/specs/`
2. `superpowers:writing-plans` → plan in `docs/superpowers/plans/`
3. `superpowers:executing-plans` → implementation on a branch/worktree

Requests marked **Design already exists** skip step 1 — the spec is written and
approved; go straight to a plan.

### Verify before you build — non-negotiable

Every file path, line number, and measurement in this document was verified on
2026-08-14, but **the codebase moves and the numbers are live production data**.
The standing rule on this project is: *never assume or hypothesise; every
decision must be data-, API-, research-, or code-driven; verify against the real
source before asserting it.*

Concretely, before you act on any claim here:

- **Line numbers** — re-`rg` for the symbol, don't trust the `:NNN`. Several
  citations inside the older spec files are already stale (noted where known).
- **Counts and rates** — re-run against production Supabase. Numbers here carry
  their measurement date.
- **Meta API behaviour** — check `docs/meta-verification.md` first; it records
  what has actually been observed from the Graph API versus what is documented.
  Absent documentation is not confirmation.
- **Supabase MCP is read-only.** `execute_sql` cannot INSERT/UPDATE. Do analysis
  there, then write through a `scripts/*.ts` Prisma one-off that supports
  `--dry-run` before `--write`.

### Repo conventions you need

| Thing | Command / location |
|---|---|
| Backend tests | `npm test` (vitest, ~1,353 tests, 0 skipped) |
| Backend typecheck | `npm run build` (`prisma generate && tsc`) |
| Web tests | `cd web && npm test` |
| Web build | `cd web && npm run build` |
| Web lint | `cd web && npm run lint` |
| Migrations | `npx prisma migrate dev` locally; `prisma migrate deploy` runs on Railway boot |
| Backend deploy | Railway — `api` service |
| Frontend deploy | **`cd web && vercel --prod`** — the Vercel project is *not* Git-connected, so pushing to `main` does **not** deploy the frontend |
| Deploy runbook | `DEPLOY.md` |

Two traps that have bitten this project before:

- **Never use `z.coerce.boolean()` for an env flag.** `FLAG=false` parses as
  `true`. Use `src/config/booleanFlag.ts`. When auditing a flag, parse it and
  print the parsed value — don't eyeball the string.
- **A local `web` build without `VITE_SUPABASE_*` env vars exits 0 but emits a
  bundle with no app code.** Grep the built bundle for expected strings; don't
  trust the exit status.

### Product context an agent will not infer from the code

- The account (`@tinysoho`) is a **toddler-parenting** account selling to a
  **Western (US/UK/CA/AU/Western Europe)** audience. Reach and engagement are
  already US-dominant; the bottleneck is reach→follow conversion, not geography
  acquisition.
- **~93% of logged comments are mechanical** (bot replies + bare keywords); only
  ~2.6% are organic. Comment volume is not an audience signal.
- The funnel is: comment a keyword → public reply → private gate DM → user
  replies `DONE` → guide delivered over DM.
- **Meta's 24-hour messaging window is the hard constraint on everything.** An
  automated send outside it is prohibited. The user's own inbound DM reopens it.
  This is why owner approval exists on the AI paths — a human-approved send is
  what makes a delayed follow-up legal.

---

## Index

| # | Request | State | Size | Value |
|---|---|---|---|---|
| [FR-1](#fr-1--dm-personalization-the-child-age-loop) | DM personalization — the child-age loop | Design approved, zero code | L | **Highest — the only one that changes the business** |
| [FR-2](#fr-2--conversations-rebuild-one-queue-one-person-view) | Conversations rebuild — one queue, one person view | Mockups only, no spec | M–L | High (contains a correctness bug) |
| [FR-2a](#fr-2a--person-timeline-drops-ai-and-recovery-events-carve-out) | Person timeline drops AI + recovery events | Bug, unstarted | S | **Ship independently — has a deadline** |
| [FR-3](#fr-3--origin-gate-on-the-keyword-auto-reply) | Origin gate on the keyword auto-reply | Measured gap, unstarted | S–M | High (reach hygiene, 924/wk) |
| [FR-4](#fr-4--broadcast-channel-invite-in-the-delivery-flow) | Broadcast-channel invite in the delivery flow | Proposed, blocked on owner input | S | Medium |
| [FR-5](#fr-5--known-follower-personalized-comment-gate) | Known-follower personalized comment gate | Proposed, explicitly parked | S | Low (politeness, not growth) |
| [FR-6](#fr-6--agegender-demographics--navigation-media-breakdown) | Age/gender demographics + `navigation` media breakdown | Proposed, unanswered | S–M | Medium (free under existing grant) |
| [FR-7](#fr-7--ai-surfaces-are-built-and-switched-off) | AI drafts / follow-ups / advisor — switched off | Built, never activated | Ops | Blocks FR-2's queue |

Also see [Not feature requests](#not-feature-requests--but-open) for in-flight
branches and one pending production action.

---

## FR-1 — DM personalization: the child-age loop

**State:** Design approved 2026-08-04. **Zero implementation.**
**Design already exists:** [`docs/superpowers/specs/2026-08-04-dm-personalization-logic.md`](../superpowers/specs/2026-08-04-dm-personalization-logic.md)
**Related (superseded, read for reasoning only):** [`2026-08-04-personalized-dm-ecosystem-design.md`](../superpowers/specs/2026-08-04-personalized-dm-ecosystem-design.md)
**Runtime it plugs into:** [`2026-08-04-codex-tiny-soho-integration-design.md`](../superpowers/specs/2026-08-04-codex-tiny-soho-integration-design.md) + [its plan](../superpowers/plans/2026-08-04-codex-tiny-soho-integration.md)
**Size:** Large. Realistically 3–4 slices.

### Why

Measured 2026-08-04: **95% of people who receive a guide never come back.**

```
1 keyword only  : 1,203 of 1,266 completers   (95%)
2+ keywords     :    63 of 1,266               (5%)
```

`SLEEP` was delivered 747 times, `PICKY` 6 times — not because only 6 parents
have a picky eater, but because only 6 ever saw the word PICKY. **The keyword is
a doorway, not a diagnosis.** It records which reel someone scrolled past, not
what is hardest in their house.

Second measured leak: `message_unhandled` = 673 events, ~7/day — engaged parents
who wrote something real and got nothing back.

### What already shipped (the prerequisite)

Commit `12fe961` made the guide library machine-readable. Verified present in
`prisma/schema.prisma`:

- `Resource.kind`, `Resource.theme`, `Resource.ageMinMonths`, `Resource.ageMaxMonths`
  (index at `@@index([theme, ageMinMonths, ageMaxMonths])`)
- `ResourceMessage.altText` — transcriptions of 24 image pages, so image-only
  guides like `Picky` (a 10-page handbook that was ten UUID filenames) are
  quotable page by page.

That is the whole of what exists. **Verified 2026-08-14:** no `child_age_months`,
no `age_asked_at`, no `age_source`, no `age_confidence`, no `circle_invite_sent`,
no `guideCandidates`, no age parser anywhere in `src/`.

### What to build

#### Slice A — ask the question

One question, asked **after** the guide, never before. Guide delivery is the one
proven conversion (~45/day); the question is additive and ignorable, so the worst
case is today's behaviour.

> "How old is your little one? 🤍"

It **merges into the existing closing line** — no extra message, and the follow
ask is not dropped:

```
follower     → "Thanks for following! 💛 How old is your little one? 🤍"
non-follower → "Follow @tinysoho so you don't miss the next one 🙏
                And how old is your little one? 🤍"
```

**Both send sites must change or the question fires on one path only.** The spec
cites `messageHandler.ts:100` and `:231` — **those line numbers are stale.**
Verified 2026-08-14, the real sites are:

- [`src/handlers/messageHandler.ts:43-44`](../../src/handlers/messageHandler.ts#L43) — `FOLLOWER_THANKS` / `FOLLOW_NUDGE` constants
- [`src/handlers/messageHandler.ts:382`](../../src/handlers/messageHandler.ts#L382) — cold-DM / redelivery path
- [`src/handlers/messageHandler.ts:588`](../../src/handlers/messageHandler.ts#L588) — gated path

Both compute `const closing = profile.isFollower ? FOLLOWER_THANKS : FOLLOW_NUDGE;`
and log `follow_nudge_sent`.

This modifies existing automation, so per the Codex spec's safety rule it stays
in the existing API and is **not** routed through the Codex runtime.

Needs `age_asked_at` on the sender (`IgUser`). **Not** on `ConversationState` —
that enum tracks guide delivery, and a completed conversation must stay
completed.

#### Slice B — parse the answer

Parents already volunteer age unprompted, in these real observed forms:

| Form | Real message | → months |
|---|---|---|
| plain months | "My baby is also 18 months" | 18 |
| plain years | "my 2 year old grandson" | 24 |
| decimal years | "My daughter is about 1.5 years old" | 18 |
| mixed | "My daughter is 2year 1 month old" | 25 |
| no space | "Mera v aaj hi 20months complete hua" | 20 |
| Hinglish | "Mera 2 year boy kabi b pot pr nhi baithta" | 24 |
| infant months | "My baby is 1.5 month old" | 1 |

**Regex first; the model only on a miss.** Common cases are cheap; `1.5 years`,
`2year 1 month`, and Hinglish need a model.

**The parser must be able to decline.** Two real messages contain a number plus
"months" that is *not* the child's age:

> "for about **6 months** he's stuck in this limited diet"
> "Ab soch rhi hu **2 months** aur ruk jau" (thinking of waiting 2 more months)

A naive parser records a 6-month-old with a picky-eating problem. **On low
confidence return null and let routing proceed *without* the age filter — never
with a guessed one.**

Store as nullable `child_age_months` + `age_source` + `age_confidence` on the
sender, so a parent who answers once is never asked again.

**Ordering against existing automation.** Keyword matching keeps precedence —
[`src/handlers/messageHandler.ts`](../../src/handlers/messageHandler.ts) checks
keywords first, deliberately, so someone with an open `sleep` gate who types
`potty` starts a potty gate. A reply containing a keyword is a keyword, never an
age answer.

```
1. keyword match        → existing flow (unchanged)
2. open gate            → existing flow (unchanged)
3. awaiting age answer  → parse; success routes, failure falls through
4. otherwise            → Codex shadow draft, replacing today's silence
```

#### Slice C — route to a guide (the drafter selects, never authors)

The model **never writes parenting advice.** Retrieval narrows candidates in SQL;
the model chooses one; the reply is a template.

```sql
WHERE kind IN ('guide','recipes','activity')   -- product_links unreachable
  AND theme = :theme
  AND (age_min_months IS NULL OR :age >= age_min_months)
  AND (age_max_months IS NULL OR :age <= age_max_months)
```

Verified behaviour from the design session:

- **Grandma, 24mo, eating** → 11 candidates (4 guides + 7 recipe sets); zero
  affiliate links; `Car` — the top keyword hit before these columns existed —
  correctly absent.
- **3-year-old, learning** → `Play` (6–18mo) and `GUIDE` (18–24mo) excluded by
  age. The model never sees them.

`kind='product_links'` is a **hard filter, not a warning**: `Link`, `Book`, and
`Dough` are bare Amazon affiliate URLs, and handing one to a struggling parent is
the worst failure available.

**Change required to the Codex plan.** Task 6's `DmDraftRequest.guideContext` is
a *single nullable guide*. Routing needs the candidate *set*:

```ts
guideCandidates: Array<{
  keyword: string;
  resourceName: string;
  kind: "guide" | "recipes" | "activity";
  theme: string | null;
  description: string | null;
  pageExcerpts: string[];   // from alt_text, bounded
}>                          // max 8; already age/theme/kind filtered in SQL
```

The existing API does the filtering, so the runtime still receives no database
access. Everything else in Task 6 is unchanged: ephemeral thread, no tools,
`approvalPolicy: never`, untrusted transcript, thread deleted after validation.

#### Slice D — business filter + the Circle invite

**Business filter.** Not every DM is a parent. Real inbound:

> "Welcome to Trendy Adaah Jewels 💎 … Bridal Jewellery / Party Jewellery"
> "And I will send you an affiliate link for amazon product! So, you will get 20%"

High `follower_count` + promotional language → **skip the question entirely.** Do
not ask a jewellery brand about their toddler.

**The Circle.** Completely un-instrumented: `circle_events = 0` across 1,445
guides delivered. Decision on record: **keep all 23 existing footers, and
additionally send a warm, age-aware invite after they answer.** Stripping an
invite that has shipped 1,445+ times on zero evidence is the one irreversible
move available; two touchpoints also make the variants comparable.

**Attribution limit, state it in the UI:** no Graph API endpoint exists for
broadcast-channel membership, so per-user joins are unknowable. Log
`circle_invite_sent` and record member counts manually. That is correlation
("300 warm invites in August; channel went 180 → 260"), not attribution.

#### Slice E — backfill (do this early, it unblocks evaluation)

The Codex spec says DM history starts "from deployment forward" and correctly
refuses to invent messages. But **2,511 `message_received` events already exist**
in `event_log` with sender, text, `mid`, and timestamp — real recorded history,
not reconstruction. Backfilling them into `DmMessage` is safe (the `mid`
uniqueness constraint makes it idempotent) and it is where the ~113 substantive
parent questions live. Without it, shadow drafting has almost nothing to evaluate
against.

### Acceptance criteria

- The age question appears on **both** closing-line paths, follower and
  non-follower, and the follow ask is not dropped from the non-follower variant.
- A parent who has answered once is never asked again (`age_asked_at` +
  `child_age_months` both consulted).
- The parser returns `null` — not a guess — for both real decline cases above;
  a unit test asserts each verbatim.
- Keyword match still wins over age parsing. A reply containing a live keyword
  starts that keyword's flow, with a test proving it.
- Routing SQL never returns a `kind='product_links'` row, asserted by test.
- Business-classified senders are never asked the question.
- Nothing sends outside the 24-hour window without owner approval.

### Verification

`npm test` and `npm run build` clean. Add fixtures for every row of the parse
table above, plus the two decline cases. Run the backfill script `--dry-run`
against production and eyeball the counts before `--write`.

### Measure it

| Win | Metric | Baseline (2026-08-04) |
|---|---|---|
| Answer rate | parents who answer the age question | unknown — measure first |
| Second guide | users requesting 2+ keywords | 63 of 1,266 (5%) |
| No silence | `message_unhandled` | ~7/day, 673 total |
| Followers who stay | guide-follower yield; 21-day follow-through | ~22% |

**Answer rate is the leading indicator.** If it is near zero the loop does not
work and no downstream metric matters. Build Slice A + B and measure before
committing to C and D.

### Known content gap this will expose

Several inbound parents have infants ("3 months old", "1.5 month old"), and the
only catalog item covering them is `Sleep` (2–24mo). A 3-month-old's parent
asking about food has nothing to receive. Recording ages makes that measurable —
it is a content problem for the owner, not a code fix.

---

## FR-2 — Conversations rebuild: one queue, one person view

**State:** Brainstormed 2026-08-07 with four working mockups. **No spec was ever
written; no code.** The session ended on an unanswered question (below).
**Mockups:** https://claude.ai/code/artifact/155c50c6-a660-4a3d-9867-57fdeb0dcd33
— four panels ("Today", Option A, Option B, Option C), rebuilt from live markup
using the real tokens from `web/src/index.css`. Handles and message text in the
mockup are invented.
**Size:** Medium–Large for the full queue; see FR-2a for the slice worth shipping
first.

### Why

The tab strip is **seven identical pills doing two categorically different
jobs**:

```
[Needs reply] [DMs] [DM recovery]   Automation journeys   [All] [Waiting] [Delivered] [No confirmed reply]
└──────── switches WHAT you're looking at ────────┘        └──────── filters ONE of them ────────┘
```

Same `rounded-full` styling, same row, separated only by 11px grey text. Clicking
"Waiting" silently *also* switches the lens to journeys — a filter that secretly
changes modes. And `DmRecoveryList` has **its own seven-pill strip** (Scheduled /
Ready / Sent / Suppressed / Control / Attention / All) plus two label controls,
so on that lens you are looking at **fourteen pills in two near-identical rows**.

Verified 2026-08-14: [`web/src/pages/Conversations.tsx`](../../web/src/pages/Conversations.tsx)
is **892 lines** holding 4 lenses, 4 drawers, and 3 queries.

The deeper diagnosis: **Conversations is four object-type browsers, while the
owner thinks in people** — and the person view that already exists
(`UserLineage`, `/users`) is stale and buried under a separate nav item.

### The owner's actual workflow

Stated in the session: **one scan, then one drill-in.** Four lenses means
scanning four lists to know what is off, each showing the person through a
keyhole. So "break it into more places" is the wrong instinct — the goal is
**fewer lists, deeper drill-in.**

### The three options that were presented

**A — one queue, one complete person view (recommended).**
Conversations becomes a single list answering one question: *who needs looking
at?* Merged across all four sources — draft awaiting approval, waiting on reply,
gate bouncing, recovery pending. **One row per person**, not per object, with
badges saying why they surfaced. Click a row → the person view opens with their
whole story: comment, gate, guide, DMs, AI drafts, recovery, follow status.
`/users` search stays as the rare "I know the name" path into the same view. The
7-pill strip dies; what remains is a real segmented control for
everything / needs me / stuck.

**B — person-first.** Merge Conversations and Users entirely; lenses become
columns and filters. Conceptually cleanest, biggest change — but a person
directory is the wrong shape for queue work, and queue work becomes the owner's
job the day AI sending turns on.

**C — minimal.** Split the two pill groups into visually distinct controls
(segmented control for lens, dropdown for journey filter), stop "Waiting"
secretly switching modes. An afternoon's work; treats the symptom.

**Recommendation on record: A, in two slices.** Slice one is C's controls plus
the timeline fix ([FR-2a](#fr-2a--person-timeline-drops-ai-and-recovery-events-carve-out)).
Slice two is A's merged queue — by then there will be real shadow drafts to look
at, so a row's content is observed rather than guessed. Splitting them means
slice one is worth shipping even if slice two never happens.

### Defining "Needs you" — this was worked out, use it

The test: **if the owner went away for a week, would this resolve itself?** If
yes, it is not theirs. "Needs you" means *a human decision is the only thing that
will move this forward* — not "something looks wrong."

**Passes:**

| State | Where | Why it's theirs |
|---|---|---|
| `pending_approval` | draft | Approve, edit, or discard — nothing else moves it |
| `needsReply` (no draft) | thread | A real inbound nobody has answered |
| `send_failed` | draft | Approved, didn't leave. Retry is a judgment call |
| `send_uncertain` | draft | May already have sent. Someone must go look at Instagram |
| `send_failed` / `send_uncertain` / `tracking_unavailable` | recovery | — |

**Fails:** `drafting` (worker mid-flight) · `awaiting_done` (their turn) ·
`retrying` (the banner literally says "No action needed") · `scheduled` /
`control` / `suppressed` (working as designed) · `completed` / `replied`.

**Half of this is already written:**
[`web/src/components/conversations/dmRecoveryViewModel.ts`](../../web/src/components/conversations/dmRecoveryViewModel.ts)
computes exactly this as `NEEDS_REVIEW` and already exposes `canMarkReviewed`.
It is just trapped inside one lens. **Reuse it; do not reimplement.**

**Un-approvable drafts.**
[`web/src/components/conversations/replyDraftView.ts`](../../web/src/components/conversations/replyDraftView.ts)
short-circuits the whole approval gate on `if (!sendEnabled) return { canApprove: false, reason: "send_disabled" }`.
With `AI_SEND_ENABLED=false` in production, **every draft is currently
un-approvable.** Decision on record: **they don't count toward the queue** — the
queue counts only actionable things, no special case, no extra "waiting on a
setting" UI. That rule matters beyond launch because `AI_SEND_ENABLED=false` is
also the rollback switch (`DEPLOY.md` §7.7), so the condition recurs at the worst
possible moment.

### The unanswered question — resolve this before speccing

The session ended here. **Ask the owner:**

> Realistically, how often are you in this admin — more than once a day, or
> roughly once in the morning?

It matters because of the follow-up clock. From
[`src/services/replyDraftPolicy.ts:2`](../../src/services/replyDraftPolicy.ts#L2):

```ts
export const FOLLOW_UP_DELAY_MS  = 12   * 60 * 60 * 1000;  // eligible: delivered + 12h
export const FOLLOW_UP_WINDOW_MS = 23.5 * 60 * 60 * 1000;  // expires:  inbound   + 23.5h
```

23.5 hours is **Meta's 24-hour window with a 30-minute safety margin** — an
external hard stop, not a tunable. The guide goes out essentially the moment
someone replies DONE, so `deliveredAt ≈ inboundAt`, making the real actionable
window **≈11.5 hours**, narrower whenever delivery lags.
`computeFollowUpSchedule` returns `null` outright when `eligibleAt >= expiresAt`.

A real person through it:

| | |
|---|---|
| Tue 8:00pm | Replies DONE, guide delivered |
| Wed 8:00am | Follow-up becomes approvable |
| Wed 7:30pm | **Permanently dead** |
| Wed 9:00pm | Owner opens the admin. It was never there. |

Evening is when Instagram engagement happens, so this is the modal case, not a
corner case. The proposal on the table was: **remaining window is the queue's
default sort, not a badge** — it is the only thing in the system where waiting a
few hours destroys the option permanently. If the owner is in the admin several
times a day, that is over-indexing; if once each morning, roughly half of these
die overnight unseen. **Their answer decides the default sort.**

### Refactor prerequisite

[`web/src/components/UserLineage.tsx:6`](../../web/src/components/UserLineage.tsx#L6)
imports `EventRow` from `@/pages/Conversations` — a shared component reaching
into a page. That is why the file is hard to move. **Move `EventRow` into
`components/` first**; any of the three options needs it.

### Acceptance criteria

- One list, one row per person, merged across drafts / threads / journeys /
  recovery; badges say why each surfaced.
- The queue contains only rows that pass the "Needs you" test above.
- Un-approvable drafts (`sendEnabled === false`) are excluded, with no
  special-case UI.
- `dmRecoveryViewModel`'s `NEEDS_REVIEW` logic is reused, not duplicated.
- `EventRow` lives in `components/`, and no component imports from a page.
- Default sort matches the owner's answer to the cadence question.

---

## FR-2a — Person timeline drops AI and recovery events (carve-out)

**State:** Correctness bug, identified 2026-08-07, **still open**. Verifiable in
30 seconds.
**Size:** Small. **Ship this independently of FR-2 — it has a deadline.**

### Correction to the original 2026-08-07 report

That session described this as *"the backend writes `ai_reply_sent` and
`send_no_confirmed_read_reminder` to the event log, neither is in the allowlist."*
**Re-verified 2026-08-14 against the code, and that framing is wrong on the
specifics — the underlying problem is real and larger.** Do not go looking for
those two event kinds; they do not exist:

- **`ai_reply_sent` is not an event kind.** Only `ai_reply_send_failed` and
  `ai_reply_send_uncertain` are ever logged
  ([`src/api/ai.routes.ts:452`](../../src/api/ai.routes.ts#L452) and
  [`:469`](../../src/api/ai.routes.ts#L469)). A **successful** AI send writes a
  `DmMessage` row and logs no event at all.
- **`send_no_confirmed_read_reminder` is a `DmRecoveryTriggerKind` enum value**
  ([`src/services/dmRecoveryRepository.ts:25`](../../src/services/dmRecoveryRepository.ts#L25)),
  not an `event_log` kind. Recovery reminders log `dm_recovery_sent` /
  `dm_recovery_sent_late` / `dm_recovery_suppressed`.

### The actual bug — two layers

**Layer 1: the lineage endpoint never reads `DmMessage`.**
[`src/api/users.routes.ts:79`](../../src/api/users.routes.ts#L79) builds the
response from `prisma.conversation.findMany` plus `prisma.eventLog.findMany`
only. Since a successful AI send is recorded *exclusively* as a `DmMessage` row
and logs no event, **an AI reply that actually reached a parent is completely
invisible in the person view** — not mislabelled, absent. No frontend change can
fix this; the endpoint has to read `DmMessage` too.

**Layer 2: the frontend allowlist covers 4 of 66 event kinds.**
[`web/src/components/UserLineage.tsx:64`](../../web/src/components/UserLineage.tsx#L64):

```ts
const threadEvents = events.filter(
  (e) => USER_KINDS.has(e.kind) || BOT_KINDS.has(e.kind),
);
```

`BOT_KINDS` (lines 19–24) contains exactly four entries — `public_reply_sent`,
`dm_sent`, `sequence_completed`, `follow_nudge_sent`. The backend writes **66
distinct kinds** via `logEvent(` with a literal string (count as of 2026-08-14;
re-run the command below, and check for any dynamically-constructed kind the
regex would miss). Everything else drops out of the thread,
including every `dm_recovery_*`, every `historical_recovery_*`, both
`ai_reply_send_*`, plus `dm_failed`, `public_reply_failed`, `gate_abandoned`, and
`follow_required`. They appear only in the raw "Full timeline" below, rendered as
lowercase de-underscored text, because `KIND_LABELS` in
[`web/src/lib/eventLog.ts:1`](../../web/src/lib/eventLog.ts#L1) has no entry for
them either.

To regenerate the full kind list yourself:

```bash
rg -oN 'logEvent\(\s*"[a-z_]+"' src/ | sed 's/.*logEvent(\s*"//;s/"//' | sort -u
```

### Why it has a deadline

The day `AI_SEND_ENABLED` flips to `true` ([FR-7](#fr-7--ai-surfaces-are-built-and-switched-off)),
a parent can receive an AI-written DM and **the screen the owner uses to check on
that person will not show it at all.** That is not a design preference — it is a
bug with a date on it.

### What to build

1. **Backend first.** Extend `/users/:igUserId/lineage` to merge `DmMessage` rows
   into the timeline alongside `event_log`, carrying direction, source, and
   whether it originated from an approved AI draft. Decide the dedupe rule where
   a `dm_sent` event and a `DmMessage` describe the same send.
2. **Then the allowlist.** Replace the four-entry `BOT_KINDS` set with a
   deliberate classification of all 68 kinds into *thread bubble* / *timeline
   only* / *hidden*. An allowlist that silently drops the majority is the failure
   mode here; make the default visible rather than invisible.
3. Add `KIND_LABELS` entries for every kind that reaches the UI.
4. **Add a test that fails when a new backend `logEvent` kind has no
   classification and no label.** Without it this regresses on the next feature.
5. Render a recovery reminder distinctly — it is a **public comment**, not a DM,
   and must not look like one inside a chat thread.

### Verification

`npm test` (backend) and `cd web && npm test && npm run build`. Then, against
production data, open a person who has a `dm_recovery_sent` event and confirm it
renders in the thread with a proper label and the right channel affordance. Once
FR-7's shadow run has produced an approved send, repeat for a `DmMessage`-only
AI reply — that is the case layer 1 exists to fix.

---

## FR-3 — Origin gate on the keyword auto-reply

**State:** Measured 2026-08-09, never actioned. The uncommitted `.env.example`
edit in the working tree currently **documents** this as out of scope rather than
fixing it.
**Size:** Small–Medium. The gate logic already exists three times over; this is
about applying it to a fourth path and deciding the policy.

### The gap

`DM_RECOVERY_WESTERN_ONLY=true` in Railway production gates the South-Asian
exclusion at three enforcement points, **all inside the recovery feature**:

- `src/services/dmRecoveryPolicy.ts` (Feature 1, prospective)
- `src/services/historicalRecoveryEligibility.ts` (Feature 4, selection)
- `src/services/historicalRecoveryRecheck.ts` (re-applied on the live verdict pre-send)

**It does not cover the keyword auto-reply.**
[`src/handlers/commentHandler.ts`](../../src/handlers/commentHandler.ts) calls
`replyToComment(comment.id, keyword.publicReply)` with no origin check at all —
verified 2026-08-14, `rg -i "origin|western|south"` against that file returns
**zero hits**. That is also a *public* comment on the person's own comment, so it
carries the identical reach cost the flag exists to avoid.

Measured over the 7 days to 2026-08-09, public comments to `south_asian` users:

| Path | Count |
|---|---|
| Keyword auto-reply | **924** |
| Recovery reminders | **1** (and that one was a classification race — `unknown` at send, reclassified ~5 min later) |

So the flag works exactly as designed and covers **~0.1%** of the actual
out-of-market public-comment volume.

### Decisions the owner must make first — do not build past these

This is not a mechanical port. Three genuine product questions:

1. **Does withholding the public reply mean withholding the guide too?** The
   recovery reminder is a re-contact; the keyword reply is the *acknowledgement
   of a request someone just made*. Silently not replying to someone who
   comments is a materially different act from not re-nudging them. A plausible
   middle path is: send the private gate DM as normal, skip only the public
   comment.
2. **Latency.** Recovery classifies out of band. The keyword reply fires inside
   the webhook. Is a Gemini origin call on the hot path acceptable, or must this
   read a cached verdict and fail open when there is none?
3. **Fail-open vs fail-closed on `unknown`.** Recovery's rule is: withhold on a
   positive `south_asian` verdict only; `us_western`, `other`, and `unknown` all
   still receive. Apply the same rule here unless the owner says otherwise.

### Implementation notes

- Reuse the existing classifier and the segment vocabulary. **Do not invent a
  second taxonomy.** Note that `feat/expanded-recovery-audience` (unmerged, 46
  commits ahead) introduces a versioned `audienceSegment` with six values —
  coordinate with that branch or land after it.
- The flag name is misleading and the working-tree `.env.example` diff already
  says so: `WESTERN_ONLY` is an **exclusion, not an allowlist**. If this becomes
  a cross-path policy, rename it rather than propagating the confusion.
- Never `z.coerce.boolean()` any new flag. Use `src/config/booleanFlag.ts`.

### Acceptance criteria

- The policy decision from the owner is recorded in the spec before code.
- One shared policy function serves all four call sites; no fourth copy of the
  rule.
- Suppressed keyword replies are logged with a reason, and are countable in the
  same way `audience_out_of_market` is for recovery.
- A test proves the hot path still responds within its existing latency budget
  when the classifier is unavailable.

---

## FR-4 — Broadcast-channel invite in the delivery flow

**State:** Proposed 2026-07-24. **Blocked on owner input that was never given.**
**Size:** Small — under a day once the two inputs arrive.

### Why

Every person who comments a keyword and gets a guide is — *in that moment* —
someone Instagram permits messaging. That is roughly **150 warm people a week**,
hands-free, forever. The Circle/channel is the destination and is currently
**completely un-instrumented** (`circle_events = 0` across 1,445 guides
delivered).

Explicitly **off the table**, and worth telling the owner again:

- The ~1,000 people who got a guide weeks ago — their 24-hour window has closed,
  so Instagram will not permit a re-DM.
- Followers who never messaged — no DM path exists at all.

Both of those are Stories reach, not DM reach.

### Blocked on

The proposal ended with two questions to the owner that were never answered:

1. **The channel link.**
2. **One line of copy** (or approval of a drafted set — the wording is brand
   voice, so the owner approves).
3. **Is it an Instagram Broadcast Channel, or WhatsApp/Telegram?** This changes
   how the link behaves and whether it can be sent at all.

**Do not start until these are answered.** Ask, then build.

### Where it attaches

Same two sites as [FR-1 Slice A](#slice-a--ask-the-question):
[`messageHandler.ts:382`](../../src/handlers/messageHandler.ts#L382) and
[`:588`](../../src/handlers/messageHandler.ts#L588). Coordinate with FR-1 — the
approved design there is *"keep all 23 existing resource footers, and
additionally send a warm, age-aware invite after they answer the age question."*
If FR-1 is not being built, this becomes a simple appended line instead.

### Attribution limit — build the measurement honestly

No Graph API endpoint exists for broadcast-channel membership, so **per-user
joins are unknowable.** Log `circle_invite_sent` and record channel member counts
manually. Present it as correlation, never attribution — the same shape as the
existing geo-experiment problem. Do not build a UI that implies per-user
tracking.

### Acceptance criteria

- Invite sends on both closing-line paths.
- `circle_invite_sent` is logged with the variant used.
- Any UI states plainly that joins cannot be attributed per user.
- Existing 23 resource footers are untouched.

---

## FR-5 — Known-follower personalized comment gate

**State:** Proposed 2026-07-26 and **explicitly parked** in favour of the CTA
work. Still unbuilt.
**Size:** Small — one DB lookup plus a copy variant.

### The gap

The *DM* path is already follower-aware (shipped 2026-07-23 as audit item #5):
a follower who DMs a keyword gets the guide instantly, no gate.

The *comment* path is not. Verified 2026-08-14,
[`src/handlers/commentHandler.ts:243`](../../src/handlers/commentHandler.ts#L243)
sends `keyword.gateMessage` flat, with no follower branch. So a long-time
follower who comments `POTTY` still gets *"To unlock this DM follow @tinysoho and
Reply Done"* — factually wrong for them.

### What to build

When a **known** follower comments a keyword, swap the gate copy:

> "Welcome back! 💛 Your potty guide is ready — just reply DONE and it's yours."

No follow ask, because we know.

**The reply step still stays.** That is Meta's window rule — one private reply,
and only their response opens the window for the multi-part guide. This changes
the greeting only.

**Safe by construction:** the hard gate at reply time already re-checks *live*
follow status, so someone whose cached status is stale still hits the follow wall.
The personalization changes the greeting, never the enforcement. Do not touch the
enforcement path.

Implementation is one lookup against our own `IgUser` table in the comment
handler — **no extra Meta API calls**, so no latency or rate-limit cost.

### Honest sizing — read before prioritising

Measured 2026-07-26: over the prior 30 days, only **~0.5%** of new conversations
came from people already known to be followers at that moment. This is a
low-effort politeness upgrade, **not a growth lever**. It compounds slowly — every
guide delivered adds a known person — but it should not displace FR-1 or FR-3.

### Acceptance criteria

- Known followers get the alternate gate copy; everyone else is unchanged.
- Live follow re-check at reply time is untouched, proven by test.
- Zero additional Graph API calls on the comment path.

---

## FR-6 — Age/gender demographics + `navigation` media breakdown

**State:** Proposed 2026-07-27. The question posed to the owner ("auto-refresh
worker first, or age/gender first?") was answered by building the token
auto-refresh; **the breakdowns were never built.**
**Size:** Small–Medium. No new Meta permissions required.

### Why both are free

`GET /{ig-user-id}/insights` requires `instagram_business_basic` **and**
`instagram_business_manage_insights`. **The app already holds that grant** —
proven by the fact that `follower_demographics` with `breakdown=country` returns
real data (647K reached, 42.2% US, measured 2026-07-27). No app review, no new
scope, no console changes.

### 6a — age and gender breakdowns

Verified 2026-08-14:
[`src/meta/demographicsFetcher.ts:84`](../../src/meta/demographicsFetcher.ts#L84)
requests `breakdown: "country"` only. The response shape already handles
`total_value.breakdowns[].results[]` with `dimension_keys` naming the columns, so
adding dimensions is largely parameterisation.

For a toddler-parenting account, whether US reach skews 25–34 versus 45–54
directly informs content. Estimated at **~30 lines** in `demographicsFetcher.ts`
plus storage and a UI surface.

**Storage caution:** `GeoDemographicSnapshot` is shaped around country. Decide
whether age/gender are new columns, a new model, or a generic
`dimension`/`value` shape — and note the existing **45-country cap**: Meta's
demographics report exactly 45 countries, so summing them undercounts followers
by ~5%. Use `followers_count` for the true total. Expect an analogous cap on new
dimensions and verify it rather than assuming.

### 6b — `navigation` breakdown on media insights

Verified 2026-08-14: `navigation` appears **nowhere** in `src/meta`.

`navigation` returns swipe-forward vs exited vs back — **the real hook-strength
signal.** The existing `skipRate` only approximates this; the API measures it.
This would sharpen spike attribution: a reel with high forward-swipes at spike
time is a far better attribution candidate than one with mere reach.

Also available on the same call and worth evaluating: `views`,
`total_interactions`.

### Sequencing note

There is a known blocker on the adjacent work: **per-reel snapshot coverage was
drifting** (441 reels on 2026-07-20 → 392 on 2026-07-25), which breaks
day-over-day reach comparisons because they sum different reel sets. That drift
blocked the per-reel attribution work at the time. **Re-measure coverage before
building 6b** — if it is still drifting, fix that first or 6b's output will be
untrustworthy.

### Acceptance criteria

- No new Meta permission is requested or required.
- Age/gender snapshots persist with their own cap documented and verified.
- `navigation` is fetched, stored, and visibly compared against the existing
  `skipRate` approximation so the two can be reconciled.
- Any total derived from a capped breakdown is labelled as capped in the UI.

---

## FR-7 — AI surfaces are built and switched off

**State:** Not a feature request — an **operational decision that has never been
made.** Included because it blocks FR-2 and dates FR-2a.
**Size:** Ops. No new code, unless shadow verification finds defects.

### What is already merged

`feature/ai-followup-experiment` and `feat/chatgpt-connection-runtime` are both
**fully merged into `main`** — 0 commits ahead, verified 2026-08-14. Their
worktrees are stale checkouts, nothing more.

What it does: after a guide is confirmed delivered over DM,
[`src/services/engagementFollowUpService.ts`](../../src/services/engagementFollowUpService.ts)
schedules exactly **one** owner-reviewable follow-up draft on that thread —
cancelled if new inbound arrives, deduped on duplicate delivery, expired past its
deadline. Codex writes the text; the owner reviews it in the web UI and clicks
**Approve & Send**. Nothing sends itself.

Separately, a cold DM that matches no keyword and has no open gate now **queues a
draft for the owner** instead of the old silence — which is the old "reply to
people who just say Hi" idea, already wired.

### Current state

[`.env.example:77-80`](../../.env.example#L77):

```
AI_DRAFTS_ENABLED=true      # shadow drafts, review-only
AI_FOLLOW_UPS_ENABLED=false
AI_SEND_ENABLED=false
AI_ADVISOR_ENABLED=false
```

`DEPLOY.md` §7.5 is a 10-step shadow checklist ending: *"Stop for owner approval
before setting AI_SEND_ENABLED=true."* §7.6 treats turning sending on — and the
first real AI-approved DM — as separate explicit authorizations. §7.7 is the
rollback: set all four false and redeploy.

**The §7.5 shadow run has never been performed.**

### What to do

Walk `DEPLOY.md` §7.5 steps 1–10 in order, stop at 10, and hand the owner the
shadow results. Do **not** set `AI_SEND_ENABLED=true` — that is explicitly a
separate owner action, and so is the first real send.

### Why it matters to the other requests

- Every draft in the system is currently un-approvable
  (`replyDraftView.ts` short-circuits on `!sendEnabled`), so FR-2's queue has
  nothing actionable to show until this is resolved.
- FR-2a's bug becomes user-visible the moment sending turns on.

---

## Not feature requests — but open

Listed so nobody mistakes them for available work or re-raises them as ideas.

### In flight, unmerged

| Branch | Ahead / behind `main` | What |
|---|---|---|
| `feat/expanded-recovery-audience` | 46 / 0 | Versioned `audienceSegment`, four-campaign rollout. Design: [`2026-08-11-...-design.md`](../superpowers/specs/2026-08-11-expanded-historical-recovery-audience-design.md), plan: [10 tasks](../superpowers/plans/2026-08-11-expanded-historical-recovery-audience.md). **Coordinate FR-3 with this.** |
| `feature/guide-message-delivery` | 25 / 6 | Guide message limits and resumable delivery. Design + plan both exist (2026-08-09). |

### Pending production action

**Journey reconciliation was never applied.** QA-15's code shipped to production
on 2026-08-08 but is **inert** — it only changes data when
`scripts/reconcile-journeys.ts` runs with `--write`, which is deliberately an
owner call. The dry run at the time reported:

```
canonical intents 4,529 · confirmed_gate 2,458 · completed 1,969 · earliest 102
SKIPPED (live journey) 350 · aliases recovered 284 · superseded 58
```

Re-run the dry run before deciding — it is 6 days stale as of this writing.

### Cleared — do not re-raise

The 2026-07-23 audit backlog is essentially closed:

| # | Item | State |
|---|---|---|
| #8 | All-token live comment matching | **Shipped** — `commentHandler` uses `findKeywordForComment`, scanning every token |
| #9 | Experiment attribution fix + capture-rate metric | **Shipped** — `nPct` in `insightsService`, `rankCaptureLeaders` / `recommendNextTest` / `learnedPatterns` in `web/src/lib/growthLab.ts` |
| #10 | Retry-tail tuning | **Shipped** — `MAX_BACKOFF_MS = 2h` at [`gateQueueWorker.ts:23`](../../src/services/gateQueueWorker.ts#L23), down from 12h |
| #11 | Measuring follows attributable to the funnel | **Shipped** — `followThroughWorker` + `followRecheckWorker`; yield ~22%, 11 of 12 converts stayed 21 days |
| #12 | Bot vs human division of labour on the account | **Open, but it is an agreement between people, not code** |

Also closed: the 2026-08-07 "reactivate the past audience" request
([`2026-08-07-past-audience-reactivation-request.md`](../superpowers/specs/2026-08-07-past-audience-reactivation-request.md),
status line still reads *"not designed, not scheduled"*) — it became Feature 4,
historical recovery, which shipped and ran. **Update that file's status line so
the next sweep does not re-flag it.**

The [`2026-07-10-us-growth-lab-design.md`](../superpowers/specs/2026-07-10-us-growth-lab-design.md)
spec still says *"awaiting written-spec review"* but is substantially
implemented — `recommendNextTest`, `LearnedPatterns`, and capture leaders all
exist in `web/src/pages/Insights.tsx` and `web/src/lib/growthLab.ts`. The
component decomposition the spec named (`GrowthDirectionCard`, `NextTestCard`,
`ValidatedExperimentCard`, `ManualExperimentSection`) was never done — `Insights.tsx`
is 1,170 lines — but that is a refactor, not a feature.

---

## Suggested order

1. **[FR-2a](#fr-2a--person-timeline-drops-ai-and-recovery-events-carve-out)** —
   small, correctness, and it has a deadline tied to FR-7.
2. **[FR-1 Slices A + B](#fr-1--dm-personalization-the-child-age-loop)** — ask
   the question and parse the answer, then *measure the answer rate before
   building C and D*. It is the only item here that changes the business.
3. **[FR-3](#fr-3--origin-gate-on-the-keyword-auto-reply)** — after the owner
   settles the three policy questions, and after or alongside
   `feat/expanded-recovery-audience`.
4. **[FR-7](#fr-7--ai-surfaces-are-built-and-switched-off)** — the shadow run,
   whenever the owner has time to review results.
5. **[FR-2](#fr-2--conversations-rebuild-one-queue-one-person-view)** — once
   there are real shadow drafts to design the queue rows against.
6. **[FR-6](#fr-6--agegender-demographics--navigation-media-breakdown)**,
   **[FR-4](#fr-4--broadcast-channel-invite-in-the-delivery-flow)**,
   **[FR-5](#fr-5--known-follower-personalized-comment-gate)** — as capacity
   allows. FR-4 is blocked on owner input; FR-5 is the smallest and least
   valuable.
