# Guide journey funnel: one trunk, two lanes, counted per person

Status: approved 2026-10-13. Owner: Pratik. Mockup: `.superpowers/brainstorm/46961-1791909904/content/funnel-final.html`.

## Problem

The Funnels page draws the guide → follow funnel as six stages counted per conversation (one
per reel comment). Since the card gate went to every guide (2026-08-24) that shape hides what
the page exists to show:

- The business output, new followers (1,140 in Sep 14 – Oct 13), appears only as a sentence
  under "Got the guide".
- "Following (first reading) 93.2%" is mostly people who followed before they asked. It says
  nothing about growth.
- 21-day retention is 97% (67 of 69 read), but the bar reads "2%" because it is drawn against
  everyone.
- Someone who comments on seven reels counts seven times; 546 people who answered one card
  showed up as lost on the other six.

## Decisions (owner)

1. Layout **A, trunk and fork**: a shared trunk (asked → got the card → said yes) that splits at
   the follow check into two lanes side by side, already following and not following yet.
2. **Two headline numbers**: new followers, and people who got their guide.
3. **Count people**, not cards.
4. **A breakdown under each leak**, with a "see who" list.
5. **New endpoint, and Home switches to it**, so Home and Funnels show the same said-yes rate.
   The per-card `guide-follow` endpoint stays for the CLI report and the read-only MCP role.

## The page (top to bottom)

Numbers are production, Sep 14 – Oct 13 UTC, from the queries that informed this design. The
build must produce splits that add up exactly; these are for orientation.

**Headline**, two numbers side by side:

- **New followers** (1,140): people in the not-following lane who got a guide after hitting the
  wall. Sub-line: "N% of the M who weren't following when they said yes".
- **Got their guide** (3,292): people who got any guide. Sub-line: "N% of the M who asked".

**Trunk**, one bar per stage, drawn against everyone who asked:

| Stage | Person is counted when | Count |
|---|---|---|
| Asked for a guide | any keyword_matched (non-link) in the window | 9,439 |
| Got the card | any of their comment cards reached Instagram (V2 access attempt or V1 gate DM), or they asked by DM, which is its own request | ~9,438 |
| Said yes | tapped or typed yes on any card, sent DONE (V1), hit the follow wall, or asked by DM | 4,834 |

Leak under "Said yes": **never said yes** = got the card − said yes, with buckets in this order
(first match wins, judged across all their cards):

1. Still has time: a card's messaging window is still open.
2. Wrote to us, not as a yes: an inbound DM after their first card.
3. Opened it and ignored it: a card or its reminder carries a read receipt.
4. No sign they opened it: a card is in DM history or tracked by a reminder, with no read.
5. Can't tell: no saved card and no reminder (cards before 2026-10-05, and every V1 card).

**Fork** at the follow check after "yes". Every person who said yes is in exactly one lane:

- **Already following**: said yes and never hit the follow wall on any card.
  Stage: got the guide.
- **Not following yet**: hit the follow wall on any card (V1 `follow_required` or a V2
  `check_follow` token). Stages: shown the follow wall → followed and got the guide (a guide
  delivered after their first wall) → still following at 21 days.

Leak under "followed and got the guide": **stuck at the wall** = wall − followed, with buckets:

1. Still has time: a wall attempt's messaging window is still open.
2. Said they followed, Instagram says no: a wall attempt was rechecked
   (`follow_response_count > 0` or `follow_check_count >= 2`), or a V1 card got two or more
   follow asks.
3. Never came back: everyone else.

**21-day row**: "K of R read · P%" where R = new followers with a 21-day reading and K = those
still following. Coverage line: "R of D people due a 21-day reading have been read", where D =
new followers rechecked and completed at least FOLLOW_THROUGH_MIN_DAYS ago. The bar's
percentage is K / R (retention), never K / everyone.

**Removed from the page**: the six-stage list, "Following (first reading)", the per-entry-path
rows, the KPI column, and the old "Biggest leak" section. The cover panel, the link-guide panel
and the needs-review alert stay unchanged.

## Data

One read-only SQL statement returns **one row per person** in the cohort (people whose first
non-link keyword_matched falls in the window). It reuses the card-level V1+V2 signals from
`JOURNEY_SIGNALS` and adds per card: first wall time (earliest `follow_required` event or
`check_follow` token), delivery times, messaging-window end, recheck evidence and read evidence.
Per person it returns the booleans and the bucket name for each leak, plus `username`,
`lastKeyword`, `cards` and `lastAskedAt` for the lists. Parameters: `$1` from, `$2` to,
`$3` lookback margin.

A pure summarizer turns the rows into the result. Like the existing funnels: no database and
no clock, and every rate is a `GuardedRate` with the funnel's minimum sample.

`GuideJourneyResult` keeps the fields Home reads (`window`, `headline` with `rate`, and
`stages` = the three trunk stages, so Home's "biggest loss" finds the said-yes leak). It adds
`headlines` (new followers and got guide), `lanes` (each with its stages), `leaks` (bucket
counts for both leaks) and `retention` (read, still following, due).

The list behind each "see who" link is the same SQL filtered to one leak, newest first, capped
by the existing drop-off limit.

## API

- Register `guide-journey` in the funnel registry. `GET /api/funnels/guide-journey?from=&to=`
  returns `GuideJourneyResult`, cached exactly like the other reports.
- `GET /api/funnels/guide-journey/drop-off/never-said-yes` and `/stuck-at-wall` return
  `{ leak, total, buckets, rows }` with one row per person.
- `guide-follow` and its drop-off routes do not change.

## Web

- `Funnels.tsx` replaces `FunnelBody` with the trunk-and-fork view (new components in
  `web/src/components/funnels/`), fed by `guide-journey` and its two leak lists.
- `Home.tsx` loads `/funnels/guide-journey`. `AutomationKpiRow`, `FollowerKpiRow`,
  `homeAttention` and `todaysRead` take `GuideJourneyResult`. Their copy stays: the
  headline is still "answered the unlock DM".

## Testing

- Contract test against Postgres: one person with seven cards who said yes on one is counted
  once and not as lost; a person who hit the wall on card 1 and got card 2 without a wall
  counts as a new follower; DM-only askers land in "said yes"; each leak bucket gets a seeded
  person; lanes partition said-yes exactly.
- Summarizer unit tests: headline rates, lane partition, retention never drawn against
  everyone, below-minimum-sample suppression.
- Page tests: two headlines, trunk, both lanes, both leak breakdowns, the 21-day coverage
  line. A Home test that the tile reads the journey headline.
- Replay against production (read-only): the summary equals the orientation numbers above,
  within the drift of a moving window.
