# Dashboard analytics removal verification

## Scope

Home now uses stats and guide-follow funnel evidence for operational readiness and reply rate. It no longer requests or displays follower-growth reporting. Insights retains content analysis, re-analysis, conversion context, commenter-origin analysis and content experiments; generic audience/performance reporting is removed.

Backend collectors, stored analytics, API contracts, database schema, Meta behavior, navigation, funnels and recovery are unchanged by this PR. Existing shared reporting components remain available to other consumers.

## Local verification

- Frontend suite: 75 files, 968 tests passed.
- Production frontend build passed (existing large-chunk advisory).
- Eight desktop/mobile browser cases passed, covering operational Home, populated Insights tabs and drawers, retained navigation, and horizontal overflow.
- Focused regressions cover failed sources, small samples, measured zero, retries, content experiment identity and absent follower requests.
- Independent source review found no critical or important issues. Mobile drawer screenshots wait for the animation to settle.
- Scoped diff review found no backend, schema, lockfile, environment or deployment-config changes.

## Synthetic screenshots

These use the browser fixture harness, not production data.

- [Desktop Home](artifacts/2026-10-04-dashboard-analytics-removal/desktop/home-shell.png)
- [Mobile Home](artifacts/2026-10-04-dashboard-analytics-removal/mobile/home-shell.png)
- [Mobile Insights detail](artifacts/2026-10-04-dashboard-analytics-removal/mobile/insights-detail.png)
- [Desktop Insights Recipe](artifacts/2026-10-04-dashboard-analytics-removal/desktop/insights-recipe.png)

## Release and rollback

Vercel deploys from main through the Git integration. Production verification must confirm the merged revision and inspect signed-in Home, Insights and retained operational routes. Reverting this scoped PR restores the reporting UI without a database restore or collector backfill.
