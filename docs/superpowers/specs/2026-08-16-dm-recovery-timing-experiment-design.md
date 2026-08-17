# GROW-002 DM Recovery Timing Experiment Design

**Date:** 2026-08-16

**Status:** Approved

**Feature:** GROW-002, timely recovery reminder

**Internal experiment version:** `read-recovery-timing-v2`

## 1. Decision summary

GROW-002 will move from the current ten-hour treatment-versus-control experiment to a new prospective timing experiment for newly accepted guide DMs.

The new assignment is:

- 45% receive one public recovery reminder after two hours.
- 45% receive the same public recovery reminder after six hours.
- 10% receive no public recovery reminder and form the control group.

The unit of assignment and analysis is the Instagram follower, identified by `igUserId`. A follower remains in the same arm for the entire experiment version.

The primary outcome is completed guide delivery within 48 hours of the original gate DM acceptance. The outcome window begins at `acceptedAt` for every arm, not at the reminder time.

The dashboard will use a date-range control instead of a campaign or experiment selector. It will offer `7d`, `14d`, `30d`, `All`, and a custom calendar. The default is `30d`.

## 2. Context

The existing prospective recovery feature is already running in production. It records a recovery candidate when Instagram accepts a guide gate DM but no read confirmation is available. The current treatment arm waits ten hours, then posts one public reply on the original Instagram comment if the follower has not produced a seen, reply, or completion signal.

The current implementation already contains important production controls:

- deterministic treatment/control assignment;
- a frozen eligibility timestamp;
- seen, reply, engagement, completion, source, market, cooldown, and newer-candidate suppressions;
- a claim and lease protocol around public sends;
- retries for known transient failures;
- uncertain-send handling that avoids duplicate comments;
- hourly and daily caps;
- a recovery circuit breaker;
- metrics and owner-visible reminder records.

Production behavior reviewed on 2026-08-16 showed that most natural engagement occurs early. Among followers with at least ten hours of observation, 44.6% had a positive signal by two hours, 46.9% by six hours, and 48.3% by ten hours. The existing experiment did not show a convincing completion lift, so a permanent full rollout is not justified. The next test should isolate timing while preserving a no-reminder baseline.

## 3. Goals

1. Determine whether a two-hour or six-hour public recovery reminder produces a meaningfully higher 48-hour guide-completion rate.
2. Preserve a 10% no-reminder control so the team can detect whether both reminder timings are worse than doing nothing.
3. Keep the public reply safe, rate-limited, deduplicated, and suppressible until the final authorization immediately before sending.
4. Make experiment assignment and historical reporting reconstructable after configuration changes.
5. Give the owner a simple date-based dashboard rather than requiring knowledge of campaign or experiment names.
6. Preserve all existing v1 rows and outcomes without retroactive reassignment.

## 4. Non-goals

This work will not:

- change the recovery comment copy;
- test multiple comment-copy variants;
- send more than one recovery reminder inside the existing 24-hour person cooldown;
- release a no-reminder control follower later;
- modify historical-recovery campaigns;
- change the immediate `settings_blocked` recovery path;
- build a generic experimentation platform;
- automatically roll out a winner without owner review;
- claim that a missing Meta read receipt proves the DM is unread.

## 5. Terminology

- **Gate DM:** The first guide DM accepted by Instagram after a qualifying public keyword comment.
- **No confirmed read:** No trusted Meta seen or engagement signal has been recorded. This does not prove the follower has not read the message.
- **Timing arm:** `two_hour`, `six_hour`, or `no_reminder`.
- **Matured follower:** A follower whose primary 48-hour outcome window has fully elapsed.
- **Index journey:** The earliest qualifying v2 recovery journey for a follower inside the selected date range. Each follower contributes one index journey to the primary analysis.
- **Pacific analytics day:** A calendar day in `America/Los_Angeles`, consistent with the existing dashboard date-range conventions.

## 6. Experiment population

Only prospective `no_confirmed_read` journeys qualify for the timing experiment.

The following pre-assignment eligibility rules must hold:

1. Instagram accepted the original gate DM.
2. The journey originated from a captured public keyword comment.
3. The gate DM has a trusted Instagram message identifier so seen and engagement signals can be correlated.
4. The original public comment identifier required for a reply is present at scheduling time. Media metadata is retained when available but is not required to post a reply to the captured comment.
5. The frozen audience-origin decision is in market under the active Western-audience policy.
6. The accepted time falls inside the v2 enrollment window.
7. The journey is not a `settings_blocked` fallback.

Rows that fail these pre-assignment requirements may still be stored for operational evidence, but they receive no v2 timing arm and never enter a v2 denominator.

Conditions that arise after assignment, such as the follower viewing the DM, replying, completing, or the source comment becoming unavailable, remain post-assignment suppressions. Those followers stay in their assigned arm for intent-to-treat analysis.

## 7. Assignment

Assignment is deterministic per `(experimentVersion, igUserId)`.

The assignment function will:

1. Hash `read-recovery-timing-v2:<igUserId>` with SHA-256.
2. Read an unsigned 32-bit prefix.
3. Convert it into a bucket from 0 through 9,999 with `floor(uint32 / 2^32 * 10000)`.
4. Assign buckets 0 through 4,499 to `two_hour`.
5. Assign buckets 4,500 through 8,999 to `six_hour`.
6. Assign buckets 9,000 through 9,999 to `no_reminder`.

This produces the required 45/45/10 allocation without shared mutable counters. The same follower always receives the same arm within v2, including repeated guide requests.

The allocation implementation must have deterministic fixtures and a large synthetic distribution test. Production allocation health will be reviewed after the first 100 unique followers. The review is an alerting and validation step, not a reason to reassign followers.

## 8. Persistence design

The recommended design extends `DmRecoveryReminder` rather than introducing a generic campaign platform.

Add:

```prisma
enum DmRecoveryTimingArm {
  two_hour
  six_hour
  no_reminder

  @@map("dm_recovery_timing_arm")
}

model DmRecoveryReminder {
  // Existing fields omitted.
  experimentVersionSnapshot String?              @map("experiment_version_snapshot")
  timingArm                  DmRecoveryTimingArm? @map("timing_arm")

  @@index([experimentVersionSnapshot, acceptedAt])
}
```

Existing rows keep null values in both new columns. They are not backfilled into the new three-arm model because v1 has a different intervention and cannot be compared with v2.

For new qualifying v2 rows:

- `experimentVersionSnapshot` is `read-recovery-timing-v2`.
- `timingArm` is always non-null.
- `cohort` remains `treatment` for `two_hour` and `six_hour`.
- `cohort` remains `control` for `no_reminder`.
- `eligibleAt` is frozen as `acceptedAt + 2 hours` or `acceptedAt + 6 hours` for treatment rows.
- `status` begins as `waiting` for treatment rows.
- `status` begins and remains `control` for no-reminder rows.
- Because the existing schema requires a non-null `eligibleAt`, a no-reminder row stores `acceptedAt` in `eligibleAt` as a non-operative sentinel. Metrics never use that sentinel as the outcome anchor.

The migration must add the enum, nullable columns, and composite index additively. It must not rewrite or lock the existing reminder table longer than required for metadata changes.

A database check constraint will enforce the v2 arm/cohort relationship:

- `two_hour` and `six_hour` require `cohort = treatment`.
- `no_reminder` requires `cohort = control` and `status = control`.

Application repository methods and database contract tests must prove that `experimentVersionSnapshot`, `timingArm`, `acceptedAt`, and the initially calculated `eligibleAt` are never changed after insertion.

## 9. Scheduling and worker flow

### 9.1 Candidate creation

When Instagram acceptance is captured:

1. Resolve the pre-assignment eligibility facts.
2. Assign the follower to a timing arm.
3. Render and freeze the existing public reply copy.
4. Freeze the experiment version, timing arm, audience snapshot, accepted time, and eligibility time in one insert/upsert operation.
5. Return without sending anything.

### 9.2 No-reminder arm

A no-reminder row is terminal at creation. It never enters the worker claim query, cannot be owner-cancelled, and cannot later be converted into a waiting row. Seen, reply, and completion signals may still be attributed to it for baseline measurement without changing its control status.

### 9.3 Treatment arms

The existing worker claims treatment rows only after their frozen `eligibleAt`. Immediately before any public Meta call, it reauthorizes the row against current evidence.

The final authorization order remains:

1. terminal or cancelled state;
2. seen, reply, engagement, or completion evidence;
3. source comment availability;
4. audience policy;
5. tracking availability;
6. person cooldown;
7. newer eligible candidate;
8. eligibility time;
9. cohort and timing-arm consistency;
10. public send.

The policy layer must not read current timing configuration to recompute eligibility. It trusts the persisted `eligibleAt` and `timingArm`.

### 9.4 Copy

Both treatment arms use the same frozen copy and template version:

> I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “[KEYWORD]”.

Timing is the only treatment variable.

## 10. Safety requirements

The experiment preserves the existing safeguards:

- one public reminder per person inside the 24-hour cooldown;
- no send after confirmed seen, inbound reply, quick reply, attachment, reaction, postback, or completed journey;
- no send when a newer eligible request exists;
- no send when the public source is unavailable;
- no send without trusted message tracking;
- no send to an out-of-market audience under the active Western-only policy;
- hourly and global daily caps;
- database-backed claims, leases, fencing tokens, and dispatch reservations;
- pre-send reauthorization after claiming;
- no automatic retry after an uncertain provider outcome;
- owner cancellation and review controls;
- circuit-breaker protection.

The circuit opens for the existing reasons:

- authentication or permission failure;
- missing webhook signal health;
- anomalous backlog growth;
- excessive public-send failure rate;
- hourly-cap exhaustion;
- repeated database failures.

Opening the circuit stops public sends but preserves pending rows, arm assignments, and measurement data.

## 11. Failure handling

Known transient failures use the existing bounded retry schedule. Retries keep the same timing arm, eligibility time, copy, claim fencing, and dispatch identity.

Permanent provider failures settle the row as failed and are included in the arm’s operational metrics.

Timeouts, resets, success responses without a public reply identifier, and other ambiguous outcomes settle as `send_uncertain`. They are never automatically retried because the public comment may already exist.

If Meta confirms a send but the database finalizer fails, lease reconciliation moves the row to an uncertain state. It must not initiate another public send.

Invalid v2 configuration must fail validation at process startup. The application must not silently fall back to a different split or delay.

## 12. Outcome measurement

### 12.1 Primary outcome

The primary outcome is completed guide delivery within 48 hours of the index journey’s `acceptedAt`.

A completion counts only when:

```text
acceptedAt <= completedAt <= acceptedAt + 48 hours
```

The start is identical across all three arms. Metrics must not anchor at `eligibleAt`, because that would give the six-hour arm a different observation period from the two-hour arm.

### 12.2 Analysis unit

The primary analysis is by unique follower.

For a selected date range:

1. Find qualifying v2 journeys whose `acceptedAt` falls within the inclusive Pacific date range.
2. Exclude journeys whose audience snapshot was pre-assignment ineligible.
3. Group by `igUserId`.
4. Select the earliest qualifying journey as that follower’s index journey.
5. Use the follower’s persisted timing arm.
6. Count at most one completion for that follower.

Per-journey counts remain available as secondary operational context but never replace the unique-follower denominator.

### 12.3 Maturity

A follower is matured only when the full 48-hour window has elapsed at the report’s fixed `asOf` time. Immature followers appear as “still collecting results” and are excluded from completion-rate denominators.

The API returns one `asOf` timestamp for the full response so pagination, counts, and metrics cannot disagree as wall-clock time advances.

### 12.4 Secondary metrics

For each arm, report:

- assigned unique followers;
- matured unique followers;
- immature unique followers;
- guide completions within 24 and 48 hours of acceptance;
- completion rates;
- inbound replies within 24 and 48 hours of acceptance;
- confirmed seen before eligibility;
- public reminders sent;
- reminders suppressed, broken down by reason;
- send failures and uncertain sends;
- median reminder-to-reply time for sent treatment rows;
- late-send count and lateness distribution;
- duplicate-attempt count;
- cooldown suppressions;
- read-event coverage;
- arm-allocation percentages.

Settings-blocked reminders and v1 rows are excluded from all v2 comparisons.

## 13. Experiment duration and decision rule

Enrollment runs for at least 28 full days. The target is at least 1,700 matured unique followers in each timing arm, which is sized to detect an absolute difference of approximately two percentage points near the observed baseline with 80% power at a two-sided 5% significance level.

At day 28, the operator checks assignment counts only, without using completion outcomes. If both timing arms have at least 1,700 matured followers, enrollment closes at a recorded cutoff instant. If either arm is below target, enrollment continues to day 35 and the same blinded count check is repeated. Day 42 is the mandatory final cutoff. If the target is still not reached, the final result is labelled inconclusive.

After enrollment closes, the system waits 48 additional hours before final analysis.

The primary comparison is `two_hour` versus `six_hour`. A timing arm is declared the winner only when:

1. its 48-hour completion rate is at least 2.0 percentage points higher;
2. a standard pooled two-sided two-proportion z test reports `p < 0.05`, and the unpooled 95% confidence interval for the difference excludes zero;
3. its public-send failure and safety indicators are not materially worse.

For this decision, materially worse has one fixed operational meaning:

- The combined public-send exception rate, `(send_failed + send_uncertain) / reminders with at least one attempt`, must not exceed the other timing arm by more than 2.0 percentage points.
- The delayed-signal false-positive rate, defined as attempted reminders for which a trusted positive signal happened before dispatch but was received after dispatch, must not exceed the other timing arm by more than 2.0 percentage points.
- Any confirmed duplicate automated public recovery reply is a zero-tolerance safety event. A timing arm with such an event cannot be rolled out until the incident is reviewed and the duplicate path is closed.

These thresholds are rollout guardrails, not additional statistical winner tests. The existing circuit breaker may pause sending at stricter operational thresholds while enrollment is in progress.

The no-reminder arm is a safety baseline. Its 10% allocation is not expected to power small treatment-versus-control differences. If both timing arms are at least 2.0 percentage points below the control point estimate, or a treatment-versus-control confidence interval indicates harm, neither timing is rolled out without a new owner review.

If the timing comparison is inconclusive and no harm guardrail fires, six hours is the default because it is the less aggressive public follow-up.

There is no automatic winner rollout.

## 14. Dashboard design

The prospective DM recovery view uses the existing dashboard date-range pattern:

- `7d`
- `14d`
- `30d`
- `All`
- custom calendar range

The default is `30d`, clipped to available v2 data coverage. `All` means all available v2 coverage, not v1 plus v2.

The selected range describes followers whose original accepted guide DM falls within those Pacific calendar days. The UI must say this plainly.

Example:

> Showing guide requests received from July 18 to August 16. Results complete through August 14. 92 newer followers are still collecting 48-hour outcomes.

The dashboard shows three side-by-side summary cards:

1. Two-hour reminder
2. Six-hour reminder
3. No reminder

Each card includes matured followers, completed guides, completion rate, and treatment-specific operational counts where applicable.

The existing reminder table, status tabs, keyword filter, and detail drawer remain. The list and counts receive the same date range and fixed `asOf` value as the summary.

The UI does not expose a campaign or experiment dropdown. Internal experiment versions remain available for audit and API filtering but are not required user knowledge.

Partial date ranges are exploratory. The dashboard must not label a winner based on a selected `7d`, `14d`, `30d`, or custom slice. A final winner label appears only for the full experiment window after enrollment has closed and all outcomes have matured.

## 15. API design

### 15.1 List

Extend the existing list endpoint:

```http
GET /recovery-reminders?view=sent&from=2026-08-01&to=2026-08-16&asOf=...
```

`from` and `to` are inclusive Pacific analytics days applied to `acceptedAt`. The server converts them to a half-open instant range. Existing cursor pagination remains stable under the echoed `asOf` value.

Each v2 row returns `timingArm` and a user-facing timing label.

### 15.2 Counts

Extend counts with the same date range and `asOf`:

```http
GET /recovery-reminders/counts?from=2026-08-01&to=2026-08-16&asOf=...
```

Badges must describe the filtered list rather than global totals.

### 15.3 Metrics

Extend metrics:

```http
GET /recovery-reminders/metrics?from=2026-08-01&to=2026-08-16&asOf=...
```

The response includes:

- selected date range;
- available v2 coverage;
- fixed `asOf`;
- results-complete-through date;
- two-hour summary;
- six-hour summary;
- no-reminder summary;
- pairwise timing difference, confidence interval, and final-decision eligibility;
- allocation health;
- existing recovery health and accuracy sections.

The metrics response establishes the server-generated `asOf` timestamp and effective clamped date range for a dashboard load. The browser then sends those exact values to list and counts. This handshake keeps all three endpoint responses on one time and date boundary without trusting the browser clock.

List cursors are opaque tokens bound to the effective `from`, `to`, and `asOf` values. Reusing a cursor with a different range or time boundary returns `400 invalid_cursor_scope`.

The endpoint scopes to `experimentVersionSnapshot = read-recovery-timing-v2` internally. The browser never supplies an experiment name.

### 15.4 Validation

Date validation follows these rules:

- the API rejects malformed dates;
- the browser normalizes a custom calendar selection, while the API rejects direct requests where `from > to`;
- a range with no overlap with available v2 coverage is rejected;
- an overlapping range that extends beyond available coverage is clamped, and the effective range is returned in the response;
- the API rejects `asOf` values in the future;
- the API rejects cursors whose original date range or `asOf` does not match the current request.

## 16. Configuration and cutover

The implementation reuses the existing experiment window and version controls. Code branches on the explicit experiment version.

During v1, the new code remains dormant because the configured version is not `read-recovery-timing-v2`.

At cutover, production configuration changes together:

- `DM_RECOVERY_EXPERIMENT_VERSION=read-recovery-timing-v2`
- `DM_RECOVERY_EXPERIMENT_START_AT=<cutover instant>`
- `DM_RECOVERY_EXPERIMENT_END_AT=<day-42 maximum end instant>`
- `DM_RECOVERY_POST_EXPERIMENT_ENABLED=false`

The v2 branch uses the fixed 45/45/10 split and fixed two/six-hour delays from this specification. It does not read the legacy single-delay value to choose a v2 arm.

Previously created v1 rows retain their stored ten-hour eligibility, cohort, and copy. Waiting v1 rows are allowed to finish under v1 rules. Only DMs accepted at or after the v2 start instant enter v2.

Changing copy, delays, split percentages, eligibility rules, or assignment hashing requires a new experiment version. Enrollment may close at day 28 or day 35 when the blinded matured-assignment target is met. It closes no later than the configured day-42 maximum.

## 17. Rollout

1. Add the nullable schema fields, enum, constraint, and index.
2. Deploy code that can read legacy null arms and write v2 arms, while v1 configuration remains active.
3. Run database contract tests and a production read-only compatibility check.
4. Confirm the existing recovery circuit is closed and webhook signal health is normal.
5. Change the version and experiment window at one cutover instant.
6. Verify the first v2 rows contain the expected version, timing arm, cohort, status, and eligibility timestamp.
7. Audit the first 20 public v2 reminders against Instagram and stored evidence.
8. Review aggregate arm allocation after the first 100 unique followers.
9. Continue normal circuit, failure-rate, backlog, and cap monitoring.
10. Perform the final analysis only after enrollment closes and all 48-hour windows mature.

## 18. Rollback

The existing prospective recovery enable switch remains the emergency stop. Disabling it stops new public recovery comments without deleting assignments or outcomes.

Rollback must not:

- reassign followers;
- release no-reminder controls;
- delete v2 rows;
- move v2 rows into v1;
- retry uncertain public sends.

After a rollback, pending treatment rows stay stored. Resuming the same experiment version is allowed only if the interruption and its effect on lateness are documented. A material or prolonged interruption requires closing v2 and launching a new version.

## 19. Testing strategy

### 19.1 Unit tests

- same `(version, igUserId)` always produces the same arm;
- different versions can re-randomize the same follower;
- synthetic assignment approximates 45/45/10 within a fixed tolerance;
- bucket boundaries map exactly to the intended arms;
- two-hour eligibility is exactly `acceptedAt + 2h`;
- six-hour eligibility is exactly `acceptedAt + 6h`;
- no-reminder rows are terminal controls;
- settings-blocked rows never receive a timing arm;
- all existing suppression precedence remains unchanged;
- Pacific date conversion is correct across daylight-saving transitions;
- 48-hour maturity and completion boundaries are inclusive as specified;
- the earliest journey is selected once per follower.

### 19.2 Database contract tests

- migration preserves legacy rows;
- v2 timing-arm/cohort constraints reject inconsistent rows;
- v2 assignment fields cannot be changed by repository lifecycle operations;
- control rows cannot be claimed;
- treatment claims honor their frozen eligibility;
- concurrent workers cannot post twice;
- completion attribution updates outcomes without changing control status;
- the composite index supports version-plus-date queries.

### 19.3 Service and API tests

- pre-assignment ineligible rows do not enter v2 denominators;
- post-assignment suppressions stay in intent-to-treat denominators;
- metrics anchor at `acceptedAt`, never `eligibleAt`;
- settings-blocked and v1 rows are excluded;
- date range, counts, list, and metrics use the same Pacific boundaries;
- pagination preserves date range and `asOf`;
- immature followers are separated from matured denominators;
- duplicate journeys do not duplicate followers;
- outcome rates and timing differences are calculated correctly;
- partial ranges never produce a winner label;
- final decision rules handle winner, tie, harm guardrail, and inconclusive cases.

### 19.4 UI and end-to-end tests

- `30d` is the default range;
- `7d`, `14d`, `30d`, `All`, and custom range controls update all page sections;
- the page explains that dates refer to original guide requests;
- all three arms render side by side;
- immature outcome messaging is visible;
- row counts agree with the selected date range;
- timing arm is visible in each v2 reminder detail;
- controls never display a send action;
- circuit-open messaging remains visible and pending rows remain accessible;
- keyboard and screen-reader interactions for the range calendar remain consistent with the existing component.

### 19.5 Production verification

Production checks use aggregate counts or explicitly audited first-send records. No follower names, handles, messages, or other personal data appear in logs or handoff reports.

## 20. Acceptance criteria

The feature is ready to activate only when all of the following are true:

1. Every qualifying v2 follower receives one stable timing arm.
2. Aggregate assignment is generated by the approved 45/45/10 deterministic function.
3. Two-hour and six-hour eligibility timestamps are frozen correctly.
4. No-reminder controls cannot enter the worker claim path.
5. Existing v1 rows continue to process without migration or reporting corruption.
6. The worker performs the full final authorization before each public send.
7. Uncertain sends cannot be automatically retried.
8. Metrics use unique followers and a 48-hour window anchored at acceptance.
9. Settings-blocked, legacy, pre-assignment ineligible, and immature rows are handled exactly as specified.
10. The dashboard uses the approved date-range control and no campaign/experiment selector.
11. Partial date ranges cannot declare a winner.
12. Unit, database contract, API, UI, and end-to-end tests pass.
13. The migration is additive and production compatibility is verified before cutover.
14. The recovery circuit and emergency stop remain effective.
15. The first-send and first-allocation production audits are documented.

## 21. Approved product decisions

- Autonomous public recovery remains allowed inside existing safeguards.
- The new split is 45% two-hour, 45% six-hour, and 10% no reminder.
- Guide completion within 48 hours of DM acceptance is the primary outcome.
- Assignment is persisted and stable per follower.
- Timing is the only treatment variable.
- The dashboard uses dates rather than campaign or experiment selection.
- The minimum enrollment period is 28 days, with a blinded sample-size extension allowed through day 42.
- A practical winner requires at least a two-percentage-point lift and statistical reliability.
- Six hours is the conservative default if the timing comparison is inconclusive and no harm guardrail fires.
- No arm is automatically rolled out after the experiment.
