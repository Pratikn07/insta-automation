# Home Growth Dashboard Design

## Goal

Turn the home screen into a visual, decision-oriented answer to two equally important questions:

1. Is the account's US audience growing?
2. Which reels are worth repeating?

The audience-growth answer appears first because it is the primary strategic question. Reel performance receives equal visual weight in the main two-column layout.

## Data sources

- `GET /api/insights/geo-window-trend` supplies recent 14-day and baseline 90-day US percentages for reached and engaged audiences.
- `GET /api/insights/leaderboard` supplies latest per-reel reach, views, skip rate, US-fit context, and guide-delivery conversions.
- `GET /api/stats` supplies a compact automation-health footer.

No new database tables, migrations, external API calls, or backend endpoints are required.

## Visual hierarchy

The page begins with a short title and one-line explanation. Beneath it, two equally sized panels form the main dashboard:

- **US audience growth:** a large current 14-day US percentage, directional verdict, percentage-point delta from the 90-day baseline, compact trend line, and separate reached/engaged comparison bars.
- **Reels to repeat:** the top three repeat candidates, using thumbnail-led cards with reach, retention, guide delivery, and a plain-language reason.

A compact automation-health strip sits below both panels. Operational metrics are retained but deliberately demoted so they do not compete with the strategic questions.

## Audience-growth rules

- Prefer `reachedUs14` versus `reachedUs90` for the headline.
- Fall back to engaged percentages when reached data is unavailable.
- Delta of at least `+2.0` percentage points is **Growing**.
- Delta at most `-2.0` percentage points is **Cooling**.
- Anything between is **Holding steady**.
- Copy must say “percentage points,” not percent growth.
- The panel explicitly calls the comparison a directional account-level signal, not follower attribution.

## Repeat-candidate rules

Reels are ranked only from measured performance. US-fit is displayed as context and never contributes to rank.

- Reach percentile: 50%.
- Retention percentile, derived from inverse skip rate: 30%.
- Guide-delivery percentile: 20%.
- Missing metrics receive a neutral zero contribution rather than invented values.
- At least one measured performance signal is required.
- The top three candidates are displayed.

Each candidate receives one reason chosen from its strongest signal: reach, retention, or guide delivery. This keeps recommendations understandable rather than presenting an opaque score.

## States and responsiveness

- Each main panel loads independently.
- Missing geography shows a helpful “waiting for a snapshot” state.
- Missing reel metrics shows a helpful “waiting for performance data” state.
- API failures show a retry action without hiding the other panel.
- On mobile, panels stack and reel metrics remain readable without horizontal scrolling.
- SVG charts include accessible labels and do not rely on color alone.

## Testing

Pure dashboard calculations are isolated in `web/src/lib/homeDashboard.ts` and tested with Vitest. Tests cover growth thresholds, fallback behavior, percentile ranking, performance-only ranking, and missing data. Production builds and existing lint are run after implementation; unrelated pre-existing lint failures are reported separately.
