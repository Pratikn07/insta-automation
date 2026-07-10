# Tiny Soho US Growth Lab Design

Date: 2026-07-10
Status: Approved visual direction; awaiting written-spec review

## Objective

Turn the existing Insights → Experiments view into a decision-first, automated US-audience growth lab. A Tiny Soho marketer should understand within 30 seconds:

1. whether recent Reels are moving the account toward or away from a US audience;
2. which Reels are currently being evaluated automatically;
3. which completed Reels showed the strongest observed US pull;
4. which repeatable content pattern the system recommends testing next.

This remains the existing Experiments tab. It does not add a new top-level navigation item and does not require normal users to create experiments manually.

## Product principles

- Lead with the marketing decision, then show supporting evidence.
- Keep AI content fit separate from observed audience movement.
- Describe correlation and attribution confidence honestly; never present account-level geography as per-Reel geography.
- Automate enrollment and measurement for every eligible new Reel.
- Recommend a next test only when completed evidence meets a minimum support threshold.
- Preserve existing manual experiment records without making manual setup the primary workflow.

## Screen hierarchy

### 1. Page identity and automation state

The existing Experiments content is headed **US Growth Lab**, with the description: “See which Reel patterns actually attract a US audience.”

An automation badge displays the freshness of the most recent demographic snapshot. Supporting copy explains that eligible Reels are automatically analyzed and evaluated over approximately 14 days.

### 2. Current direction

The first card interprets the newest 14-day versus 90-day audience window:

- recent reached-US percentage and difference from the 90-day reached baseline;
- recent engaged-US percentage and difference from the 90-day engaged baseline;
- a plain-language headline such as “Recent Reels are pulling fewer US viewers” or “Recent Reels are pulling more US viewers.”

The direction is based on account-level Meta demographics. The card includes a concise disclosure that it describes the combined effect of recent content.

### 3. Recommended next test

The adjacent decision card recommends one content pattern to test next. It names the supporting evidence, for example: “Question hooks were positive in 4 of 5 high-confidence validations.”

A recommendation is shown only when a normalized feature has:

- at least two completed, high-confidence auto-experiments;
- a positive observed engaged-US shift in at least 60% of those experiments; and
- a positive mean engaged-US shift.

If evidence is insufficient, the card says how many more clean validations are needed. It does not fabricate a recommendation from US-fit scores alone.

### 4. Automated testing

Active auto-experiments appear as Reel cards containing:

- thumbnail and caption excerpt;
- content US-fit score;
- detected hook archetype, audio vibe, on-screen language, and up to three US cultural cues;
- collection status and approximate days remaining in the 14-day window.

The status is “Collecting audience data” until the background worker records a measurement. No manual “Measure now” action is shown for auto-experiments.

### 5. Validated Reel results

Completed cards deliberately separate:

- **AI content US-fit**: whether the Reel’s content appears culturally aligned with a US audience;
- **Observed US pull**: measured 14-day engaged-US percentage minus its saved baseline;
- **Window reach share**: the existing attribution proxy;
- **Confidence**: high when the Reel meets the existing 50% reach-share threshold, otherwise low;
- **Result**: strong potential, weak potential, or unclear.

Result definitions:

- **Strong potential**: high attribution confidence and positive observed US pull.
- **Weak potential**: high attribution confidence and negative observed US pull.
- **Unclear**: low confidence, missing measurement, or overlapping Reels.

Completed Reels are ranked by confidence first, then observed US pull, with US-fit used only as a final tie-breaker. No opaque composite score is introduced.

### 6. Learned patterns

The system groups completed high-confidence experiments by normalized content features:

- hook archetype;
- audio vibe;
- on-screen language;
- recurring US cultural cues.

Each learning displays the number of positive validations, total clean validations, average observed shift, and one of these labels:

- **Repeat**: meets the recommendation threshold;
- **Rethink**: at least two clean validations, no more than 40% positive, and a negative mean shift;
- **Collecting evidence**: anything else.

Low-confidence experiments remain visible individually but do not influence learned-pattern recommendations.

### 7. Existing manual records

The “New experiment” form is removed from the primary automated workflow. Existing manual experiments remain available in a collapsed **Manual records** section so no historical data is lost. Manual status controls remain there until a later cleanup decision.

## Data and service changes

### Enriched experiment DTO

The experiment service enriches auto-experiment responses from the related Reel metadata and content profile with:

- `thumbnailUrl`
- `permalink`
- `caption`
- `hookArchetype`
- `audioVibe`
- `onScreenLang`
- `mediaAudioType`

No database migration is required because these fields already exist on `ReelMeta` and `ReelContentProfile`.

### Client-side dashboard derivation

Pure helpers derive:

- current audience direction from the newest geo-window point;
- active and completed experiment groups;
- observed engaged-US shift;
- result label and rank;
- normalized feature groups and their evidence counts;
- the next-test recommendation.

Keeping these as pure functions makes the decision rules testable and prevents the React view from embedding analytics logic.

### Existing automated data flow

The existing background flow remains authoritative:

1. the snapshot worker discovers a Reel;
2. Gemini produces the content profile and US-fit inputs;
3. the worker creates an auto-experiment for a recent profiled Reel;
4. it saves the then-current 14-day engaged-US baseline;
5. after approximately 14 days, it saves the current 14-day engaged-US value;
6. it calculates reach-share attribution and a suggested verdict;
7. the UI translates that evidence into marketer-facing result and learning labels.

The UI does not trigger measurement and does not change the background worker’s current 14-day or 50% rules in this iteration.

## Component boundaries

- `Experiments`: fetches data, handles loading/error states, and assembles the view.
- `GrowthDirectionCard`: explains 14-day versus 90-day movement.
- `NextTestCard`: displays either an evidence-backed recommendation or an evidence-collection state.
- `ActiveExperimentCard`: displays content profile and collection progress.
- `ValidatedExperimentCard`: separates predicted content fit from observed pull and attribution.
- `LearnedPatterns`: lists repeat, rethink, and collecting-evidence groups.
- `ManualExperimentSection`: preserves legacy manual records in a collapsed secondary area.
- `experimentInsights` pure helper module: owns all grouping, ranking, normalization, and recommendation rules.

The existing large Insights page may retain the presentation components for this preview iteration, but decision logic must live outside the page component.

## Empty, loading, and error behavior

- While data loads, the summary and Reel regions use stable skeletons.
- If geo data is unavailable, the direction card explains that the next snapshot is required.
- If no auto-experiments exist, the page explains automatic enrollment and shows no manual creation CTA.
- If experiments are active but none are complete, the recommendation card explains that results unlock after the 14-day window.
- If completed results are all low confidence, the page explains that overlapping Reels prevent a reliable content recommendation.
- Query failures show a retry action and retain any independently loaded sections.
- Missing thumbnails use the existing Reel placeholder.

## Responsive and accessibility behavior

- Summary and recommendation use two columns on desktop and stack on narrow screens.
- Reel grids become a single column on mobile.
- Body copy is at least 12px on desktop and 14px on mobile; critical explanations are not rendered as ultra-small footnotes.
- Status is communicated by text and icon, not color alone.
- Links, buttons, and collapsed-section controls have visible focus states and minimum 44px touch targets.
- The trend direction has an accessible text summary; the chart is supporting evidence rather than the only representation.

## Verification

### Decision-rule tests

- direction copy and deltas for positive, negative, zero, and missing metrics;
- observed-shift calculation;
- high- versus low-confidence result labels;
- completed-result ranking;
- feature normalization and grouping;
- recommendation and rethink thresholds;
- exclusion of low-confidence outcomes from learned patterns.

### Service tests

- auto-experiment DTO enrichment when Reel metadata/profile exists;
- safe null behavior for deleted or incomplete Reel metadata;
- manual experiment compatibility.

### UI verification

- loading, no-data, active-only, validated, and low-confidence states;
- desktop and 375px mobile layouts;
- keyboard navigation and visible focus;
- production TypeScript build and lint.

### Deployment

After verification, deploy the `web` project as a Vercel preview. Production is not replaced during visual review. The preview must use its configured API environment so the page renders real experiment data.

## Out of scope

- A new top-level navigation tab;
- manual per-Reel geography, which Meta does not provide;
- statistical significance or causal claims;
- changing the 14-day measurement window or 50% dominance threshold;
- automated content publishing;
- a generic choose-any-country product;
- redesigning the Leaderboard or Recipe tabs.
