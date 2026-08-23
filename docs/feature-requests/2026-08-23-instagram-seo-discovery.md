# Instagram SEO — Research, Implementation Plan, and Measurement

**Status:** Research and proposal. Nothing here is approved for implementation.
**Date:** 2026-08-23
**Account:** `@tinysoho`
**Canonical IDs proposed:** `SEO-001` … `SEO-007` (new category; add to the canonical backlog under the intake rule)
**Relates to:** `INSIGHT-001B` (navigation metrics), `INSIGHT-002` (Trial Reels), `INSIGHT-004` (competitor intelligence), `REL-002` (recent reach share)

---

## 0. What this document is

Three things, in order:

1. What Instagram SEO actually is in 2026, separating **what Meta documents** from **what the industry asserts**.
2. How it would be implemented *in this console*, reusing what already exists rather than bolting on a second product.
3. Which metrics to follow, how each is computed, and — the part most guides omit — **which ones are not observable at all**.

It follows the backlog's verification rules: every Graph API claim below is marked as
either verified in this codebase, documented by Meta, or **requiring validation against
the live account before anything is built**.

---

## Part 1 — What Instagram SEO is

### 1.1 There are three discovery surfaces, not one

"Instagram SEO" is routinely sold as one thing. It is three, with different mechanics,
different volumes, and different levers.

| Surface | How it selects content | Text matters? | Share of non-follower reach for an account like this |
|---|---|---|---|
| **In-app Search** (the search bar) | Query-to-text matching, then personalization and popularity | **Yes, directly** | Small but compounding |
| **Recommendations** (Explore, Reels feed, Suggested) | Behavioral prediction — watch time, sends, likes, history with poster | Indirectly, as topic classification | **Large — the majority** |
| **External search** (Google, Bing, AI answer engines) | Google's own crawl of Instagram pages, live since 2025-07-10 | **Yes, directly** | Currently unknown; unmeasured today |

**The strategic consequence:** optimizing text will not rescue a reel that nobody watches
to the end. Recommendations dominate volume, and recommendations are won on retention and
sends. Instagram SEO is the *cheap, compounding, permanent* layer underneath that — worth
doing precisely because it costs almost nothing per post, not because it replaces hook work.

Any plan that treats SEO as the growth lever, rather than as a multiplier on content that
already retains, will underperform and will waste the creator's limited console time.

### 1.2 What Meta actually documents

From Instagram's own explanation of Search, three signals in stated order of importance:

1. **The query text** — "by far the most important signal for Search. We try to match what
   you type with relevant **usernames, bios, captions, hashtags and places**."
2. **User activity** — accounts followed, posts viewed, past interactions.
3. **Popularity signals** — clicks, likes, shares and follows for an account, hashtag or place.

From Instagram's ranking explanation, for the recommendation surfaces:

- **Explore**, in order: information about the post (how many and how *quickly* people like,
  comment, share, save), your activity in Explore, history with the poster, information
  about the poster.
- **Reels**, in order: your activity, history with the poster, **information about the reel
  — "signals about the content within the video such as the audio track or visuals in the
  video, as well as popularity"**, information about the poster.

From Adam Mosseri (January 2025), the three signals that matter most across the app:
**watch time**, **likes per reach**, and **sends per reach** — with the qualifier that for
reaching *followers* likes weigh slightly more, and **for reaching *non-followers* sends
weigh more than likes**. That qualifier is the single most actionable sentence in this
document for an account whose goal is new US followers.

### 1.3 The line between documented and asserted

This matters more than usual here, because the backlog rule is *"treat missing documentation
as unknown, not permission."*

**Documented as Search inputs:** usernames, bios, captions, hashtags, places. That is the
complete list Meta gives.

**Widely asserted by SEO publishers, not stated by Meta as Search inputs:** alt text,
on-screen text via OCR, and audio transcription. These are plausible — Meta's *Reels ranking*
page does say it uses "the audio track or visuals in the video," and Instagram demonstrably
transcribes audio for auto-captions — but that is a statement about **recommendation**, not
about **Search matching**. Treat transcript and on-screen text as *topic-classification*
inputs that likely help recommendations, not as confirmed search-index fields.

Practical effect on the plan: put priority keywords **in the caption**, where Meta confirms
they are matched. Putting them in on-screen text and speech as well is cheap and probably
helps classification — do it, but do not count on it, and never trade caption clarity for it.

### 1.4 What changed, 2024 → 2026

| When | Change | Consequence for us |
|---|---|---|
| Dec 2024 | Following hashtags removed | Hashtags are labels, not a distribution channel |
| Jan 2025 | Mosseri names watch time, likes/reach, sends/reach as the top signals | Gives us a defensible primary metric set |
| 2025-01-08 (v21) | `profile_views`, `website_clicks`, `video_views` (non-Reels) and others deprecated | Several classic "IG SEO KPIs" are simply unavailable via API |
| 2025-03-24 | `alt_text` added to the Content Publishing API — **images only**, not Reels or Stories | Alt text stays a manual, in-app step for this account |
| 2025-04-21 | **Views** replaces Impressions and Plays across the API; Views includes replays | `views / reach` is a replay ratio, not a reach measure. Do not read it as one |
| 2025-07-10 | Public content from professional accounts (18+) indexed by **Google and Bing** by default, with an opt-out toggle | A brand-new, entirely unmeasured channel. Verify the toggle is on |
| 2025–2026 | Aggregator accounts (mostly unoriginal content) removed from recommendations | Original content is now a distribution prerequisite, not a virtue |
| Jul 2026 | Mosseri, again: hashtags "are not a way to get more reach" | Stop optimizing hashtag counts. Meta's own guidance is 3–5 relevant tags |

### 1.5 Why this account is a good SEO candidate

Toddler parenting is a **high-intent, evergreen search category**. Parents search Instagram
for "picky eater toddler," "toddler meltdown," "montessori activities 2 year old" — the same
way they search Google. This is unlike, say, fashion or comedy, where in-app search demand is
thin. The guide-delivery funnel also converts on intent rather than on impulse, which is
exactly what search traffic brings.

The evergreen quality is the real prize: a recommended reel is dead in 72 hours; a reel that
ranks for "toddler bedtime routine" keeps delivering guide requests for months. **That
difference is measurable with data this app already collects** — see §2.3.

---

## Part 2 — The measurement problem, stated honestly

### 2.1 There is no Search Console for Instagram

Meta exposes **no query-level data whatsoever**. There is no impressions-by-query, no
average-position, no click-through-rate, no "which search term brought this viewer." Nothing
in the Graph API, nothing in the app, nothing planned.

This is the defining constraint. Any vendor, dashboard, or agency offering "Instagram keyword
rankings" is producing an estimate from scraped searches, not a measurement. Under this
repo's standards that is not evidence and must not enter the console as a number.

**Therefore: Instagram SEO here is measured by proxy and by experiment, or it is not measured.**
Say so plainly in the UI wherever an SEO figure appears.

### 2.2 What is observable

| Want to know | Observable? | How |
|---|---|---|
| Which query drove a view | **No** | Not exposed. Ever |
| Rank for a term inside Instagram | **No** | No API; scraping is an estimate, not a measurement |
| Whether a post is still being discovered weeks later | **Yes** | Per-reel snapshot time series — already collected |
| Follower vs non-follower reach | **Probably, account level** | `reach` with a `follow_type` breakdown — **requires validation** |
| Sends and saves per reach | **Yes, today** | `shares`, `saved`, `reach` already stored per reel |
| Watch time and retention | **Yes, today** | `ig_reels_avg_watch_time`, `reels_skip_rate` already stored |
| Whether we appear in Google | **Partially** | Manual/sampled SERP checks. We do not own the domain, so Search Console is unavailable |
| Whether we are recommendation-eligible | **Yes, manually** | Account Status in the app. No API |

### 2.3 The proposed primary proxy: **Late Discovery Share**

Recommendation traffic is violently front-loaded: it peaks within hours and is effectively
over in 48–72 hours. Search and evergreen discovery are the opposite — a slow, flat tail that
persists for weeks.

So the shape of a post's view curve tells us which engine is delivering it.

```
Late Discovery Share (LDS) = (views_lifetime − views_at_day_7) ÷ views_lifetime
```

A reel at 4% LDS was recommended and forgotten. A reel at 35% LDS is being **found** —
by search, by saves resurfacing it, by profile visitors working backwards. Rising median LDS
across posts is the most honest available evidence that discovery optimization is working.

**This is computable today from `ReelPerformanceSnapshot` with no new Meta calls.** The model
is already a time series precisely because metrics drift; that design decision, made for a
different reason, is what makes this measurable.

**Preconditions, non-negotiable:**

- Suppress below the existing `MIN_REACH_FLOOR` of 500 reach. Below that the denominator is noise.
- Require a real snapshot within ±36h of the day-7 mark. **Do not interpolate**, and do not
  backshift the window to find a more convenient answer — the same rule the week-over-week
  interpretation already follows.
- **Snapshot coverage must be stable first.** The backlog records coverage drifting 441 → 392
  reels in five days. LDS is a ratio of two points on one curve; if a reel silently stops
  being snapshotted, LDS is not merely missing, it is *wrong in one direction* —
  it understates the tail, so a reel that is still being found looks like one
  that died.
  Fixing coverage is a hard prerequisite, not a nice-to-have.

---

---

## Part 2A — Validation log, 2026-08-23

Run against production over the read-only Supabase connection before any of the
proposals below were built. **Three of the assumptions in this document changed
as a result.**

### The catalog and its snapshot history

| Fact | Value |
|---|---|
| Reels in `reel_meta` | 185, all with `posted_at` |
| Performance snapshots | 21,833 rows, covering all 185 reels at some point |
| Snapshot history begins | **2026-06-30** |
| Post history begins | 2025-03-16 |

**Consequence, and it is permanent:** no reel posted before roughly 2026-06-23
can ever have a day-seven reading, because nothing was being snapshotted yet.
Late Discovery Share cannot be backfilled across the full catalog — only from
late June 2026 forward. Caption term coverage (`SEO-004`) is unaffected and can
still be scored retroactively across all 185 reels.

### Snapshot coverage: the defect is real, but it is not the shape the backlog recorded

The backlog describes coverage drifting 441 → 392 reels over five days. That
shape is not present, and the magnitude cannot be — there are only 185 reels.
What is present is a slow leak:

| Last snapshot | Reels | Oldest post | Newest post |
|---|---|---|---|
| Within 2 days | 150 | 2025-05-18 | 2026-08-22 |
| 2–7 days ago | 9 | 2025-04-11 | 2026-08-01 |
| 7–30 days ago | 17 | 2026-05-06 | **2026-08-14** |
| Over 30 days ago | 9 | 2025-03-16 | 2026-07-05 |

**35 of 185 reels have silently stopped being measured**, and it is not simply
old reels ageing out: one in the 7–30-day-stale bucket was posted 2026-08-14.
Meanwhile the distinct-reels-per-day count is *rising* (98 → 150 over 30 days)
because new reels are added faster than old ones drop out, which is exactly why
the leak is invisible on a coverage chart. No null `views` or `reach` values
appear anywhere in the last 30 days, so this is reels dropping out of the tick
entirely, not metrics failing within it.

This remains a prerequisite for trusting LDS, and it should be raised as its own
correctness item rather than carried inside an SEO feature.

### Late Discovery Share is computable, and it discriminates

Applying every proposed gate — posted since 2026-06-20, at least 10 days old, a
real snapshot within ±36h of the day-seven mark, and ≥500 lifetime reach:

| | |
|---|---|
| Candidate reels | 96 |
| With a day-seven snapshot inside ±36h | 88 |
| **Also clearing the 500-reach floor** | **79** |
| Median distance to the day-seven target | 20.9h |

**Distribution (n = 79):** p10 **0.2%** · median **8.9%** · p90 **23.2%** ·
max **41.8%** · negative readings **0**.

A ~100× spread between p10 and p90 means the metric separates posts rather than
measuring the account. Median sends per reach is 0.26%; median saves per reach
is 0.34%. **This is the baseline** required by `SEO-002`.

### The result that validates the metric

| Correlation with LDS | r |
|---|---|
| **Post age** | **−0.002** |
| Lifetime reach | 0.194 |
| Saves per reach | 0.195 |
| Sends per reach | 0.057 |
| Likes per reach | −0.206 |

Age correlating at essentially zero is the finding that matters. The obvious
objection to LDS is that it just measures elapsed time — an older reel has had
longer to accrue a tail. It does not. Two reels posted on the same day sit at
0.1% and 41.8%, and reels posted in August already reach 23–27%. **LDS is a
property of the content, not of the calendar**, which is what makes it usable as
a content metric at all.

The saves-positive / likes-negative split points the way the theory predicted —
reference-value content keeps being found, emotional-resonance content does not.
At |r| ≈ 0.2 on n = 79 that is **suggestive only**. It sits right at the edge of
conventional significance, it is not a finding, and it must not be printed in the
console as one. It is a hypothesis for `SEO-007` to test, and nothing more.

### What it looks like by eye

Reading the eight highest and eight lowest captions, the top band is dominated by
saveable reference content — three of the top eight carry an explicit "save
this" instruction, and the rest are scripts, shopping lists, and activities. The
bottom band is dominated by relatable and confessional posts. **This is an
observation about 16 captions, not a measurement**, and it is recorded here only
because it is the hypothesis `SEO-007` should be pre-registered against.

---

## Part 2C — Term register v1, from counted demand

Measured 2026-08-23 across every keyword ever configured, counting the conversations each one
actually opened. This is the cluster set and priority order for `SEO-002`; the phrasings still
have to come from Instagram autocomplete.

| Cluster | Guide requests | Share | Keywords carrying it |
|---|---:|---:|---|
| **Sleep** | 2,949 | **37.2%** | SLEEP, BEDTIME, WEAN, PACIFIER, OVERTIRED |
| **Recipes & meal prep** | 1,970 | **24.9%** | RECIPE, WAFFLE, MUFFIN, MEALPREP, FREEZER, DINNER, LUNCH, BREAKFAST, FANCY |
| **Nutrition** | 1,857 | **23.4%** | PROTEIN, FIBER, FRUIT, GREEN, GUMMIES, PEAR, EGG, CHICKEN |
| **Potty** | 772 | 9.7% | POTTY, POOP |
| **Play & learning** | 224 | 2.8% | PLAY, DOUGH, CARDBOARD, BOX, PUZZLE, BOOK |
| **Mealtime behaviour** | 138 | 1.7% | PICKY, CALM, CAR |

**Read the top three together.** Food — recipes, nutrition and mealtime behaviour combined — is
**50.0%** of all demand. Sleep is a single coherent topic at 37.2%. Those two account for 87%
of every guide request this account has ever served, and they are what the profile should say.

**Three observations, none of them yet decisions:**

1. **`SLEEP` is the single largest keyword ever run (2,825 requests) and has been inactive
   since 2026-08-10.** `BEDTIME` was attached to a post on 2026-08-22 and pulled 44 requests
   within a day, which suggests a deliberate migration from a global keyword to post-scoped
   ones rather than a lapse. Worth confirming, because 37% of demand sits behind it.
2. **`PICKY` has only 21 requests**, despite picky eating being the most-searched toddler-food
   topic off-platform. The account's own food demand is concentrated in *recipes and specific
   nutrients*, not in the picky-eating framing. Optimise for what the data says, not for what
   the category is famous for.
3. **Play & learning is 2.8% of demand** but a meaningful share of posting effort. Not an
   argument to stop — it may serve reach rather than conversion — but it should not compete for
   space in a 30-character name field.

**Still required before this register is complete:** the autocomplete pass for phrasing. The
table gives clusters and priority; it does not give the words parents type.

---

## Part 2D — Phase 0 audit result, 2026-08-23

Verified from owner screenshots of the live account.

| Check | State |
|---|---|
| Private account | **Off** — account is public |
| "Allow public photos and videos to appear in search engine results" | **On** |
| Account Status → Content and messages | Clear |
| Account Status → **Reach** | **"You don't have limits to your reach"** |
| Account Status → Features | Clear |
| Account Status → Monetization | Eligible |
| Professional account | Confirmed (Professional dashboard present) |

**The external channel was already open and the account is unrestricted.** Nothing is
being suppressed, so every discovery number in this document reflects content and
positioning rather than a penalty. That closes the highest-risk unknown in `SEO-001`.

Account scale at audit: 168 posts, 10.3K followers, **2.0M views in the trailing 30 days**.

### The profile contradicts the account's own demand data

Current name field: `Tiny Soho | Toddler Parenting` (29 of 30 chars).
Current bio, visible portion, in order:

1. Toddler Parenting Tips
2. **Independent play + No screens**
3. Calm, realistic motherhood
4. Easy meals, routines & real moments…

**Sleep does not appear anywhere in the profile.** It is 37.2% of all guide demand.

Normalising for how often each topic was actually offered — because raw totals would
simply reward whichever keyword was attached to the most posts — makes the gap wider,
not narrower:

| Cluster | Keyword rows | Distinct posts | Guide requests | **Per keyword offered** |
|---|---:|---:|---:|---:|
| **Sleep** | 14 | 10 | 2,949 | **211** |
| Food | 51 | 40 | 3,978 | 78 |
| Potty | 10 | 9 | 772 | 77 |
| Play & learning | 13 | 8 | 165 | 13 |

**Sleep was offered the least and converted the best: 2.7× food and 16× play, per offer.**
Ten posts carrying a sleep keyword produced nearly as many guide requests as forty
carrying a food keyword. The best-performing post visible on the grid at audit was a
bedtime reel at 10.1K views, against 967 and 2,705 for its neighbours.

Meanwhile the bio's second line — the most prominent line after the opener — is
*Independent play + No screens*, the **weakest-converting cluster in the account**.

**Two honest qualifications before anyone rewrites anything:**

1. Guide requests are not the only job a post does. Play and no-screens content may earn
   reach, followers, and brand trust that never shows up as a keyword comment. This table
   measures conversion to a guide, not value.
2. *No screens* and *independent play* read as positioning — a statement about what kind
   of parenting account this is — which may be attracting the right audience precisely
   because it is not a demand keyword.

Neither qualification explains a **complete absence of sleep** from a profile where sleep
is the strongest converting topic by a factor of 2.7. Recommend surfacing sleep in both
the name field and the first bio line, and demoting nothing else below where the evidence
supports.

## Part 3 — Implementation in this app

### 3.1 Terminology guard (read before writing any code)

This codebase already has a first-class concept called **Keyword** — the DM automation trigger
word a parent comments on a reel. An SEO keyword is a completely different thing.

**Do not overload the word.** Proposed vocabulary, for `PRODUCT.md`'s Terminology section:

- **Keyword** — unchanged. The comment trigger. `Keyword` model.
- **Search term** — a phrase parents type into Instagram or Google. New `SeoTerm` model.
- **Term cluster** — a group of search terms about one topic ("picky eating").
- **Term coverage** — whether a post's caption carries a priority search term.
- **Late discovery** — views accrued after day 7.

Conflating these in the schema or the UI would confuse the one non-technical daily user of
this console, and she is the person the whole SEO workflow has to reach.

### 3.2 What already exists and can be reused

This is the reason SEO is a small build here rather than a large one:

| Existing asset | Location | Reuse |
|---|---|---|
| Per-reel time-series metrics | `ReelPerformanceSnapshot` | Late Discovery Share, sends/reach, saves/reach — **no new API calls** |
| Captions already stored | `ReelMeta.caption` | Term extraction and coverage scoring, retroactively across the whole catalog |
| Gemini reel analysis | `ReelContentProfile`, `geminiAnalysisService` | Extend the prompt to return transcript + on-screen text — the text corpus Instagram itself classifies on |
| Reach floor and suppression discipline | `insightsService.MIN_REACH_FLOOR` | Same floor, same honesty, no new convention |
| Experiment framework | `Experiment`, `experimentService`, `experimentLifecycle` | Pre-registered SEO experiments with frozen primary metrics |
| Feature flags | `flagService`, `flagResolver` | Ship dark, enable per-surface |
| Creator's existing daily habit | `Keywords.tsx` — she attaches keywords to a new post daily | **The single place to put caption assistance.** No new habit required |

That last row is the most important product decision in this document. `PRODUCT.md` records
as a confirmed fact that the creator "logs in for setup and leaves" and that the analytics are
built for a reader who does not read them. An SEO dashboard she never opens is worth nothing.
A three-line caption checklist that appears where she *already is*, every day, is worth
everything. **Build the workflow before the dashboard.**

### 3.3 Proposed canonical items

---

#### `SEO-001` — Account and profile foundation (no code)

**Size:** Trivial. **Blocked by:** nothing. **Do this first.**

Everything else is worthless if the profile does not declare its topic and the account is not
eligible to be recommended.

- Confirm **Settings → Account privacy → "Allow public photos and videos to appear in search
  engine results"** is **on**. Default-on since 2025-07-10 for public professional accounts
  18+, but verify — an off toggle silently costs the entire external channel.
- Confirm account is **Professional (Creator or Business)** and **public**.
- Check **Account Status** for recommendation eligibility. If flagged, nothing downstream matters.
- **Name field** (the bold line, ~30 chars): this is a *searchable* field and is the most
  underused asset on most accounts. It should carry the primary term cluster, not repeat the
  handle. Structure: `Tiny SOHO | Toddler Play & Routines`.
- **Bio** (150 chars): what she does, who it is for, one CTA. Include the term cluster naturally.
- **Category** set correctly; **location** if relevant.

**Acceptance:** a dated screenshot record of each setting, stored with the baseline in `SEO-002`.

---

#### `SEO-002` — Term register and baseline

**Size:** Small. **Depends on:** `SEO-001`.

Build the keyword list *before* any tooling. It is a spreadsheet exercise first.

**Correction, measured 2026-08-23.** An earlier draft of this document claimed the account's
own `DmMessage` corpus was "the highest-signal source" for parent phrasing. **That is wrong,
and acting on it would have wasted a week.** The funnel is a gate: a parent comments a keyword,
receives a DM, and replies `DONE`. They never write prose. Measured:

| Corpus | Rows | Median usefulness |
|---|---|---|
| Inbound DMs with text | 2,666 | **Average length 6 characters.** 2,278 are literally `DONE`; only 49 exceed 40 characters |
| Comments with text (`event_log.comment_received`) | 11,076 | **Average length 13 characters.** 8,273 are under 15 chars — people type only the keyword |

Bigram mining across both returned almost nothing: `potty training` (9), `fullness cues` (8),
and a 105-count artefact that turned out to be our own recovery copy echoing back. **There is
no internal free-text corpus worth mining.** Do not build tooling for one.

What we have instead is better for clustering and worse for phrasing: **revealed topic demand
at scale**, from ~7,900 real parents who commented to request a guide. That is not estimated
search volume from a third-party tool; it is counted intent. It tells us *which topics*, not
*which words*.

So the sources, corrected and in order of value:
1. **Our own keyword demand table** (below). Counted intent from ~7,900 parents. Use it to set
   the clusters and their priority.
2. **Instagram autocomplete.** Type each cluster into the app's search bar; the suggestions are
   literally what people search. This is where *phrasing* comes from, and it is manual —
   roughly 30 minutes, once.
3. Google keyword data for the same topics — the vocabularies overlap heavily.
4. `ig_hashtag_search` for competitor/top-media sampling — **but note the hard limit of 30
   unique hashtags per rolling 7 days.** Cache aggressively; this cannot be a live UI lookup.
5. ~~The DM corpus~~ — measured empty, see above.

Then capture a **baseline** on the existing catalog before changing anything: median LDS,
sends/reach, saves/reach, non-follower reach share. Without a pre-period there is no way to
attribute any later lift, and `PRODUCT.md` forbids claims a sample cannot carry.

**Acceptance:** 30–60 terms in 5–8 clusters, each with intent and priority; a dated baseline
of the four Tier-1 metrics with denominators.

---

#### `SEO-003` — Late Discovery Share (backend)

**Size:** Small–Medium. **Hard prerequisite:** stable per-reel snapshot coverage.

Compute LDS per reel from `ReelPerformanceSnapshot` per §2.3. Suppress below 500 reach;
suppress when no snapshot exists within ±36h of day 7; never interpolate.

Also compute, from data already stored: **sends per reach** (`shares ÷ reach`) and
**saves per reach** (`saved ÷ reach`), same floor.

**Acceptance:** every value carries its denominator and its snapshot dates; a reel with
missing snapshots renders an explicit state, never a zero; tests cover missing day-7 snapshot,
zero reach, deleted media, and a reel whose snapshots stopped mid-life.

---

#### `SEO-004` — Term register and coverage scoring (backend)

**Size:** Medium. **Depends on:** `SEO-002`, `SEO-003`.

New `SeoTerm` model (term, cluster, intent, priority, source, status) plus `MediaTermMatch`
joining terms to `ReelMeta` / `FeedPostMeta` by caption matching.

- Extract terms from `ReelMeta.caption` — **retroactively across the whole catalog**, which
  immediately yields a term-vs-LDS correlation on real history rather than waiting months.
- Reuse `keywordMatchCore` matching discipline where it fits; do not reuse the `Keyword` model.
- Record **first-125-characters** coverage separately from whole-caption coverage. The visible
  portion of a caption is what a human reads before deciding to expand; keep the distinction
  even though Meta does not confirm a positional weighting.
- Parse hashtags out of the caption and store them, so the "3–5 relevant" guidance is
  observable rather than assumed.

**Acceptance:** coverage recomputes idempotently; a caption edited in-app and re-fetched
updates its matches with an audit trail; term deletion never silently rewrites history.

---

#### `SEO-005` — Caption assistance at the point of work (console)

**Size:** Medium. **Depends on:** `SEO-004`. **This is the one that changes outcomes.**

Where she already attaches a keyword to a new post, add a compact pre-publish checklist:

- Suggested search terms for the chosen cluster, ranked by priority and current coverage gap.
- A caption check: does it carry a priority term in the first 125 characters?
- Hashtag count check against the 3–5 guidance.
- Reminders for the manual, non-API steps: alt text on carousel images, on-screen text
  carrying the term, saying the term aloud in the first seconds.

**Constraint that shapes the whole design:** the Graph API **cannot edit a published caption**.
There is no batch-fix job, no retro-optimization worker. The app can only (a) help before
publishing and (b) produce a ranked list of published posts worth editing **by hand in the app**.
Design for that reality rather than discovering it in implementation.

**Acceptance:** adds no step to her existing flow when she ignores it; every suggestion is
dismissible; nothing blocks saving.

---

#### `SEO-006` — Discovery panel in Insights (console)

**Size:** Medium. **Depends on:** `SEO-003`, `SEO-004`.

`PRODUCT.md` fixes the information architecture at 11 destinations and warns against
restructuring the console around any one metric. **This is a tab inside Insights, not a new
destination.**

Per the "console interprets" commitment, it states a finding rather than presenting a grid:

> "Reels carrying the *picky eating* cluster hold 3.1× the account's median late-discovery
> share (7 reels, ≥500 reach, snapshots settled through 2026-08-16). Four published reels
> above 500 reach carry no priority term — the largest fixable coverage gap."

And where the sample is thin, it prints **nothing** — a blank is honest, a smoothed sentence is not.

**Acceptance:** every claim derives from a measurement with a visible denominator; thin
samples withhold rather than hedge; a failed source names itself and retries its own query.

---

#### `SEO-007` — Pre-registered SEO experiment

**Size:** Small on top of the existing framework. **Depends on:** `SEO-003`–`SEO-006`.

Use `Experiment` exactly as `INSIGHT-002` demands: hypothesis, one creative variable, window,
**primary metric frozen before results are read**.

- **Hypothesis:** captions carrying a priority search term in the first 125 characters
  accrue a higher late-discovery share than captions that do not.
- **Primary metric:** median LDS at day 30, ≥500 reach.
- **Secondary:** sends/reach, guide-request capture rate.
- **Guard:** one variable only. Do not simultaneously change hooks, posting time, or format —
  and respect the existing experiment-interference rules against running this against another
  live test.

Realistic expectation: with roughly 2–5 posts a week, a decision-grade sample is **8–12 weeks
out**. Plan for that horizon and do not let anyone read a winner at week three.

---

## Part 4 — Metrics: what to follow, how, and what to ignore

### Tier 1 — Primary, decision-grade

| # | Metric | Formula | Floor | Cadence | Why |
|---|---|---|---|---|---|
| 1 | **Late Discovery Share** | `(views_lifetime − views_day7) ÷ views_lifetime` | ≥500 reach; real day-7 snapshot | Weekly median | The only available proxy for search/evergreen discovery |
| 2 | **Sends per reach** | `shares ÷ reach` | ≥500 reach | Per post + weekly median | Mosseri: the strongest signal for reaching **non-followers** |
| 3 | **Saves per reach** | `saved ÷ reach` | ≥500 reach | Per post + weekly median | Intent and evergreen value; predicts the long tail |
| 4 | **Non-follower reach share** | `reach[non_follower] ÷ reach[total]`, account level | Settled Pacific days | Weekly | Whether discovery overall is widening. **Availability requires validation** |

Metric 2 is the one to hold the content conversation around. If the goal is US followers, and
sends outweigh likes for non-follower distribution, then "would a parent send this to another
parent?" is a better creative brief than any keyword list in this document.

### Tier 2 — Diagnostic

| # | Metric | How | Cadence |
|---|---|---|---|
| 5 | Term coverage rate | % of posts ≥500 reach carrying a priority term in the first 125 chars | Weekly |
| 6 | Cluster performance | Median LDS and sends/reach grouped by term cluster | Monthly |
| 7 | Watch time / skip rate | `ig_reels_avg_watch_time`, `reels_skip_rate` — already stored | Per post |
| 8 | Profile-term alignment | Does the Name field carry the top-performing cluster | Quarterly, manual |
| 9 | Recommendation eligibility | Account Status in-app | Monthly, manual |
| 10 | External presence | Sampled `site:instagram.com/tinysoho` + term checks in Google | Monthly, manual |

### Tier 3 — Business outcomes (already in the console)

| # | Metric | Note |
|---|---|---|
| 11 | Capture rate | `keywordComments ÷ reach` — already built. SEO must move this or it is decoration |
| 12 | Guide funnel conversion | Already built |
| 13 | **US followers gained** | The confirmed success metric. Every SEO claim must ladder to it, and it stays one tile — the console is not reorganized around it |

### Anti-metrics — do not build, do not report

- **"Instagram keyword rank."** Unobservable. No API. Any number is an estimate presented as a measurement.
- **Hashtag reach.** Mosseri has said twice that hashtags are not a reach lever; following hashtags was removed in 2024.
- **Impressions.** Deprecated 2025-04-21. Replaced by Views, which **includes replays** — the two are not comparable, and mixing them across that date produces a fake trend.
- **`profile_views` time series.** Deprecated in v21.
- **Follower count in isolation.** The account goal is *US* followers; total count hides mix shifts.
- **Engagement rate as a single blended number.** It fuses signals Meta weighs differently. Keep sends, saves, and watch time separate — the same principle `insightsService` already applies by refusing to sum geo-fit, performance, and conversion into one score.

---

## Part 5 — The complete ordered list, from zero

**Phase 0 — Foundation (this week, no code)**
1. Verify the search-engine indexing toggle is on.
2. Verify professional + public account status.
3. Check Account Status for recommendation eligibility.
4. Rewrite the Name field to carry the primary cluster.
5. Rewrite the bio: what / for whom / one CTA.
6. Confirm category and location.
7. Record dated screenshots of all six.

**Phase 1 — Know what to optimize for (week 1–2, no code)**
8. Harvest Instagram autocomplete for 8–10 seed topics.
9. Mine `DmMessage` for real parent phrasing — the best source we have.
10. Mine comments on the top 20 reels by reach.
11. Cross-check against Google demand for the same topics.
12. Cluster into 5–8 topics; assign intent and priority.
13. Freeze the register as v1.

**Phase 2 — Baseline before changing anything (week 2)**
14. Fix per-reel snapshot coverage instability. **Blocks everything measured.**
15. Compute baseline median LDS, sends/reach, saves/reach with denominators.
16. Validate whether account `reach` supports a `follow_type` breakdown; capture the real payload.
17. Record the baseline with its measurement date.

**Phase 3 — Make it measurable (`SEO-003`, `SEO-004`)**
18. Ship LDS, sends/reach, saves/reach with floors and suppression.
19. Ship `SeoTerm` + coverage matching; backfill across the whole caption history.
20. Correlate historical coverage against LDS — the first real evidence, from existing data.

**Phase 4 — Make it happen (`SEO-005`)**
21. Ship caption assistance in the existing keyword-attach flow.
22. Ship the ranked list of published posts worth hand-editing in the app.
23. Adopt the per-post manual habits: term in the first 125 chars, 3–5 relevant hashtags,
    term in on-screen text, term spoken in the opening seconds, alt text on carousels.

**Phase 5 — Make it legible (`SEO-006`)**
24. Ship the Discovery tab in Insights with an interpreted finding and honest blanks.

**Phase 6 — Prove it (`SEO-007`)**
25. Pre-register the experiment with a frozen primary metric.
26. Run 8–12 weeks. Read nothing early.
27. Decide: adopt, adjust, or abandon — and record which.

**Phase 7 — The external channel (ongoing, low priority)**
28. Monthly sampled Google SERP checks for priority terms.
29. Reassess if and only if external discovery shows any measurable signal.

---

## Part 6 — Risks and required validation

**Must be validated against the live account before building:**
- Whether account-level `reach` still supports a `follow_type` breakdown on the current API
  version, and whether it is period-bound or lifetime.
- Whether per-reel snapshot coverage is now stable. LDS is unsafe until it is.
- Whether `views` semantics have shifted again since the April 2025 replay change.

**Known hard limits:**
- No query data, ever. Everything here is proxy or experiment.
- No API to edit a published caption. Optimization is pre-publish; remediation is manual.
- `alt_text` is publish-only and images-only; this account publishes in-app, so alt text is a manual step.
- `ig_hashtag_search`: 30 unique hashtags per 7 days. Never a live lookup.
- No Search Console for a domain we do not own.

**Product risks:**
- **Over-optimized captions read like spam** to the parents who are the actual audience. The
  brand voice outranks the keyword. Every time.
- **Attribution illusion.** A rise in LDS may follow a format change, a seasonal shift, or one
  outlier reel. Only the pre-registered experiment can attribute it, and only with enough n.
- **A dashboard nobody opens.** If `SEO-005` slips and `SEO-006` ships first, this becomes
  another correct surface the daily user walks past. Ship the workflow first.

---

## Sources

Primary (Meta/Instagram):
- Breaking Down How Instagram Search Works — https://about.instagram.com/blog/announcements/break-down-how-instagram-search-works
- Instagram Ranking Explained — https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Recommendation eligibility on Instagram — https://help.instagram.com/653964212890722
- Publish Content using the Instagram Platform — https://developers.facebook.com/docs/instagram-platform/content-publishing/
- IG Hashtag Recent Media — https://developers.facebook.com/docs/instagram-api/reference/hashtag/recent-media

Secondary (change timeline and interpretation):
- Instagram content becomes searchable on Google starting July 10 — https://ppc.land/instagram-content-becomes-searchable-on-google-starting-july-10/
- Instagram Insights metric deprecation and Views transition — https://docs.emplifi.io/platform/latest/home/instagram-insights-metrics-deprecation-april-2025
- Instagram replaces Impressions with Views — https://help.metricool.com/en/article/instagram-replaces-impressions-with-views-what-you-need-to-know-ustr2f/
- Mosseri on hashtags and reach — https://www.kontentino.com/q-and-a/instagram-hashtags-reach/
- Mosseri on watch time, likes per reach, sends per reach — https://www.socialync.io/blog/adam-mosseri-shares-instagram-algorithm-2026
- Instagram SEO overview — https://later.com/blog/instagram-seo/ and https://sproutsocial.com/insights/instagram-seo/
- Trial Reels — https://www.inro.social/blog/what-is-a-reel-trial-and-how-does-it-work
