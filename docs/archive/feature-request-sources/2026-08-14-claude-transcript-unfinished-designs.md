# Unfinished Designs — from the Claude Code transcripts

**Compiled:** 2026-08-14
**Source:** the 103 Claude Code session transcripts in
`~/.claude/projects/-Users-pratik-nandoskar-Documents-working-mch-insta-automation/`
**Verified against:** working tree at `007d858`

**Scope note — read this first.** This document covers **only** work found in the
*Claude Code* transcripts. It is deliberately separate from the two existing
backlog documents so the three can be merged deliberately rather than by accident:

| Document | Author | What it is |
|---|---|---|
| `docs/feature-requests/2026-08-13-unstarted-instagram-automation-backlog.md` | **another agent** — appears in no Claude transcript | 12 speculative candidates (IA-FR-001…012), decision-first, no specs |
| `docs/backlog/2026-08-14-unstarted-feature-requests.md` | a Claude Code session (`edab32b2`) | 8 near-term requests (FR-1…FR-7, FR-2a) |
| **this file** | this session (`7c32c693`) | 3 designs that were *completed in conversation* and never written down or built |

The distinction that matters: the other two documents catalogue **ideas**. This
one catalogues **finished designs that were lost**. Each item below was
argued to a conclusion — including the data that killed the obvious version —
and then the session hit context exhaustion before the design doc got written.
Nothing here needs re-deciding. It needs transcribing and building.

---

## Method, and what it would have missed

I keyed on the strongest available signal for abandoned work: `TaskCreate` tasks
never marked complete. Six sessions had them. I then traced each back to its
conversation and verified the state against current code.

**What this would not catch:** an idea raised and dropped without ever becoming a
task. I did not read all 103 transcripts end to end. Treat this as high-precision,
not exhaustive.

**Numbers below carry the date they were measured** (2026-08-01 or 2026-08-03).
Per the standing rule on this project — never assume; verify against the real
source — **re-run every one before acting on it.** They are live production data
and are now ~2 weeks stale. Supabase MCP is read-only; do analysis there and write
through a `scripts/*.ts` Prisma one-off with `--dry-run` before `--write`.

---

## Index

| # | Design | Origin | State | Size |
|---|---|---|---|---|
| [CT-1](#ct-1--public-reply-copy-ab-test) | Public-reply copy A/B test | 2026-08-01 | Design complete, **zero code** | M |
| [CT-2](#ct-2--reach-share-panel-replacing-spike-candidates) | Reach-share panel replacing Spike Candidates | 2026-08-03 | Design complete, **zero code** | M |
| [CT-3](#ct-3--conversations-tab-breakdown) | Conversations tab breakdown | 2026-08-07 | Mockups only — **duplicates FR-2** | M–L |
| [—](#closed-tasks-that-were-never-marked-closed) | Two tasks that were already done | — | Bookkeeping only | XS |

**Recommended order: CT-2, then CT-1.** CT-2 is smaller, and it fixes a defect
that is actively producing a wrong answer on a screen in use. CT-1 is the only
item here that tests whether asking for the follow works at all.

---

## CT-1 — Public-reply copy A/B test

**Origin:** *"on the backend what can we do so that we can gain few followers
quickly. like nidge some people or something else. lets braisntrom on it"*
(2026-08-01, session `a9a22e76`)

**Ended at:** *"Does the architecture look right so far?"* — Section 1 of the
design was delivered and approved-in-principle; the session died before Section 2.

**Verified 2026-08-14:** nothing built. No `publicReplyVariant`, no
`KeywordVariant`, no variant field anywhere in `src/`, `prisma/`, or `web/src`.

### The idea in the prompt is mechanically impossible — this is settled

"Nudge the silent people" cannot be built. Meta's private-reply documentation:
*"Only one message can be sent to the Instagram user who commented."* The gate DM
already spends that one shot, and standard DMs require the user to have messaged
us first. So the **876 people who received a gate and went silent are unreachable
— there is no legal API call that touches them.** Not with `HUMAN_AGENT`, not
with anything.

Do not re-propose this. Record it as closed.

### Where the loss actually is (measured 2026-08-01, trailing 30 days)

| Stage | Count |
|---|---|
| Conversations opened | 1,588 |
| Gate DM delivered | 1,565 |
| **User replied** | **622 (40%)** |
| Guide delivered | 655 |

**943 people were told "Follow @tinysoho and reply DONE" and never replied.**
Everything downstream of that already works well.

Two supporting findings:

- **The follow gate is barely exercised.** Of 652 deliveries, 567 went to people
  *already following at delivery*; only 85 were non-followers. The hard gate
  fired **24 times** — its 79% conversion is real but touches almost nobody,
  because most people who reply were already followers. *(This is the same
  residue the cohort funnel layer at `src/services/funnels/` was built to
  measure — see `docs/funnels.md`. Prefer the funnel over a fresh ad-hoc query.)*
- **Growth is not broken.** Followers went 3,567 → 4,696 in 16 days (~70/day) and
  US share climbed 30.6% → 36.3%. The bottleneck is the 60% silent-after-gate rate.

### Why the public reply is the lever

The public comment reply is the **only channel that reaches 100% of commenters
with no one-shot cap**, and it currently spends its entire payload on
`"Check your DMs! 💌"` (17 keywords) or `"Check your DM 😊"` (7). The follow ask
lives *exclusively* inside the gate DM that 943 people never opened.

Reply rates by gate wording already range **21%–48%** across keywords on the same
basic template, so wording demonstrably matters.

### The three options, and the one chosen

**B was chosen, folding in A's clause.**

| | Copy | Trade-off |
|---|---|---|
| **A** — locate the DM | `Sent it to your DMs 💌 (not there? peek in your Message Requests)` | Zero taste risk, but adds *guide deliveries*, not followers — most people it recovers already follow (567 of 652). Pays off only if the invisibility hypothesis is right, which **failed to establish**. |
| **B** — move the follow ask into public ✅ | `Sent it to your DMs 💌 Follow @tinysoho so the next one comes to you first` | The ask stops being gated behind an unopened DM, and it broadcasts — anyone scrolling the thread sees it. Cost is taste: at ~50 comments/day the bot asks for follows in public repeatedly. |
| **C** — give a reason instead of an ask | `Sent it 💌 this one's from my toddler-sleep set — new one every week` | Strongest long-term (a follow is a subscription decision; a cadence is a reason, "follow me" isn't). Needs 24 pieces of bespoke copy and the cadence claim must actually be true. |

**Rejected premise, recorded so it is not resurrected:** the "people don't see the
DM" hypothesis could not be established. `ig_users.is_follower` is only populated
when someone DMs us, so every non-null value is *downstream of replying* — the
1,367 "unknown / 0% replied" rows prove the circularity. Treat as a free
side-bet, never a premise.

### The copy change is zero code — the build is measurement only

`publicReply` is already a per-keyword editable field
(`PATCH /api/keywords/:id`, max 280 chars, [`src/api/keywords.routes.ts:13`](../../src/api/keywords.routes.ts#L13),
editable on the Keywords page). All 24 rows could be edited today.

So the design is **not** about making the change. It is about being able to tell
whether it worked — and two findings rule out the simple version:

1. **`public_reply_sent` never records the text sent.** Verified 2026-08-14:
   [`src/handlers/commentHandler.ts:196`](../../src/handlers/commentHandler.ts#L196)
   logs `{ conversationId, commentId }` and nothing else. Editing `publicReply` in
   place silently re-attributes every past event to the new wording.
2. **Sequential before/after is dead.** SLEEP moved **37.8% → 53.5%** between two
   15-day halves *with nothing changed* — ~16 points of natural wobble, the same
   size as any effect worth finding. (POTTY was steady: 40.3% → 38.4%.)

Both force a **concurrent** split.

### The design

**Traffic is concentrated enough to support one:** SLEEP (17.8/day) + POTTY
(16.2/day) = **64% of all keyword matches**. Everything below PROTEIN is a
trickle. Those two are the only keywords with enough volume to read alone.

A **two-variant coin-flip at send time on SLEEP and POTTY.** When a comment
matches, `commentHandler` deterministically hashes the commenter's IGSID into
variant `control` or `follow_ask`, posts that variant's text publicly, and stamps
the variant onto `public_reply_sent`. Both variants run every hour, so the wobble
hits both equally and cancels.

**Deterministic hash, not random** — the same person commenting twice sees the
same wording, and the assignment is reproducible from the log alone with no
assignment table.

Three pieces:

| Piece | What |
|---|---|
| `src/services/publicReplyVariant.ts` (new, pure) | `(igUserId, keyword) → variant`. No I/O, trivially testable. |
| [`src/handlers/commentHandler.ts`](../../src/handlers/commentHandler.ts) | ~10 lines: resolve variant, send it, log it. |
| `KeywordVariant` table (new) | Holds the alternate `publicReply` per keyword, so copy stays editable without a deploy — matching how `publicReply` already works. |

Untouched: the gate DM, the follow gate, `sendPrivateReply`, `GateQueue`, the sequence.

Deliberately excluded from v1: no new worker (nothing to poll), no dashboard
(two SQL queries answer it), no `Experiment` row (that table models reel-geo).

**Precedent to copy for the variant stamp:** `DmRecoveryReminder` already
snapshots `keywordSnapshot` + `templateVersion` + `publicReplyText`
([`prisma/schema.prisma:676-678`](../../prisma/schema.prisma#L676)). That is
exactly the shape needed here — frozen evidence of what was actually sent, rather
than a join back to a mutable row. Follow it.

### The honest limit — state it in the spec, do not soften it

This measures **gate reply-rate and the follower/non-follower mix at delivery —
not followers.** Nothing in the Graph API ties a follow to a comment. Follower
count stays a directional side-signal only. A spec that implies otherwise is
wrong.

### Open — Section 2 was never reached

Not designed: the analysis queries, the minimum sample before reading a result,
and the stop rule. Apply the `minSample`/`GuardedRate` convention from
`src/services/funnels/types.ts` rather than inventing a new one — below sample,
report counts and `null`, never a percentage.

---

## CT-2 — Reach-share panel, replacing Spike Candidates

**Origin:** a screenshot of the "Candidates behind your biggest days" panel —
*"what do you think about this? is this correct. it seems to be static and not
dynamic. feel like our content is changing and this is not adapting like that"*
(2026-08-03, session `294d226b`)

**Ended at:** *"Does Section 1 look right so far?"*

**Verified 2026-08-14:** nothing built. `SpikeCandidates.tsx`, `spikeCore.ts`, and
`spikeService.ts` are all unchanged.

### The complaint was correct, and there is a specific mechanical cause

[`src/services/spikeCore.ts:164`](../../src/services/spikeCore.ts#L164), inside
`rankCandidates`:

```ts
} else {
  continue; // cannot separate in-window growth from lifetime reach
}
```

Any reel with no pre-window snapshot is **dropped**. Measured 2026-08-03: that
discards **12 reels and 44,915 of 65,469 reach (69%)**, and the top 3 comes out as
*egg carton 21.4% / Amazon box 21.2% / 7.6%* — **the back catalogue, with every
new reel invisible.** That is precisely "static and not dynamic," and it is still
in the code today.

**The fix: `postedAt ⇒ baseline 0`.** A reel posted inside the window has a
definitionally-zero pre-window baseline, so there is nothing to separate. With the
fix, **0 reels dropped.** `ReelSnapshot`
([`spikeCore.ts:39`](../../src/services/spikeCore.ts#L39)) does not carry
`postedAt` today, so plumbing it through is part of the work.

Safe to do: **0 of 145 reels have a null `postedAt`, 0 orphan snapshots.** A null
fallback is still required, because the column is nullable.

**And the finding that justifies the whole rewrite:** reels **0–7 days old hold
76.7%** of window reach (8–30d: 14.4%, 31–90d: 8.8%, 90d+: 0.0%). A trailing
window panel will genuinely track new content.

### Second defect — drop the prior-7d comparison from the headline

Measured 2026-08-03:

```
current 7d (Jul 28–Aug 3):  74.4/day
prior   7d (Jul 21–27)   :  89.7/day
```

The prior window contains Jul 22 (+168) and Jul 23 (+251), so the panel would
print **"74/day (was 90/day)" — a decline — on the account's best sustained run
ever** (+104, +119, +108 on the three most recent days). This is the same
pathology spike detection was deleted for: one spike day in the baseline poisons
every comparison after it.

The 28-day comparison does not have this problem (`avgPerDay7` 74.4 vs
`avgPerDay28` 73.6 → `trend: "steady"`), and `FollowerFlowPanel` **already renders
that as the trend badge in its header**. So a prior-7d figure is either a
duplicate of the badge or a lie.

**Headline becomes `Last 7 days · 74/day`, no comparison.**

### Where each number comes from

- **The rate stays client-side.** `summarizeFollowerFlow(points).avgPerDay7`
  already produces 74.4 with the correct Σ-spanDays denominator and the panel
  header already renders it. Recomputing it server-side would let this panel
  contradict the legend beside it — the exact failure
  [`web/src/lib/followerFlow.ts`](../../web/src/lib/followerFlow.ts) warns about
  in two separate doc comments.
- **The shares come from the server**, because they need
  `reel_performance_snapshot`.

### File plan — rename, because "spike" is no longer the concept

| From | To | What changes |
|---|---|---|
| `src/services/spikeCore.ts` | `reachShareCore.ts` | `rankCandidates` survives and gets the `postedAt` fix. **Delete** `detectSpikes`, `median`, `SPIKE_MULTIPLE`, `SPIKE_FLOOR`, `BASELINE_WINDOW_DAYS`, `MIN_BASELINE_DAYS`, `HIGH_SHARE`, `MEDIUM_SHARE`. |
| `src/services/spikeService.ts` | `reachShareService.ts` | One rolling window instead of per-spike-day. **2 fixed queries** — simpler than the old N-spike-days shape. |

Nothing new lands in `followerFlow.ts` (**593 lines** as of 2026-08-14);
`chartTooltip.ts` exists precisely because of that.

### Payload — moves from per-point to one top-level object

`FollowerFlowResult` gains:

```ts
export interface ReachShareEntry {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  reachGained: number;
  sharePct: number;
}

export interface WhatsWorkingInfo {
  windowStart: string;        // "2026-07-27"
  windowEnd: string;          // "2026-08-03"
  top: ReachShareEntry[];     // at most 3, largest gain first
  residualPct: number;        // 55
  residualReelCount: number;  // 92
  totalReachGained: number;   // 65469
}
```

`spike?: SpikeInfo` comes off the point, and `SpikeInfo` / `SpikeCandidateInfo`
are deleted from **both** declaration sites — verified 2026-08-14 at
[`src/services/followerFlowCore.ts:37,47`](../../src/services/followerFlowCore.ts#L37)
and [`web/src/lib/types.ts:392,402`](../../web/src/lib/types.ts#L392) (the
transcript cited `types.ts:379,389`; the file has moved).

### Corrected shares (measured 2026-08-03, trailing 7 days)

| # | Reel | Share | Reach |
|---|---|---|---|
| 1 | Bedtime with a toddler is never just bedtime | **21%** | +13.9K |
| 2 | Most parents spend weeks… | **13%** | +8.7K |
| 3 | The mistake isn't using a pacifier… | **11%** | +7.2K |
| | 92 other reels | 55% | |

Top 3 = 45.5%, residual 54.5% — **not** the 43.5%/57% in the approved mockup.

### The residual is exact, not floored — this was a deliberate decision

Denominator = every reel with positive in-window gain; count = that same set. 92
and 55% come from one rule, so they always reconcile.

Known simplification to record in the spec: the tail is long and thin — **11 of
those 92 hold 42.6pp of the 55**, and the median tail reel gained 12 reach. A
floor would make the count prettier and make the arithmetic stop adding up.
**No floor.**

### Also unbuilt from the same mockup

`(was 39/day)` in the approved mockup was wrong twice over — the real prior figure
was 90/day, and per the above the comparison should not exist at all. If the
mockup is reused, fix it first.

---

## CT-3 — Conversations tab breakdown

**Origin:** *"I think we need a better UI can we braisntrom on how we can better
show. i think that conversation tab is becoming too crowded as such. probably we
need to break it down?"* (2026-08-07, session `7c9d9096`)

**Ended at:** *"what does needs you mean"* — answered, then the session ended. No spec.

**This duplicates [FR-2](2026-08-14-unstarted-feature-requests.md#fr-2--conversations-rebuild-one-queue-one-person-view)**
in the other Claude-authored document, which is more developed than this
transcript: it carries the three presented options, the worked-out "Needs you"
definition, the refactor prerequisite, and acceptance criteria.

**When merging: keep FR-2 and drop CT-3.** The only thing to carry across is that
visual mockups were produced in this session — recover them from `7c9d9096` before
re-designing from scratch.

Note that FR-2 also owns the related correctness bug
([FR-2a](2026-08-14-unstarted-feature-requests.md#fr-2a--person-timeline-drops-ai-and-recovery-events-carve-out)),
which is independent and has a deadline.

---

## Closed tasks that were never marked closed

Both surfaced as open tasks; both are **already done**. Bookkeeping only — do not
schedule work.

**Fix headline rate basis inconsistency in FollowerFlowPanel** (2026-07-26).
The `/day` number excluded provisional days (108/day over 5) while the adjacent
region legend and US-share tile used all 7 (637 adds, 91/day), under a label
reading "over the past week" — which also biased the trend badge toward
Accelerating and skewed the days-to-milestone projection. **Fixed:**
[`web/src/lib/followerFlow.ts:138-139`](../../web/src/lib/followerFlow.ts#L138)
now passes `includeProvisional: true` for both `avgPerDay7` and `avgPerDay28`, one
basis throughout, with `provisionalDays` surfaced so the UI discloses it instead
of silently dropping days.

**QA-04: shared public-recovery contact ledger** (2026-08-08, left `in_progress`).
**Closed at code level** (`fb7e5b2`, `937c903`, `1653208`) — cooldown and capacity
are shared through the dispatch ledger, per
[`docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`](../qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md).

---

## One correction to carry into the merged document

While verifying, I ran an origin-gate check against `src/services/commentHandler.ts`
— **a path that does not exist.** The empty result read as "no origin gate," which
happened to be the right conclusion for the wrong reason. Re-verified against the
real file, [`src/handlers/commentHandler.ts`](../../src/handlers/commentHandler.ts):
zero matches for `WESTERN_ONLY`, `southAsian`, `origin`, `region`, or `geo`. The
keyword auto-reply genuinely has no origin check, so
[FR-3](2026-08-14-unstarted-feature-requests.md#fr-3--origin-gate-on-the-keyword-auto-reply)
stands.

The general lesson for whoever merges these: a grep returning nothing is not
evidence of absence until you have confirmed the file you grepped exists.
