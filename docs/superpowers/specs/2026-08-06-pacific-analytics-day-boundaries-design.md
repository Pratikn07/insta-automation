# Pacific Analytics Day Boundaries Design

## Goal

Make owner-facing follower analytics use the Tiny SOHO account's Pacific
calendar day instead of UTC. Raw timestamps remain UTC. A capture at
`2026-08-06T00:05:08Z` must belong to August 5 because it occurred at 5:05 PM
Pacific on August 5.

This change fixes the avoidable part of the August 5–6 combined follower bar.
With Pacific grouping, Meta's reported-country totals produce separate changes:

- August 5: `5,218 - 5,057 = +161`
- August 6: `5,382 - 5,218 = +164`

It does not invent data when Meta remains stale for an entire Pacific day. The
July 21–22 interval remains combined because every capture for July 21 Pacific
was unchanged.

## Scope

Use `America/Los_Angeles` for the analytics calendar shared by:

- follower-demographic daily anchors and chart points;
- follower spike dates and the Reel-performance attribution windows around them;
- feed-post follow snapshot day keys;
- feed-follow attribution ranges, publication/tracking day comparisons, and
  drawer copy;
- frontend labels and explanatory copy for those features.

Keep database instants (`captured_at`, `posted_at`, and worker timestamps) in
UTC. Do not change unrelated operational UTC boundaries such as Gemini's daily
spend guard, event-log timestamps, or queue scheduling.

Changing the follower-flow source from demographic snapshots to
`follows_and_unfollows` is explicitly outside this design. That is a separate
product/data change.

## Approaches Considered

### 1. Change display labels only

Render UTC points with Pacific-looking dates. This is small but wrong: the
August 6 00:05 UTC refresh would still be calculated inside the August 6 bar
and merely receive a different label.

Rejected because it does not change the underlying grouping.

### 2. Rebucket only the follower chart

Group demographic snapshots by Pacific day but leave spike candidates and the
click-through feed attribution drawer on UTC days.

Rejected because clicking an August 5 bar could open evidence collected under
August 6, and spike candidates could be ranked against a different day window.

### 3. One Pacific analytics calendar

Create one timezone utility and apply it to the follower chart plus every
feature directly keyed to its day strings. Preserve UTC storage and unrelated
operational clocks.

Selected because it fixes the product-facing dates without changing the
database's timestamp semantics.

## Shared Timezone Module

Add a small pure module under `src/services/` that owns:

- `ANALYTICS_TIME_ZONE = "America/Los_Angeles"`;
- converting an instant to an analytics `YYYY-MM-DD` key;
- converting a day key to its exact Pacific start and exclusive end instants in
  UTC for database queries;
- shifting a day key by calendar days without assuming that every Pacific day
  is exactly 24 hours.

Use an IANA timezone rather than a fixed `PST` offset. Los Angeles is PDT
(UTC-7) in August and PST (UTC-8) in winter. All conversions must be independent
of the server's locale and timezone.

The frontend continues to treat `YYYY-MM-DD` as a calendar label, not as an
instant. It may parse the key at UTC midnight for formatting only, which avoids
the browser moving the label into the previous day.

## Follower Flow

`followerFlowService` groups each `GeoDemographicSnapshot.capturedAt` using the
Pacific day key. The last capture within each Pacific day remains the anchor.
`followerFlowCore` continues to diff ordered calendar anchors and mark truly
unchanged days stale.

The core's day-key enumeration can continue using UTC-midnight arithmetic on
the abstract `YYYY-MM-DD` labels. It must not use those synthetic midnights as
capture instants or query boundaries.

The August regression fixture must demonstrate:

- `2026-08-06T00:05:08Z` groups into `2026-08-05`;
- the Pacific anchors produce reported total changes of `+161` and `+164`;
- no `Aug 5–6` multi-day point is emitted for that sequence.

The July fixture must demonstrate that a full Pacific day of unchanged vectors
still becomes a stale point followed by a two-day span.

## Spike Attribution

Spike keys remain the follower point's `YYYY-MM-DD` key, now interpreted as a
Pacific day. `spikeService` converts that key into the exact Pacific start/end
instants before querying Reel performance snapshots.

The existing one-calendar-day pad and two-calendar-day baseline lookback remain,
but their boundaries are derived by shifting Pacific day keys. Do not subtract
fixed 24-hour durations across daylight-saving transitions.

## Feed Follow Collection and Drawer

New `FeedFollowDailySnapshot.day` values use the Pacific day key represented as
the existing canonical SQL `date`. The collector still stores the real
`capturedAt` instant in UTC and still keeps the latest successful reading per
media item per analytics day.

Feed-attribution range parsing, post eligibility, tracking-start partial-day
logic, and displayed publication dates use the same Pacific day utility.
Selecting a chart day therefore opens the drawer for the same business day.

### Existing feed snapshot rows

Historical feed snapshots were collapsed to one latest row per UTC day, so a
perfect Pacific end-of-day history cannot always be reconstructed. A one-time
backfill re-keys each retained row from its `capturedAt` instant and resolves a
same-media/same-Pacific-day collision by keeping:

1. the latest successful row, or
2. the latest row when neither is successful.

The backfill preserves the best evidence that exists but does not claim to
restore readings that the former UTC upsert already overwrote. The design and
tests must keep this limitation explicit. No follower-demographic or Reel
snapshot migration is needed because those tables retain every raw capture and
can be regrouped at read time.

## UI Copy

Replace follower-flow and feed-attribution references to "UTC day" with
"Pacific day" where the timezone matters. Ordinary date labels remain concise.
The dashboard should not use the abbreviation `PST` year-round.

The existing multi-day caveats remain. Pacific grouping removes artificial UTC
splits, but it cannot make Meta refresh demographic data every day.

## Error Handling and Observability

- Timezone conversion has no server-locale fallback. Invalid day keys fail at
  the existing request-validation boundary.
- Snapshot events continue to record UTC instants; no log schema changes.
- Feed collection health remains unchanged.
- Add the analytics timezone to the follower-flow diagnostic payload or log
  context so a future date-boundary investigation can identify the active
  business timezone without reading source code.

## Testing

### Pure timezone tests

- Summer conversion: `2026-08-06T00:05:08Z` -> `2026-08-05`.
- Winter conversion across the UTC date boundary.
- Spring-forward day boundaries cover 23 real hours.
- Fall-back day boundaries cover 25 real hours.
- Calendar shifting remains correct across both DST transitions.

### Follower-flow tests

- Pacific grouping splits the August 5 and 6 anchors into `+161` and `+164`
  reported changes.
- A full Pacific stale day still creates a multi-day span.
- The last capture in each Pacific day wins.

### Connected-feature tests

- Spike queries use Pacific start/end instants.
- Feed snapshots written around 00:00 UTC receive the previous Pacific day key.
- Feed range parsing and partial-day detection use Pacific dates.
- The feed drawer and selected follower bar share the same date key.
- Historical backfill collision rules prefer latest successful evidence.
- User-facing copy contains no claim that these analytics days are UTC.

Run the focused backend and frontend tests, then the complete test suites and
both production builds. Browser verification must cover the August 5–6 chart,
its hover labels, and its click-through drawer.

## Success Criteria

- Owner-facing follower analytics consistently use `America/Los_Angeles`.
- The known August sequence renders separate August 5 and August 6 points.
- The known July stale sequence remains honestly combined.
- Chart, spike candidates, and feed attribution agree on the selected day.
- Raw timestamps and unrelated operational schedules remain UTC.
- DST boundaries are tested without assuming a 24-hour local day.
