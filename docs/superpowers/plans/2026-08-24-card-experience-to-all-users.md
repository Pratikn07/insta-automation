# Card Experience To All Users — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the guide-cover card experience from a 10% share plus one pilot account to every parent who comments a keyword, in the order that delivers the most reach per unit of risk.

**Architecture:** Three independent levers, deliberately sequenced. Task 1 publishes a cover for the account's highest-traffic guide, which currently cannot render a card at all because a card requires a published square. Task 2 raises the live comment gate's card share from 10% to 100% — an environment change with no code, gated behind Task 1 so the ramp lands on covered guides. Task 3 ramps the V2 full journey per-guide using the allowlist the rollout selector already reads, which is the mechanism its own author intended for broadening after the pilot.

**Tech Stack:** TypeScript, Prisma, Postgres (Supabase), Railway env vars, Vitest, Instagram Graph API generic templates.

## Global Constraints

- Card subtitle must stay within **80 characters**, counted in code points. Meta truncates past that silently, on device, with no error.
- Button titles stay within **20 characters** (Meta guidance).
- A card requires **both** the `dmGenericGate`/`privateGeneric` capability **and** a published `square_storage_path`. Either missing must degrade to text, never block the message.
- Cover attach inserts at `resource_messages.order = -1`. There is no CHECK on `order`, only `UNIQUE (resource_id, order)`. Never renumber existing rows.
- Edition numbers are assigned by `presentation_category.next_edition_number` inside the publish transaction. Never set `editionNumber` from a script.
- Every script is `--dry-run` by default and must be idempotent. `--apply` is the only mutating mode.
- Supabase MCP is **read-only**: analysis there, writes via a `scripts/*.ts` Prisma one-off.
- A local script against the shared pooler must set `connection_limit=2`.
- Never run `railway up` — it uploads the local worktree into production. Both Vercel and Railway are Git-connected; merging to `main` deploys.
- `railway variable set` **triggers a redeploy**, so the API restarts before the new value takes effect. Wait for `railway deployment list --service api` to report SUCCESS before reading any metric, or the numbers describe the old value. Pass `--skip-deploys` only if the value is meant to land with a later deploy.
- `GUIDE_GATE_CARD_PERCENT` has `pageMayEnable: false` and `pageMayStop: false` — the console cannot set it, so it is changed as a Railway env var. The stop control is the boolean `GUIDE_GATE_CARD_ENABLED`.
- Never put a trailing `#` comment on a runnable command line: `interactivecomments` is off in this shell, so the note is passed as arguments and has silently killed a deploy command before.

## Baseline measurements (2026-08-24)

| Fact | Value |
| --- | --- |
| Gated journeys, last 7 days | 1,698 of 1,708 (99.4%) |
| Gated journeys per day | 159–465, mean ~243 |
| `GUIDE_GATE_CARD_PERCENT` | 10 — so ~90% of gates are still plain text |
| Resources total / with published cover | 72 / 45 |
| Published covers missing a square | 0 |
| `Sleep` (`c5aa5d70-b6ac-455c-9e24-33eb5037e5ee`) | **949 journeys/30d, 3 messages, 0 media rows, no cover** |
| V2 pilot | `GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS=1919161265466442` (one account) |

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/publish-guide-covers.ts` (modify) | Add one `PLAN` entry for `Sleep`. Reused rather than duplicated: this script already validates copy against real font metrics, allocates the edition number through the publish transaction, and guards every entry on already-published, so adding a 46th entry is a five-field change while a fresh one-off script would restate ~150 lines of that logic and could silently omit `closingLine`, `altTextFor` or the metric validation. |
| `scripts/backfill-square-covers.ts` (run only, no change) | Renders and stores the **square** rendition. Publishing produces only `dm_storage_path`; `loadGateCard` filters on `square_storage_path`, so without this run the new cover still cannot become a card. Already fenced on `squareStoragePath: null`, so re-running it touches only the new cover. |
| `src/services/guideGateCard.ts` (read only) | Already correct. `loadGateCard` requires `squareStoragePath: { not: null }`, which is why Task 1 must precede Task 2. |
| `docs/runbooks/guide-card-rollout.md` (create) | The ramp steps, what to watch, and the exact stop control. Tasks 2 and 3 are operational; a runbook is the deliverable a future operator needs. |

---

### Task 1: Publish and attach the `Sleep` cover

The account's highest-volume keyword — 949 journeys in 30 days, roughly 32 a day — has no
published cover, so `loadGateCard` returns null for it and its follow request can only ever be
plain text. It is text-only (3 messages, 0 media rows), which means it fully satisfies the
"pure insert" rule the existing publish script was written around. It was simply never added to
that script's `PLAN`. Covering it is the single largest reach gain available in this plan: more
journeys than every other uncovered guide combined, by a factor of nine.

**Files:**
- Modify: `scripts/publish-guide-covers.ts` — one entry appended to the `bedtime` section of `PLAN`
- Run (no change): `scripts/backfill-square-covers.ts`
- Test: no unit test. This is a data change whose correctness is verified by the script's own
  font-metric validation, its `--dry-run` output, and the post-apply query in Step 6. The render,
  publish and storage paths are already covered by `guideCoverPublishService`,
  `guideCoverPngRenderer` and `guideCoverSquareRenditionMigrationContract` tests.

**Interfaces:**
- Consumes: the existing `CoverPlan` type — `{ resourceId, label, categorySlug, headline,
  supportingLine, holdAttach? }`. `kicker`, `collectionLabel`, `closingLine` and
  `alternativeDescription` are all derived by the script from the category row and `altTextFor`,
  so an entry supplies only those five fields.
- Produces: one `resource_cover_version` row with `status='published'`, `render_status='ready'`,
  a non-null `square_storage_path` (after Step 5) and a non-null `dm_storage_path`; plus one
  `resource_messages` row at `order = -1` for `c5aa5d70-b6ac-455c-9e24-33eb5037e5ee`.

- [ ] **Step 1: Confirm the guide is still uncovered and still text-only**

If `media_rows` is not 0, STOP and re-plan. An `order = -1` insert ahead of existing media is a
product decision rather than a mechanical one, and is exactly why `Picky` was excluded from the
original 45.

```sql
select r.id, r.name,
       count(rm.*) as messages,
       count(rm.*) filter (where rm.type <> 'text') as media_rows,
       min(rm."order") as first_order,
       (select count(*) from resource_cover_version cv
          where cv.resource_id = r.id and cv.status = 'published') as published_covers
from resources r
left join resource_messages rm on rm.resource_id = r.id
where r.id = 'c5aa5d70-b6ac-455c-9e24-33eb5037e5ee'
group by r.id, r.name;
```

Expected: `messages=3`, `media_rows=0`, `first_order=0`, `published_covers=0`.

- [ ] **Step 2: Add the PLAN entry**

The copy below is drawn from the guide's own content — it is about getting longer sleep
stretches from around two months through a consistent routine, full daytime feeds, daytime
activity and room to self-settle. Not from the keyword: "Sleep" as a name says nothing, which is
why all 45 existing covers were written from content.

Headline is 22 characters, supporting line 45 — both inside the metrics the script validates.
Append to the end of the `bedtime` section of `PLAN` in `scripts/publish-guide-covers.ts`:

```ts
  {
    // The account's highest-volume keyword by a wide margin: 949 journeys in the 30 days to
    // 2026-08-24, against 37 for the next uncovered guide. Absent from the original 45 by
    // omission rather than judgement — it is text-only, so it always qualified for the pure
    // order -1 insert this script was built around. Until it had a cover its follow request
    // could only ever be plain text, because `loadGateCard` requires a published square.
    resourceId: "c5aa5d70-b6ac-455c-9e24-33eb5037e5ee",
    label: "Sleep (longer stretches, 3 msgs)",
    categorySlug: "bedtime",
    headline: "Longer sleep stretches",
    supportingLine: "Same routine, full days, room to self-settle.",
  },
```

- [ ] **Step 3: Dry-run and read the Sleep line specifically**

```bash
DATABASE_URL="$DATABASE_URL&connection_limit=2" npx tsx scripts/publish-guide-covers.ts
```

Expected: the 45 existing entries report as already published, and one new line for
`Sleep (longer stretches, 3 msgs)`. If instead it reports a copy-validation failure, the
headline overflows in the real typeface — shorten it and repeat. Do not widen the frame; two of
the original 45 needed exactly this.

- [ ] **Step 4: Apply the publish and attach**

```bash
DATABASE_URL="$DATABASE_URL&connection_limit=2" npx tsx scripts/publish-guide-covers.ts --apply
```

Expected: `PUB Sleep (longer stretches, 3 msgs) → bedtime edition <n>` and
`ATT Sleep (longer stretches, 3 msgs)`, with every other entry skipped.

- [ ] **Step 5: Render and store the square — without this the card still cannot be built**

Publishing writes only `dm_storage_path` (1200×916). `loadGateCard` filters on
`square_storage_path`, so the cover exists but the card does not until this runs. The script is
fenced on `squareStoragePath: null`, so it touches only the new cover.

```bash
DATABASE_URL="$DATABASE_URL&connection_limit=2" npx tsx scripts/backfill-square-covers.ts --apply
```

Expected: `SQ Sleep …: stored`, and `SKIP … already has a square` for the other 45.

- [ ] **Step 6: Verify the card can now actually be built**

```sql
select cv.status, cv.edition_number, cv.headline,
       (cv.dm_storage_path is not null) as has_dm,
       (cv.square_storage_path is not null) as has_square,
       (select count(*) from resource_messages rm
          where rm.resource_id = cv.resource_id and rm."order" = -1) as leading_rows
from resource_cover_version cv
where cv.resource_id = 'c5aa5d70-b6ac-455c-9e24-33eb5037e5ee';
```

Expected: one row, `status='published'`, `has_dm=true`, `has_square=true`, `leading_rows=1`.
`has_square` is the field that decides whether this guide can ever send a card.

- [ ] **Step 7: Commit**

```bash
git add scripts/publish-guide-covers.ts
git commit -m "feat: publish a cover for Sleep, the account's highest-volume guide"
```

---

### Task 2: Ramp the live comment gate from 10% to 100%

`GUIDE_GATE_CARD_ENABLED` is already true and `GUIDE_GATE_CARD_PERCENT` is 10, so roughly nine
of every ten follow requests — around 219 a day — still go out as plain text. This is the
single highest-reach change in the plan and it needs no code: the card path, its payload, its
80-character subtitle and its failure behaviour are all already live and already proven on a
real parent's device.

Ordered after Task 1 so the ramp lands on a covered guide set. A guide with no square silently
falls back to text, so ramping first would have quietly excluded the highest-traffic guide from
the very rollout meant to reach it.

**Files:**
- Create: `docs/runbooks/guide-card-rollout.md`
- Modify: Railway env var `GUIDE_GATE_CARD_PERCENT` on the `api` service (no repository change)

**Interfaces:**
- Consumes: `guideGateCardSelected({ igUserId, resourceId })` from Task 0 (already shipped) —
  stable per person per guide, so a parent never flips between card and text.
- Produces: no code artifact. The runbook is the deliverable.

- [ ] **Step 1: Record the pre-ramp baseline**

```sql
select date_trunc('day', created_at)::date as day,
       count(*) as journeys,
       count(gated_at) as gated,
       count(completed_at) as completed
from conversations
where created_at >= now() - interval '14 days'
group by 1 order by 1 desc;
```

Save the output. Conversion at 10% cards is the comparison for every later step; without it the
ramp produces no evidence either way.

- [ ] **Step 2: Raise the share to 50 and wait for real traffic**

```bash
railway variable set --service api GUIDE_GATE_CARD_PERCENT=50
```

Do not jump to 100. At ~243 gates a day, 50% yields roughly 120 carded gates within a day —
enough to see a send-failure pattern while half of traffic is still on the proven text path.

- [ ] **Step 3: Check for send failures after at least 200 gates**

```bash
railway logs --service api | grep -iE "private_gate_card|dm_generic_gate|graph error|code 190"
```

Expected: no repeated Graph errors. A single HTTP 500 is not necessarily a failure — Meta
returns 500 on this surface and still delivers, which is why the code parks rather than retries.
What matters is a *pattern*.

- [ ] **Step 4: Compare conversion at 50% against the Step 1 baseline**

Re-run the Step 1 query. Expected: `gated`/`journeys` unchanged at ~99%, and `completed` no
worse than baseline. The card changes presentation, not the DONE mechanism, so a drop in
completion is a signal to stop, not to push on.

- [ ] **Step 5: Raise to 100**

```bash
railway variable set --service api GUIDE_GATE_CARD_PERCENT=100
```

- [ ] **Step 6: Write the runbook**

Create `docs/runbooks/guide-card-rollout.md` containing: the ramp ladder (10 → 50 → 100), the
queries in Steps 1 and 4, the log filter in Step 3, and this stop control stated explicitly —

> **To stop:** set `GUIDE_GATE_CARD_ENABLED=false`. Do **not** try to stop by lowering
> `GUIDE_GATE_CARD_PERCENT` from the console: that flag is `pageMayEnable: false` and
> `pageMayStop: false`, so `resolvePercent` discards any console-stored value and the change
> does nothing. The boolean is the only control the page can really apply.

- [ ] **Step 7: Commit the runbook**

```bash
git add docs/runbooks/guide-card-rollout.md
git commit -m "docs: runbook for the follow-request card ramp"
```

---

### Task 3: Ramp the V2 journey per guide, not per person

V2 is the full experience — opening card, gate card, and the "One step left 💛" re-ask — and it
currently reaches one account. Its selector takes **no percentage by design**; its own comment
says *"Stable allowlist-first rollout. There is intentionally no percentage input: broad
assignment comes only after the controlled account/guide pilot."*

The mechanism its author left for this is `GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS`: an exact-match
set of resource IDs, checked after the account cohort. Ramping by guide is safer than by person
— the blast radius is one keyword's traffic, it is trivially reversible, and it needs no code.

Note that **emptying the cohort lists disables V2 entirely** rather than enabling everyone: with
both sets empty, `owner()` falls through to `"v1"` for every input. Adding a percentage selector
would be real code and a new flag-registry entry, and is explicitly out of scope here.

**Files:**
- Modify: Railway env var `GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS` on the `api` service
- Modify: `docs/runbooks/guide-card-rollout.md` (add a V2 section)

**Interfaces:**
- Consumes: `guideFollowGateV2Selector.owner({ igUserId, resourceId })` → `"v1" | "v2"`, and
  `parseIdentifierSet(env.GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS)`.
- Produces: no code artifact.

- [ ] **Step 1: Size the Graph load before adding any guide**

A V2 journey costs one fresh follow check on request plus up to three rechecks, against roughly
0.1 checks a day today. Compute the added load for a candidate guide:

```sql
select k.keyword, count(*) as convos_30d, round(count(*) / 30.0, 1) as convos_per_day
from conversations c
join keywords k on k.id = c.keyword_id
where c.created_at >= now() - interval '30 days'
group by k.keyword
order by convos_30d desc
limit 15;
```

Multiply `convos_per_day` by 4 for the worst-case check count. `Sleep` at ~32/day is ~128
checks a day on its own; the whole account at ~243 journeys a day is under 1,000 worst case,
which is well inside Graph limits but should be entered knowingly rather than discovered.

- [ ] **Step 2: Add exactly one mid-volume guide first**

Do **not** start with `Sleep`. Its 949 journeys a month make it the worst possible first
subject for a path whose production history is four attempts. Start with `Dinner`
(`c835aee7-a631-4e38-95a5-811b6af9a991`) — it already has a published cover with a square, and
it is the guide the whole journey was verified on end to end on 2026-08-24.

```bash
railway variable set --service api GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS=c835aee7-a631-4e38-95a5-811b6af9a991
```

- [ ] **Step 3: Watch the journey actually complete, per stage**

```sql
select created_at, payload
from event_log
where kind = 'guide_access_v2_metric'
  and created_at >= now() - interval '1 day'
order by created_at asc;
```

Expected stages in order: `opening: accepted` → `action: received` → `fresh_check` →
`gate: shown` → `action: received` → `recheck: confirmed` → delivery. A stage that never
appears is the thing to investigate; a `needs_review` outcome means the attempt parked and an
owner has to look.

- [ ] **Step 4: Confirm the re-ask fires and reads correctly**

This is the change shipped in #58 and it has not yet been seen by a parent who is not the
owner. From a test account that is **not** following @tinysoho, comment the keyword, tap the
opening's button, then tap the gate's button **without following**.

Expected: the "One step left 💛" card, with the guide's cover, the words
`Follow @tinysoho for more recipes like this, then tap I'm following.`, and both **Visit
profile** and **I'm following** buttons. Not the "Instagram may take a moment" message — that
belongs to the second re-tap now.

- [ ] **Step 5: Check the owner-review rate before widening**

```sql
select payload->>'stage' as stage, payload->>'outcome' as outcome, count(*)
from event_log
where kind = 'guide_access_v2_metric' and created_at >= now() - interval '7 days'
group by 1, 2 order by 3 desc;
```

A rising `needs_review` count is the hold signal: every one of those is a parent whose guide
stopped mid-journey and who needs a human. Widen only while that stays near zero.

- [ ] **Step 6: Add guides one at a time, ascending by volume**

Append IDs to the same comma-separated variable, smallest traffic first, repeating Steps 3 and 5
after each. Leave `Sleep` until last.

- [ ] **Step 7: Extend the runbook and commit**

Add a V2 section to `docs/runbooks/guide-card-rollout.md` recording: the per-guide ramp order,
the stage query from Step 3, the review-rate query from Step 5, the Graph-load arithmetic from
Step 1, and this —

> **To stop V2:** set `GUIDE_FOLLOW_GATE_V2_ENABLED=false`, or remove IDs from
> `GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS`. Both fail closed to V1, which is the path that has been
> converting all along. Emptying **both** identifier sets disables V2 for everyone — it does not
> enable it for everyone.

```bash
git add docs/runbooks/guide-card-rollout.md
git commit -m "docs: per-guide ramp procedure for the V2 guide journey"
```

---

## Out of scope

- **A percentage selector for V2.** Its absence is deliberate and documented. Adding one is code
  plus a flag-registry entry, and the per-guide allowlist reaches full traffic without it.
- **The remaining 26 uncovered guides.** After `Sleep` (949/30d) the next is `Play` at 37/30d,
  and the rest are under 20. They are worth doing, but not in the plan whose purpose is reach.
- **`Picky` and the other media-leading guides.** An `order = -1` insert works mechanically, but
  putting a cover ahead of a guide that already opens with ten images is a product decision.
- **The two new cover categories** (feeding-behaviour, routines-transitions) that would unblock
  the held `Car` cover and re-home Calm / Green / DINNER / Dinner / Brush / Leave from their
  documented near-fits.
- **The two pre-existing test failures** — `guideAccessRepository`'s create-replay snapshot,
  which fails on a clean `origin/main`, and the `guideDeliveryScheduler` SIGTERM test, which
  passes in isolation. Both predate this work.
