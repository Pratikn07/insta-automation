# DM recovery timing experiment runbook

This runbook controls activation and operation of
`read-recovery-timing-v2`. The experiment compares a public recovery comment at
two hours, the same recovery at six hours, and no reminder. Assignment is a
code-frozen 45% / 45% / 10% split by unique Instagram follower.

Deploying the code is not permission to activate it. Production configuration
must remain on v1 until every preflight item below is complete. No step in the
code release changes production configuration or contacts a follower.

## Fixed rules

- The experiment version is exactly `read-recovery-timing-v2`.
- The primary outcome is guide completion within 48 hours of the original gate
  DM acceptance.
- The primary comparison is `two_hour` versus `six_hour` by unique follower.
- The no-reminder arm is a safety baseline and is terminal at assignment.
- Settings-blocked reminders, out-of-market exclusions, untracked gates, v1
  rows, and requests outside the configured window are not randomized into v2.
- Arm, version, eligibility, copy, and outcome anchors are immutable after a v2
  row is created.
- Partial dashboard ranges are exploratory. Only `All`, covering the complete
  experiment window after maturation, can support the final decision.
- There is no automatic rollout. A final API winner still requires owner review.

The legacy variables `DM_RECOVERY_DELAY_HOURS` and
`DM_RECOVERY_HOLDOUT_PERCENT` remain inputs to v1 only. V2 ignores them and uses
the fixed schedules and allocation above.

## Phase 1: deploy compatible code with v1 still active

1. Keep production configuration on `DM_RECOVERY_EXPERIMENT_VERSION=read-recovery-v1`.
2. Apply the additive Prisma migration, then deploy the compatible API, worker,
   and web code. Do not remove or rewrite existing v1 rows.
3. Confirm migration status and run the disposable real-Postgres contract with
   both URLs pointing to the same disposable local database:

   ```bash
   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" \
   MIGRATION_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" \
   MIGRATION_TEST_DATABASE_DISPOSABLE=true \
   npx vitest run src/services/dmRecoveryDatabaseContract.test.ts
   ```

   The result must report zero skipped tests. A missing
   `MIGRATION_TEST_DATABASE_URL`, a skip, or any failure blocks activation.
4. Run a production read-only compatibility check: the Recovery screen, legacy
   rows, health metrics, and existing waiting v1 reminders must still load.
5. Confirm `messaging_seen`, `message_reactions`, `messaging_postbacks`,
   `messages`, and `comments` are subscribed and that recent signed events are
   reaching the expected stored gate message IDs.
6. Confirm the recovery circuit is closed, credentials are valid, no uncertain
   send is unreviewed, and hourly/daily caps are conservative.

## Phase 2: prepare the cutover

The owner-approved cutover is **21 August 2026 at 5:00 AM Pacific**. The recorded
UTC instant is `2026-08-21T12:00:00.000Z`; the maximum end, exactly 42 days
later, is `2026-10-02T12:00:00.000Z`.

Prepare these values together:

```dotenv
DM_RECOVERY_EXPERIMENT_VERSION=read-recovery-timing-v2
DM_RECOVERY_EXPERIMENT_START_AT=2026-08-21T12:00:00.000Z
DM_RECOVERY_EXPERIMENT_END_AT=2026-10-02T12:00:00.000Z
DM_RECOVERY_POST_EXPERIMENT_ENABLED=false
```

The process rejects v2 windows shorter than 28 days or longer than 42 days and
rejects post-experiment enablement. Do not change copy, hashing, split, delays,
eligibility, or safety thresholds during enrollment. Such a change requires a
new version and a new experiment.

Record before changing configuration:

- the owner approving activation;
- start and maximum-end instants;
- deployed commit and migration name;
- real-Postgres contract result with zero skips;
- Meta signal verification time;
- circuit state and current caps.

Do not include follower IDs, handles, names, message text, comment text, or
tokens in the activation record.

## Phase 3: activate and verify early operation

1. Apply all four v2 values in one configuration release. Keep
   `DM_RECOVERY_ENABLED=false` until the deployment has booted successfully and
   the configuration is visible as intended.
2. Enable `DM_RECOVERY_ENABLED=true` in the approved window. Record that instant.
3. Verify the first persisted row observed in each arm without selecting or
   logging follower identity:

   ```sql
   WITH ranked AS (
     SELECT
       experiment_version_snapshot,
       timing_arm,
       cohort,
       status,
       accepted_at,
       eligible_at,
       attempts,
       sent_at,
       ROW_NUMBER() OVER (PARTITION BY timing_arm ORDER BY accepted_at, id) AS position
     FROM dm_recovery_reminder
     WHERE experiment_version_snapshot = 'read-recovery-timing-v2'
   )
   SELECT
     experiment_version_snapshot,
     timing_arm,
     cohort,
     status,
     accepted_at,
     eligible_at,
     eligible_at - accepted_at AS scheduled_delay,
     attempts,
     sent_at
   FROM ranked
   WHERE position = 1
   ORDER BY timing_arm;
   ```

   Expected: `two_hour` is treatment and scheduled at two hours; `six_hour` is
   treatment and scheduled at six hours; `no_reminder` is a control with no
   attempts or send. Do not export query results to logs.
4. Audit the first 20 actual treatment comments in the owner dashboard and on
   Instagram. For each, confirm the stored accepted time, arm, eligibility,
   evidence available before dispatch, one public comment at most, copy, and
   final send outcome. Store only the audit verdict and aggregate issue count;
   do not copy personal content into a ticket or log.
5. After 100 unique randomized followers, review aggregate allocation only.
   Expect approximately 45% / 45% / 10%. Investigate assignment drift or a
   missing arm immediately; do not rebalance or reassign rows.

## Ongoing monitoring

Review the Recovery dashboard and health metrics daily:

- circuit state, ready backlog, oldest eligibility, and cap usage;
- assignment drift and observed arm allocation;
- late sends and lateness distribution;
- failures, uncertain sends, and send-exception rate by treatment arm;
- delayed-signal false positives and read-event coverage;
- cooldown suppressions and duplicate attempts;
- confirmed duplicate sends, which are a zero-tolerance safety event;
- treatment-versus-control harm flags.

Immature followers are expected and must remain outside the 48-hour outcome
denominator. Do not infer unread state from missing events. Do not use a partial
date range to choose a winner.

## Blinded enrollment checks and cutoff

The day-28 and day-35 checks are sample-size checks only. Do not view or export
completion counts, completion rates, pairwise differences, confidence
intervals, p-values, replies, or winner state while deciding whether to extend
enrollment.

At day 28, inspect only matured unique assignment counts by treatment arm:

```sql
SELECT
  timing_arm,
  COUNT(DISTINCT ig_user_id) AS matured_assigned_followers
FROM dm_recovery_reminder
WHERE experiment_version_snapshot = 'read-recovery-timing-v2'
  AND timing_arm IN ('two_hour', 'six_hour')
  AND accepted_at < NOW() - INTERVAL '48 hours'
GROUP BY timing_arm
ORDER BY timing_arm;
```

- If both arms have at least 1,700 matured followers, record the current instant
  as the enrollment cutoff. Set `DM_RECOVERY_EXPERIMENT_END_AT` to that exact
  cutoff and redeploy. Never backdate it.
- If either arm is below 1,700, leave the original day-42 maximum unchanged and
  repeat the same blinded count at day 35.
- At day 35, close at the recorded current instant if both arms have reached
  1,700. Otherwise continue without another outcome inspection.
- At day 42, enrollment closes at the already configured maximum regardless of
  sample size. A below-target result is final and inconclusive.

Keep `DM_RECOVERY_POST_EXPERIMENT_ENABLED=false` after cutoff. Requests accepted
at or after the end do not enter v2.

## Final analysis and owner decision

Wait a full 48 hours after the recorded enrollment cutoff. Then select `All` in
the Recovery date controls and verify the dashboard says no followers are still
collecting outcomes for the experiment range.

The API owns maturation, confidence intervals, harm checks, and decision state.
Use its full-range result. Do not recompute a winner in a spreadsheet or from a
filtered dashboard view.

- `two_hour_wins` or `six_hour_wins` is a recommendation for owner review, not
  an automatic configuration change.
- `inconclusive` keeps six hours as the conservative default only after the
  owner approves a separately versioned rollout.
- `safety_review` blocks rollout until every drift, duplicate, or harm signal is
  understood and closed.
- `collecting` or `exploratory` is never a final result.

The owner must review the complete experiment range, operational safety
metrics, interruption history, the first-20 audit, and any incident records.
Rollout requires a separate explicit production change. Do not reuse v2 or set
its post-experiment flag to true.

## Emergency rollback

Set `DM_RECOVERY_ENABLED=false` and redeploy or restart. This stops new public
recovery comments. It does not delete rows, change assignments, release the
no-reminder arm, remove posted comments, or retry uncertain sends.

Ingestion and evidence attribution continue. Pending treatment rows retain
their original two-hour or six-hour eligibility. Before resuming the same
version, record the outage and review late-send exposure. A material or
prolonged interruption should close v2 and use a new experiment version rather
than pretending the interrupted experience was unchanged.

Do not roll back the additive migration and do not edit existing assignment
fields. If the origin enrichment worker must also stop, separately disable
`DM_RECOVERY_ORIGIN_LLM_ENABLED`; the recovery kill switch does not control it.

## Activation sign-off

- [ ] Schema migration applied before v2 configuration.
- [ ] Compatible v1 behavior verified after code deployment.
- [ ] Real-Postgres contract passed with zero skips.
- [ ] Meta signal subscriptions and signed fixtures verified.
- [ ] Circuit closed; credentials, caps, and attention queue reviewed.
- [ ] Owner, commit, start, and exact day-42 maximum recorded without PII.
- [ ] V2 post-experiment flag false.
- [ ] First row in all three arms verified without logging identity.
- [ ] First 20 treatment comments audited against Instagram and evidence.
- [ ] Allocation reviewed after 100 unique followers.
- [ ] Day-28/day-35 checks restricted to matured assignment counts.
- [ ] Enrollment cutoff recorded by day 42.
- [ ] Full 48-hour maturation wait completed.
- [ ] Final analysis uses `All` and the API decision.
- [ ] Owner approved any rollout as a separate production change.
