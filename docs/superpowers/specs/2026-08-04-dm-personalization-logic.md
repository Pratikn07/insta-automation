# DM Personalization Logic — a section of the Codex integration

**Date:** 2026-08-04
**Status:** Design approved. Folded into the Codex integration as the plan of record.

## What this document is

This is **not a rival design**. The
[Codex integration spec](2026-08-04-codex-tiny-soho-integration-design.md) and its
[implementation plan](../plans/2026-08-04-codex-tiny-soho-integration.md) own the
runtime, the data model, the draft lifecycle, and the rollout. This document
supplies the *personalization logic* that runs inside them: what we ask a parent,
how we parse the answer, and how we pick which guide to offer.

It supersedes `2026-08-04-personalized-dm-ecosystem-design.md`, which was written
in a parallel session without knowledge of the Codex work and duplicated its DM
storage design. Everything worth keeping from that document is here; the parts
that collided with Codex's model are dropped in Codex's favour.

## Why the two sessions needed each other

Two designs were produced the same day, independently. Each solved the other's
blocking problem:

**Codex's human approval is not optional — it is what makes delayed follow-up
legal.** Verified in the Codex session against Meta's documentation: automated
messages must stay inside the **24-hour window** after the person's last message.
The seven-day `HUMAN_AGENT` tag is for genuine manual support only; automated
sends outside the standard window are prohibited. So the "personalized follow-up
hours or days later" idea only works when a human actually approves each send,
which is precisely what `Approve & Send` provides.

**The guide catalog is what stops the drafter inventing advice.** Commit
`12fe961` made the library machine-readable: `kind`, `theme`,
`age_min/max_months`, populated `description`, and `alt_text` transcriptions of
24 image pages. Without it, `guideContext.description` — already a field in the
Task 6 `DmDraftRequest` — would be null for every guide, and the drafter would
have nothing to ground on.

## Correction on record: bios

An earlier conclusion in the parallel session was that follower bios are
"impossible." That was wrong, and the record should say so.

**Accurate:** Meta's API exposes no bio. Verified live against our own token —
`code=100 "Tried accessing nonexisting field (biography)"` on the IGSID node, and
`business_discovery` unavailable on an Instagram-Login token (and Business/Creator
only regardless). Two independent investigations reached this same conclusion.

**The error:** generalizing "not available via Meta" into "not available." Bios
are *public data*. The Codex session found working routes — Bright Data
advertises 5,000 Instagram records/month free including `biography` with batches
up to 5,000 URLs; Apify's free credit covers roughly 1,900 profiles/month; and
Instagram's own official export supplies follower usernames.

**Where that leaves bio enrichment:** plausible but unproven and out of scope for
the phases below. It must not gate the guide (Bright Data latency is ~10-30s), so
it can only ever inform a *later* message — which is the 24-hour-window path, and
therefore human-approved anyway. Coverage is an estimate, not a measurement:
roughly 3,500-4,500 non-empty bios from 5,500 usernames. **Test 50-100 real
followers before designing anything on it.** Policy risk of scraping at scale is
also unassessed here.

Meta exposes no per-user geography by any route. DM timing was tested as a proxy:
79.7% of DMs land in US waking hours, but the hourly curve is near-flat, so
per-user it is noise.

## The problem this logic solves

95% of guide recipients never return: 1,203 of 1,266 completers requested exactly
one keyword. `SLEEP` delivered 747 times, `PICKY` 6 — not because six parents have
a picky eater, but because six ever saw the word. **The keyword is a doorway, not
a diagnosis.**

Separately, 673 inbound messages hit the silent branch
([messageHandler.ts:251](../../../src/handlers/messageHandler.ts#L251)) — engaged
parents who wrote something real and got nothing. Verbatim:

> "Grandma here: I am helping raise my 2 year old grandson and he refuses most
> food. His diet is cheese and bread… I don't know what to do!"

> "Thanks! What happens on 4th day? What if we have a long trip for example"

The second is a follow-up from someone who *read the guide*. Silence there is the
worst kind. Codex's shadow drafting (Task 7) is what fixes it.

## The one question: the child's age

> "How old is your little one? 🤍"

Asked **after** the guide, never before. Guide delivery is the one proven
conversion (~45/day); the question is additive and ignorable, so the worst case is
today's behaviour.

Rejected: age + "what's hardest" (two asks in a first reply depresses reply rate);
per-keyword questions (25 to author, skips the age filter); open-ended (no age,
routing leans entirely on the model).

Age wins because it is **structural**, not prose: it maps directly onto the
`age_min_months` / `age_max_months` columns from `12fe961`.

### Where it attaches

Today the guide is followed by exactly one closing line, chosen on follow state
([messageHandler.ts:100](../../../src/handlers/messageHandler.ts#L100) and again
at :231). The question **merges into that existing line** — no extra message, and
the follow ask is not dropped:

```
follower     → "Thanks for following! 💛 How old is your little one? 🤍"
non-follower → "Follow @tinysoho so you don't miss the next one 🙏
                And how old is your little one? 🤍"
```

Both send sites must change, or the question fires on one path only. This is a
modification to existing automation, so per the Codex spec's safety rule it stays
in the existing API and is **not** routed through Codex.

### Parsing the answer

Parents already volunteer age unprompted, in these real forms:

| Form | Real message | → months |
|---|---|---|
| plain months | "My baby is also 18 months" | 18 |
| plain years | "my 2 year old grandson" | 24 |
| decimal years | "My daughter is about 1.5 years old" | 18 |
| mixed | "My daughter is 2year 1 month old" | 25 |
| no space | "Mera v aaj hi 20months complete hua" | 20 |
| Hinglish | "Mera 2 year boy kabi b pot pr nhi baithta" | 24 |
| infant months | "My baby is 1.5 month old" | 1 |

**Regex first; the runtime only on a miss.** Common cases are cheap; `1.5 years`,
`2year 1 month` and Hinglish need a model.

**The parser must be able to decline.** Two real messages contain a number plus
"months" that is *not* the child's age:

> "for about **6 months** he's stuck in this limited diet"
> "Ab soch rhi hu **2 months** aur ruk jau" (thinking of waiting 2 more months)

A naive parser records a 6-month-old with a picky-eating problem. On low
confidence it returns null and routing proceeds **without** the age filter — never
with a guessed one.

Stored as nullable `child_age_months` (+ `age_source`, `age_confidence`) on the
sender, so a parent who answers once is never asked again.

### Ordering against existing automation

Keyword matching keeps precedence
([messageHandler.ts:56](../../../src/handlers/messageHandler.ts#L56) checks
keywords first, deliberately, so someone with an open `sleep` gate who types
`potty` starts a potty gate). A reply containing a keyword is a keyword, never an
age answer.

1. keyword match → existing flow (unchanged)
2. open gate → existing flow (unchanged)
3. **awaiting age answer** → parse; success routes, failure falls through
4. otherwise → Codex shadow draft (Task 7), replacing today's silence

Step 3 needs an `age_asked_at` timestamp on the sender. **Not**
`ConversationState` — that enum tracks guide delivery and a completed
conversation must stay completed.

## Routing: the drafter selects, never authors

The model never writes parenting advice. It picks from what the author wrote.
Retrieval narrows candidates in SQL; the model chooses; the reply is a template.

```sql
WHERE kind IN ('guide','recipes','activity')   -- product_links unreachable
  AND theme = :theme
  AND (age_min_months IS NULL OR :age >= age_min_months)
  AND (age_max_months IS NULL OR :age <= age_max_months)
```

Verified behaviour:

- **Grandma, 24mo, eating** → 11 candidates (4 guides + 7 recipe sets); zero
  affiliate links; `Car` — the top keyword hit before these columns existed —
  correctly absent.
- **3-year-old, learning** → `Play` (6-18mo, "Sensory Play for Babies") and
  `GUIDE` (18-24mo) excluded by age. The model never sees them.

`kind='product_links'` is a hard filter, not a warning: `Link`, `Book` and `Dough`
are bare Amazon affiliate URLs, and handing one to a struggling parent is the
worst failure available.

Guides are quotable because of `resource_messages.alt_text`. `Picky` — a 10-page
"Toddler Feeding Handbook" that was ten UUID filenames — now cites page by page,
so the grandma's answer (pages 1, 4, 6) is her own words rather than a paraphrase.

### Change required to the Codex plan

Task 6's `DmDraftRequest.guideContext` is a **single nullable guide**. Routing
needs the *candidate set* so the model can choose. Widen it to a bounded list:

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

## The Circle: keep the footer, add an earned invite

The Circle is the destination and is **completely un-instrumented**:
`circle_events = 0`. 1,445 guides delivered, no idea whether anyone joined. The
invite is identical boilerplate on 23 resources, one footer row each.

**Decision: keep all 23 footers, and additionally send a warm, age-aware invite
after she answers.** Stripping an invite that has shipped 1,445+ times on zero
evidence is the one irreversible move available; two touchpoints also make the
variants comparable.

**Attribution limit:** no Graph API endpoint exists for broadcast-channel
membership, so per-user joins are unknowable. We can log `circle_invite_sent` and
record member counts manually. That is correlation — "300 warm invites in August;
channel went 180 → 260" — not attribution. Same shape as the existing
geo-experiment problem.

## Business filter

Not every DM is a parent:

> "Welcome to Trendy Adaah Jewels 💎 … Bridal Jewellery / Party Jewellery"
> "And I will send you an affiliate link for amazon product! So, you will get 20%"

High `follower_count` plus promotional language → **skip the question entirely**.
Do not ask a jewellery brand about their toddler.

## Where this lands in the Codex rollout

| Codex phase | Add from this document |
|---|---|
| 1 — runtime + ChatGPT auth | nothing (in flight) |
| 2 — DM capture + shadow drafting | age question at both send sites; parser; `child_age_months`; `age_asked_at`; **backfill** |
| 3 — Approve & Send | `guideCandidates` widening; catalog routing; earned Circle invite; business filter |
| 4 — Business advisor | age/answer distribution as an advisor tool |

### Backfill (new, and worth it)

The Codex spec says DM history starts "from deployment forward" and correctly
refuses to invent messages. But **2,511 `message_received` events already exist**
in `event_log` with sender, text, `mid` and timestamp — real recorded history, not
reconstruction. Backfilling them into `DmMessage` is safe (the `mid` uniqueness
constraint makes it idempotent) and it is where the ~113 substantive parent
questions live. Without it, shadow drafting in Phase 2 has almost nothing to
evaluate against.

## Success criteria

| Win | Metric | Baseline (2026-08-04) |
|---|---|---|
| Answer rate | parents who answer the age question | unknown — measure first |
| Second guide | users requesting 2+ keywords | 63 of 1,266 (5%) |
| No silence | `message_unhandled` | ~7/day, 673 total |
| Followers who stay | guide-follower yield; 21-day follow-through | ~22% |

Answer rate is the leading indicator. If it is near zero the loop does not work
and no downstream metric matters.

A content gap already visible in the data: several inbound parents have infants
("3 months old", "1.5 month old"), and the only catalog item covering them is
`Sleep` (2-24mo). A 3-month-old's mother asking about food has nothing. Recording
ages makes that measurable.

## Out of scope

- **Bio enrichment** — plausible via Bright Data/Apify, unproven coverage,
  unassessed policy risk. Test 50-100 followers before designing.
- **Per-user geography** — no route exists.
- **Autonomous sends** — prohibited by the Codex safety rule *and* by Meta's
  24-hour window.
- **Per-user Circle join tracking** — no API.
- **`products` + `resource_products`** — real feature (activity guides already
  name glue guns, Duplo, bottle caps in prose; one product row could serve BOX,
  Puzzle and Activity), but `Book` = 1 delivery and `Link` = 5. `kind` closes the
  safety hole meanwhile.

## Known content defects (pre-existing, not blockers)

- `Dough` — 10 deliveries of a bare Amazon URL and nothing else. Needs the
  author, not code.
- `Car` — typo in its most-quoted line: `"I he . ar you"`.
- 11 orphan draft resources, including the most refined `OVERTIRED`
  (`c7cdcf8f`, adds "Dim the lights 30-60 minutes before bed") which has **never
  been sent** — the keyword points at the middle draft.
