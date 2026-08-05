# Personalized DM Ecosystem — Design

> **⚠️ SUPERSEDED — do not build from this document.**
>
> Replaced by [DM Personalization Logic](2026-08-04-dm-personalization-logic.md),
> which folds this design into the
> [Codex integration](2026-08-04-codex-tiny-soho-integration-design.md) as the
> plan of record.
>
> This was written in a parallel session with no knowledge of the Codex work and
> duplicated its DM storage design (`event_log` vs `DmThread`/`DmMessage`/
> `ReplyDraft`). It also under-specified the review queue in one paragraph, where
> the Codex design has a full nine-state draft lifecycle.
>
> **Two things it got wrong or missed:**
> - It concluded follower bios are impossible. Accurate for Meta's API (verified:
>   `code=100 nonexisting field (biography)`), but bios are public data and
>   reachable via Bright Data / Apify. See the correction in the replacement.
> - It treated the 24-hour messaging window as a constraint to note. It is
>   actually the reason human approval is mandatory: automated sends outside that
>   window are prohibited, so any delayed personalized follow-up requires a person
>   to approve it.
>
> Kept for the reasoning and the verified measurements, both of which carry over.

**Date:** 2026-08-04
**Status:** Superseded 2026-08-04
**Prerequisite (done):** guide catalog — commit `12fe961`

## The problem

95% of people who receive a guide never come back.

```
1 keyword only  : 1,203 of 1,266 completers   (95%)
2+ keywords     :    63 of 1,266               (5%)
```

(Counts move daily with live traffic; measured 2026-08-04. The 95/5 split has
held across every measurement.)

They comment `sleep`, get the PDF, and vanish. There is no ecosystem — it is a
vending machine.

Two measured leaks:

1. **One-and-done.** `SLEEP` delivered 747 times, `PICKY` 6 times. Not because
   only 6 parents have a picky eater — because only 6 ever saw the word PICKY.
   The keyword is a **doorway, not a diagnosis**: it reflects which reel she
   happened to scroll past, not what is hardest in her house.
2. **Silence.** `message_unhandled` = 673 events, ~7/day. These are engaged
   parents who wrote something real and got nothing back. Examples, verbatim:

   > "Grandma here: I am helping raise my 2 year old grandson and he refuses
   > most food. His diet is cheese and bread… I don't know what to do!"

   > "Our 3 year old will not try new foods… so worried her diet is suffering"

   > "What are the measurements for the pizza bites"

## What we can and cannot know about a sender

Verified against the live Graph API with our own token.

| Signal | Coverage | Notes |
|---|---|---|
| First name | 83.6% safely greetable | 93% have *a* name; the rest fail a junk guard — `𝓟𝓸𝓸𝓳𝓪𝓷𝓪`, `🌻`, `__SP♥️__` |
| Keyword typed | 100% | domain, not problem |
| `is_user_follow_business` | ~99.6% | readable once she DMs us |
| `follower_count` | high | filters businesses/spam |
| **Her answer to one question** | unknown until shipped | the real signal; reply rate is the first thing to measure |
| **Bio / location / interests** | **0%** | **does not exist** |

**Bio is not available.** Probing the IGSID node returns:

```
FAIL biography:          code=100 "Tried accessing nonexisting field (biography)"
FAIL business_discovery: code=100 "Tried accessing nonexisting field"
OK   baseline:           {"name":"yf","username":"yf2690","follower_count":51,…}
```

Instagram Messaging exposes exactly seven fields: `name`, `username`,
`profile_pic`, `is_verified_user`, `follower_count`, `is_user_follow_business`,
`is_business_follow_user`. No bio, no website, no category. `business_discovery`
(which does expose `biography`) is unavailable on our Instagram-Login token and
covers only Business/Creator accounts — most of this audience are personal
accounts.

Meta exposes **no per-user geography** either. DM timing was tested as a proxy:
79.7% of DMs land in US waking hours, but the hourly curve is nearly flat, so
per-user it is noise. It describes the audience, not the individual.

**Therefore we ask instead of infer.** A bio would have said "mom of 2, Dallas."
Her answer says "18 months." Only one of those can be routed on.

## The loop

```
keyword (a doorway)
  → named greeting + guide          delivered immediately, unchanged
  → ONE question: her child's age
  → she answers                     self-reported, consented
  → route to the guide she ACTUALLY needs (the one she'd never have typed)
  → warm, age-aware Circle invite
  → off-topic questions → draft to a review queue, never auto-sent
  → every answer stored             → learn what parents need
```

The question is asked **after** the guide, never before. Guide delivery is the
one proven conversion (~45/day succeeding); the question is additive and
ignorable, so the worst case is today's behaviour.

### Where it fits in messageHandler

Today the guide is followed by exactly one closing line, chosen on follow state
([messageHandler.ts:100](../../../src/handlers/messageHandler.ts#L100) and again
at :231):

```
isFollower === true  → FOLLOWER_THANKS "Thanks for following! 💛"
otherwise            → FOLLOW_NUDGE   "Follow @tinysoho so you don't miss the next one 🙏"
```

The age question **merges into that existing line** rather than adding a fourth
message. The follow ask is not dropped — it is still the one leverage moment for
a non-follower:

```
follower     → "Thanks for following! 💛 How old is your little one? 🤍"
non-follower → "Follow @tinysoho so you don't miss the next one 🙏
                And how old is your little one? 🤍"
```

Message count per delivery is unchanged. Both send sites must be updated, or the
question fires on one path only.

### Conversation state

An answer must be distinguishable from a new keyword. Today
[messageHandler.ts:56](../../../src/handlers/messageHandler.ts#L56) checks
keywords **first**, deliberately, so someone with an open `sleep` gate who types
`potty` starts a potty gate. That precedence stays: a reply containing a keyword
is a keyword, never an age answer.

Order of checks on an inbound DM:

1. keyword match → existing gate/deliver flow (unchanged)
2. open gate → existing deliver flow (unchanged)
3. **awaiting age answer** → parse; on success route + invite, on failure fall through
4. otherwise → off-topic → review queue (replaces today's silent
   `message_unhandled`)

Step 3 needs a marker for "we asked her and are waiting." Reusing
`ConversationState` is wrong — that enum tracks guide delivery
(`awaiting_done`/`completed`/`expired`) and a completed conversation must stay
completed. A separate nullable timestamp (`age_asked_at`) on the sender is
sufficient, and it doubles as the "already asked, don't ask again" guard.

## The one question: age only

> "How old is your little one? 🤍"

One question, one-word answer, highest expected reply rate. Rejected
alternatives: age + "what's hardest" (two asks in a first reply depresses the
answer rate); per-keyword questions (25 to author, and skips the age filter);
open-ended (no age, routing leans entirely on the LLM).

Age is the strongest single signal because it is now **structural**: commit
`12fe961` added `resources.age_min_months` / `age_max_months`, populated and
indexed. Her answer becomes a SQL predicate, not prose to be parsed at routing
time.

### Parsing her answer

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

**Regex first, LLM only on miss.** The common cases are cheap; `1.5 years`,
`2year 1 month` and Hinglish need the model.

**The parser must be able to decline.** Two real messages contain a number plus
"months" that is *not* the child's age:

> "for about **6 months** he's stuck in this limited diet"
> "Ab soch rhi hu **2 months** aur ruk jau" (thinking of waiting 2 more months)

A naive parser records a 6-month-old with a picky-eating problem. Asking "how old
is your little one?" makes an age far more likely, but on low confidence the
parser returns null and routing proceeds **without** the age filter — never with
a guessed one.

Storage: a nullable `child_age_months` (plus `age_source`, `age_confidence`) on
the sender, so it persists across conversations. A parent who answers once is
never asked again.

## Routing

The LLM **never authors parenting advice**. It selects from what the author
wrote. Retrieval finds candidates; the LLM picks; the reply is a template.

```sql
WHERE kind IN ('guide','recipes','activity')   -- product_links unreachable
  AND theme = :theme
  AND (age_min_months IS NULL OR :age >= age_min_months)
  AND (age_max_months IS NULL OR :age <= age_max_months)
```

All three facets exist and are populated (27/27 reachable resources). Verified
behaviour:

- **Grandma, 24mo, eating** → 11 candidates (4 guides + 7 recipe sets), zero
  affiliate links, and `Car` — the top keyword hit this morning — correctly gone.
- **3-year-old, learning** → `Play` (6–18mo, "Sensory Play for Babies") and
  `GUIDE` (18–24mo) excluded by age. The model never sees them.

`kind='product_links'` is a hard filter, not a warning: `Link`, `Book` and
`Dough` are bare Amazon affiliate URLs, and a struggling parent being handed one
is the worst failure available.

Guide content is legible because of `resource_messages.alt_text`: 24 image rows
transcribed. `Picky` — a 10-page "Toddler Feeding Handbook" that was ten UUID
filenames — is now quotable page by page, so the grandma's answer (pages 1, 4, 6)
can be cited rather than paraphrased.

## Off-topic questions: draft, never auto-send

Some questions no guide can answer:

> "What are the measurements for the pizza bites"
> "Isn't this recipe missing oats and banana like the image says?"
> "Thanks! What happens on 4th day? What if we have a long trip for example"

The third is the tell — a follow-up from someone who *read the guide*. Silence
there is the worst kind.

These get an LLM-drafted reply into a **review queue in the existing dashboard**
(`web/`, alongside `conversations.routes.ts` / `messages.routes.ts`). Nothing
sends until approved. Volume is manageable: ~7/day.

**Meta's messaging window is 24 hours.** A draft unreviewed past that will fail
to send, so the queue needs an expiry warning and a warm holding reply
("Great question — let me come back to you on this one 🤍") when the window is
about to close.

## The Circle: keep the footer, add an earned invite

The Circle is the ecosystem's destination and is **completely un-instrumented**:

```
circle_events: 0
```

1,445 guides delivered, and no idea whether anyone joined. The invite is
identical boilerplate on 23 resources — one footer row each (20 originally;
3 more today when the `"New step — edit me."` placeholders were replaced).

**Decision: keep all 23 footers, and additionally send a warm, age-aware invite
after she answers.** Stripping an invite that has shipped 1,445+ times on zero
evidence is the one irreversible move here. Two touchpoints also make the two
variants comparable.

**Attribution limit, stated plainly:** there is no Graph API endpoint for
broadcast-channel membership, so per-user joins are unknowable. We can log
`circle_invite_sent` (ours) and record channel member counts manually over time.
That yields correlation — "300 warm invites in August; channel went 180 → 260" —
not attribution. Same shape as the existing geo-experiment problem.

## Business filter

Not every DM is a parent. Real inbound:

> "Welcome to Trendy Adaah Jewels 💎 … Bridal Jewellery / Party Jewellery"
> "And I will send you an affiliate link for amazon product! So, you will get 20%"

High `follower_count` plus promotional language means **skip the question
entirely**. Do not ask a jewellery brand about their toddler.

## Success criteria

| Win | Metric | Baseline (2026-08-04) |
|---|---|---|
| Followers who stay | guide-follower yield; 21-day follow-through | ~22% |
| Second guide | users requesting 2+ keywords | 63 of 1,266 (5%) |
| No silence | `message_unhandled` | ~7/day, 673 total |
| Learn what parents need | age + answer distribution | nothing recorded |

Before any of these, the leading indicator: **what fraction of parents answer the
age question at all.** If that is near zero the loop does not work, and no
downstream metric matters. Measure it first.

Win 4 is free — it is reading what the loop already records. And it surfaces a
content gap already visible in the data: several inbound parents have infants
("3 months old", "1.5 month old", "2 months old"), and the only catalog item
covering them is `Sleep` (2–24mo). A 3-month-old's mother asking about food has
nothing. That becomes measurable.

## Explicitly out of scope

- **Bio-derived anything** — location, traveller status, interests. The field
  does not exist; every design built on it returns error 100.
- **Persistent multi-turn agent with memory.** Build after this loop reveals how
  parents actually answer. This spec generates that design's input data.
- **`products` + `resource_products` tables.** Real feature (activity guides
  already recommend glue guns, Duplo, bottle caps in prose — one product row
  could serve BOX, Puzzle and Activity at once), but demand is unproven:
  `Book` = 1 delivery, `Link` = 5. `kind` closes the safety hole meanwhile.
- **Per-user Circle join tracking.** No API for it.

## Known content defects (pre-existing, not blockers)

- `Dough` — 10 deliveries of a bare Amazon URL and nothing else. Needs the
  author, not code.
- `Car` — typo in its most-quoted line: `"I he . ar you"`.
- 11 orphan draft resources, including the most refined `OVERTIRED` version
  (`c7cdcf8f`), which adds "Dim the lights 30–60 minutes before bed" and has
  **never been sent to anyone** — the keyword points at the middle draft.
