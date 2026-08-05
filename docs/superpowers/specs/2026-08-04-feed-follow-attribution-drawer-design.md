# Feed Follow Attribution Drawer Design

## Goal

Let an admin click any day in the Home follower-growth chart and understand which regular Instagram feed posts Meta credited with follows on that UTC day. This first UI covers carousels, images, and non-Reel feed videos only. Reels remain explicitly unattributed.

## Selected Experience

Use a side drawer opened from the existing daily follower chart. The drawer preserves the chart and selected spike as visual context, follows an interaction pattern already used elsewhere in the app, and becomes full-width naturally on narrow screens.

A separate page is unnecessary for a one-day diagnostic and would lose chart context. An inline expansion would make the Home dashboard jump and push its existing analysis downward.

## Chart Interaction

- Every rendered day bar, including provisional, multi-day, and stale/ghost bars, is selectable.
- Pointer hover continues to show the existing day tooltip and adds a short prompt to inspect contributing feed posts.
- The active bar uses the chart's existing dimming/highlight language while its drawer is open.
- Each selectable SVG day group exposes button semantics, a date-specific accessible label, and Enter/Space activation.
- Selecting another bar replaces the drawer's day without closing it.

The chart reports the selected UTC date to Home through an `onDaySelect(day)` callback. Home owns the selected day so chart rendering and data fetching remain separate responsibilities.

## Data Flow

Home performs a lazy React Query request only when a day is selected:

`GET /api/insights/feed-follow-attribution?from=<day>&to=<day>`

The deployed admin-only endpoint already returns the one-day attribution, collector health, completeness, contributing post metadata, account net adds, and directional residual. No backend schema, collector, or endpoint changes are required.

The query key includes the selected day. Closing and reopening a previously inspected day can use React Query's cache, while normal refetch behavior keeps the diagnostic current.

## Drawer Content

The drawer header identifies the selected date and labels the scope as feed-post attribution.

When the API returns a day, the drawer shows three summary values:

1. Account net follower change from the existing follower series.
2. Gross follows Meta attributed to regular feed posts.
3. The directional remainder after subtracting feed attribution, only when the API marks that comparison valid.

Below the summary, a collection-status callout explains whether the day is complete, partial, missing, or before tracking. It uses the API's counts for eligible, successful, unavailable, failed, and missing posts rather than inventing certainty.

Contributing posts are sorted by attributed daily increment, largest first. Each row contains:

- Thumbnail with a neutral fallback when unavailable.
- Caption, falling back to `Untitled feed post`.
- Media label: carousel, image, or feed video.
- UTC publication date when known.
- Signed follows attributed on the selected day.
- The latest cumulative lifetime follows value captured by Meta.
- A link to open the post on Instagram when a permalink exists.

## Empty, Loading, and Error States

- Loading uses compact skeletons inside the already-open drawer.
- A request error keeps the selected date visible and offers a retry action.
- A date before collector start explains that historical attribution was not fabricated.
- An incomplete date explains which readings are missing or unavailable.
- A complete date with zero contributors states that Meta attributed no feed-post follows that day.
- A successful day can still show a null comparison when the account series is provisional, missing, multi-day, or otherwise not comparable; the UI translates the API reason into plain language.

## Accuracy Language

The drawer must consistently distinguish:

- Feed-post follows: gross follows attributed by Meta to regular feed posts.
- Account follower change: net follows minus unfollows.
- Directional remainder: a diagnostic gap, not an exact Reel-follower count.

A persistent note states that Reels and Stories are excluded. It may describe the remainder as potential activity from Reels, profile discovery, older content, and other sources, but never assign it to one Reel.

## Component Boundaries

- `DailyAddsChart` owns selection mechanics and accessible bar activation.
- `Home` owns selected-day state and the one-day API query.
- `FeedFollowAttributionDrawer` owns drawer states and attribution presentation.
- A small feed-attribution view-model helper owns labels and comparison-reason copy so wording can be unit-tested without rendering the full page.
- API response interfaces live with the existing shared frontend types.

## Testing

- Unit-test media labels, comparison-reason explanations, status descriptions, and signed count formatting.
- Component-test loading, error, before-tracking, complete-zero, incomplete, and contributing-post drawer states using the project's server-rendering test pattern.
- Verify chart markup exposes date-specific button semantics and selected-day state without changing existing geometry or hover behavior.
- Run the full frontend Vitest suite, ESLint, TypeScript/Vite build, and the backend regression suite.
- Perform an authenticated browser smoke test against the local app: click a tracked chart day, verify the request dates, inspect post rows, follow the Instagram link affordance, close with Escape, and confirm mobile-width behavior.

## Out of Scope

- Exact or modeled Reel attribution.
- Story attribution.
- Identifying follower usernames.
- Historical backfill before collector deployment.
- New navigation items or a dedicated attribution route.
- Changes to the existing follower chart calculations or feed-follow collector.
