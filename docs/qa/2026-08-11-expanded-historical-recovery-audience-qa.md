# Expanded historical-recovery audience rollout runbook

**Scope:** The four new historical-recovery cohorts: `other`, `unknown_cue`,
`unknown_generic`, and `unknown_no_name`.

**Hard stop:** Expanded sending is disabled until every audit gate below passes.
Do not approve, start, or resume a campaign before recording the audit results.
The existing `western` population is not part of this rollout and must not be
selected again.

The policy is `eligibility-v4-expanded-audience` with current method `llm_v3`.
Only `south_asian` blocks on audience origin, at both `high` and `low`
confidence. The allowed segments are `western`, `other`, `unknown_cue`,
`unknown_generic`, and `unknown_no_name`; stale, missing, malformed, or
inconsistent provenance defers and never default-allows.

## Variables and safe shell setup

Run production operations from the deployed API release, not from this test
worktree. `PGURL` is only for the read-only `psql` queries below. Do not paste
the bearer token or a database URL into tickets or command logs.

```bash
export API_SERVICE=api
export API_BASE='https://<deployed-api-host>'
export OWNER_TOKEN='<short-lived-owner-bearer-token>'
export PHASE=unknown_read_pilot
export PGURL='<approved-read-only-production-database-url>'
```

## 1. Deploy inert code and schema

The historical scheduler requires both switches. Set both to `false` before the
deploy and migration; origin enrichment may run while sending is disabled.

```bash
railway variable set --service "$API_SERVICE" DM_RECOVERY_ENABLED=false DM_RECOVERY_HISTORICAL_ENABLED=false DM_RECOVERY_ORIGIN_LLM_ENABLED=true
railway up --service "$API_SERVICE" --detach --message 'expanded recovery: inert deploy'
railway deployment list --service "$API_SERVICE" --json
curl --fail --silent --show-error "$API_BASE/health"
railway logs --service "$API_SERVICE" --lines 200 --filter 'migrate|error'
psql "$PGURL" -v ON_ERROR_STOP=1 -c "SELECT migration_name, finished_at FROM \"_prisma_migrations\" WHERE migration_name = '20260811210000_expanded_recovery_audience_segments' AND finished_at IS NOT NULL;"
psql "$PGURL" -v ON_ERROR_STOP=1 -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'historical_audience_segment' ORDER BY enumsortorder;"
```

Expected enum rows: `western`, `other`, `unknown_cue`, `unknown_generic`,
`unknown_no_name`, `south_asian`. A missing migration row, incomplete enum, or
unhealthy deployment is a stop condition.

## 2. Reclassify the targeted pool to `llm_v3`

Keep both sending switches false. Run the deployed origin worker at its normal
cadence until the stale-target query returns `0`. It writes with an identity
compare-and-set and cannot send a historical comment by itself.

```bash
railway variable set --service "$API_SERVICE" DM_RECOVERY_ENABLED=false DM_RECOVERY_HISTORICAL_ENABLED=false DM_RECOVERY_ORIGIN_LLM_ENABLED=true
railway restart --service "$API_SERVICE" --yes
railway logs --service "$API_SERVICE" --lines 200 --filter 'origin_enrichment'
```

Audit all present method/segment/confidence combinations; unexpected rows are
not hidden by the query:

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -c "
  SELECT COALESCE(origin_method, 'missing') AS method,
         COALESCE(audience_segment::text, 'missing') AS segment,
         COALESCE(origin_confidence, 'missing') AS confidence,
         COUNT(*) AS users
  FROM ig_users
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3;"
```

The target population is canonical comment-origin journeys with a historical
source comment. It is the selection base, not a claim that every user is
otherwise eligible.

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -c "
  WITH targeted AS (
    SELECT DISTINCT ji.ig_user_id
    FROM journey_intent ji
    JOIN journey_trigger jt ON jt.intent_id = ji.id
    WHERE jt.trigger_kind = 'comment'
      AND jt.received_at < NOW() - INTERVAL '7 days'
  )
  SELECT COUNT(*) AS stale_or_incomplete_targeted_users
  FROM targeted t JOIN ig_users u ON u.id = t.ig_user_id
  WHERE u.origin_method IS DISTINCT FROM 'llm_v3'
     OR u.audience_segment IS NULL
     OR u.origin_confidence NOT IN ('high', 'low')
     OR (u.audience_segment = 'western' AND u.inferred_origin IS DISTINCT FROM 'us_western')
     OR (u.audience_segment IN ('unknown_cue', 'unknown_generic', 'unknown_no_name') AND u.inferred_origin IS DISTINCT FROM 'unknown')
     OR (u.audience_segment = 'other' AND u.inferred_origin IS DISTINCT FROM 'other')
     OR (u.audience_segment = 'south_asian' AND u.inferred_origin IS DISTINCT FROM 'south_asian');"
psql "$PGURL" -v ON_ERROR_STOP=1 -c "SELECT origin_confidence, COUNT(*) AS south_asian_users FROM ig_users WHERE origin_method = 'llm_v3' AND audience_segment = 'south_asian' GROUP BY origin_confidence ORDER BY origin_confidence;"
psql "$PGURL" -v ON_ERROR_STOP=1 -c "
  SELECT COUNT(*) AS no_name_not_deterministic
  FROM ig_users
  WHERE NULLIF(regexp_replace(COALESCE(username, ''), '^-+$', ''), '') IS NULL
    AND NULLIF(regexp_replace(COALESCE(name, ''), '^-+$', ''), '') IS NULL
    AND (origin_method IS DISTINCT FROM 'llm_v3' OR audience_segment IS DISTINCT FROM 'unknown_no_name' OR inferred_origin IS DISTINCT FROM 'unknown' OR origin_confidence IS DISTINCT FROM 'low');"
```

Expected: `stale_or_incomplete_targeted_users=0` and
`no_name_not_deterministic=0`. The South-Asian query must display both `high`
and `low` rows when present; neither confidence is eligible.

## 3. Select four inert drafts

Run selection only after the stale-target result is zero. This creates at most
four draft manifests in one atomic rollout group. It never approves, starts, or
sends a campaign; it sets holdout `0`, group hourly cap `10`, and daily cap
`1000`.

```bash
DM_RECOVERY_ENABLED=false DM_RECOVERY_HISTORICAL_ENABLED=false DM_RECOVERY_WESTERN_ONLY=true npm run recovery:select-expanded -- --phase "$PHASE"
export ROLLOUT_GROUP_ID='<printed-rollout-group-uuid>'
```

Record the rollout-group UUID, campaign IDs, decision hashes, per-segment counts,
exclusions, and `one person across rollout: OK`. Empty segments produce no
campaign and require no approval.

## 4. Audit drafts — every query must pass

### Manifest, cap, and provenance counts

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT id, state, audience_segment, candidate_count, excluded_count, holdout_percent, batch_size, hourly_cap, daily_cap, rollout_group_hourly_cap, selection_fingerprint, decision_hash
  FROM recovery_campaign WHERE rollout_group_id = :'group_id'::uuid ORDER BY audience_segment;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT COUNT(*) FILTER (WHERE audience_segment IN ('other','unknown_cue','unknown_generic','unknown_no_name')) AS expanded_campaigns,
         COUNT(*) FILTER (WHERE holdout_percent <> 0) AS nonzero_holdouts,
         COUNT(*) FILTER (WHERE batch_size <> 1) AS bad_batch_size,
         COUNT(*) FILTER (WHERE daily_cap <> 1000) AS bad_daily_cap,
         COUNT(*) FILTER (WHERE rollout_group_hourly_cap <> 10) AS bad_group_hourly_cap,
         COUNT(*) FILTER (WHERE state <> 'draft') AS non_drafts,
         COUNT(*) FILTER (WHERE selection_fingerprint IS NULL OR decision_hash IS NULL) AS unhashed
  FROM recovery_campaign WHERE rollout_group_id = :'group_id'::uuid;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT c.audience_origin_method AS method, c.audience_segment::text AS segment, c.audience_origin_confidence AS confidence, COUNT(*) AS candidates
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;"
```

Expected: `nonzero_holdouts=0`, `bad_batch_size=0`, `bad_daily_cap=0`,
`bad_group_hourly_cap=0`, `non_drafts=0`, and `unhashed=0`. The number of
expanded campaigns equals the number of non-empty segments (0–4).

### Exact membership, South-Asian exclusion, stale target zero, and duplicates

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT COUNT(*) AS bad_candidate_provenance
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
    AND (c.audience_origin_method IS DISTINCT FROM 'llm_v3'
      OR c.audience_origin_confidence NOT IN ('high','low')
      OR c.audience_segment IS DISTINCT FROM rc.audience_segment
      OR c.audience_segment NOT IN ('other','unknown_cue','unknown_generic','unknown_no_name'));"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT c.audience_origin_confidence AS confidence, COUNT(*) AS selected_south_asian
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid AND c.audience_segment = 'south_asian'
  GROUP BY 1 ORDER BY 1;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT reason, COUNT(DISTINCT ig_user_id) AS excluded_people
  FROM recovery_selection_exclusion e JOIN recovery_campaign rc ON rc.id = e.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid AND reason = 'audience_south_asian'
  GROUP BY reason;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT ig_user_id, COUNT(*) AS campaigns
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
  GROUP BY ig_user_id HAVING COUNT(*) > 1;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT COUNT(*) AS stale_targeted_candidates
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id JOIN ig_users u ON u.id = c.ig_user_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
    AND (u.origin_method IS DISTINCT FROM 'llm_v3' OR u.audience_segment IS NULL OR u.origin_confidence NOT IN ('high','low'));"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT COUNT(*) FILTER (WHERE d.state IN ('reserved','dispatch_started','sent','uncertain')) AS counted_capacity_rows
  FROM public_recovery_dispatch d JOIN recovery_campaign rc ON rc.id = d.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid AND d.reserved_at > NOW() - INTERVAL '1 hour';"
```

Expected: `bad_candidate_provenance=0`; selected-South-Asian returns zero rows
(therefore zero at both confidences); the exclusion query records the distinct
blocked-person count; the duplicate query returns zero rows;
`stale_targeted_candidates=0`; and `counted_capacity_rows <= 10` (zero before
start). Capacity includes `reserved`, `dispatch_started`, `sent`, and
`uncertain`, never `released`.

Do not approve if any expected-zero query is nonzero, a hash is absent, a draft
is missing, or the method/segment/confidence breakdown is unexpected.

## 5. Approve and start only after audit approval

The owner must explicitly record audit approval before these commands. First
read the owner campaign list; its `sendingEnabled` field must still be `false`.

```bash
curl --fail --silent --show-error -H "Authorization: Bearer $OWNER_TOKEN" "$API_BASE/api/historical-recovery/campaigns"
```

Approve each non-empty campaign **paused**, which seals the reviewed manifest
without allowing a worker claim during the multi-campaign transition. Use the
deployed owner API, never SQL:

```bash
for CAMPAIGN_ID in <campaign-id-1> <campaign-id-2> <campaign-id-3> <campaign-id-4>; do
  curl --fail --silent --show-error -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
    -d '{"approvedBy":"<owner-email>","startPaused":true}' \
    "$API_BASE/api/historical-recovery/campaigns/$CAMPAIGN_ID/approve"
done
```

Re-run every Section 4 query after approval. Approval freezes the manifest; do
not re-select it. Then enable the scheduler and resume all approved paused
campaigns without an observation pause:

```bash
railway variable set --service "$API_SERVICE" DM_RECOVERY_ENABLED=true DM_RECOVERY_HISTORICAL_ENABLED=true
railway restart --service "$API_SERVICE" --yes
for CAMPAIGN_ID in <campaign-id-1> <campaign-id-2> <campaign-id-3> <campaign-id-4>; do
  curl --fail --silent --show-error -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
    -d '{}' "$API_BASE/api/historical-recovery/campaigns/$CAMPAIGN_ID/resume"
done
```

There is no holdout, 20-person stage, or delay between cohorts. Limits remain
batch size `1`, aggregate `10` dispatch starts per rolling hour, and daily cap
`1000` per campaign.

## 6. Verify first sends and ongoing health

Read the owner campaign view after the first eligible ticks. Record each
non-empty campaign's state, progress, `rolloutGroupSentLastHour`, and the global
`sendingEnabled` value.

```bash
curl --fail --silent --show-error -H "Authorization: Bearer $OWNER_TOKEN" "$API_BASE/api/historical-recovery/campaigns"
curl --fail --silent --show-error -H "Authorization: Bearer $OWNER_TOKEN" "$API_BASE/api/historical-recovery/candidates?campaignId=<campaign-id>&view=sent&limit=1"
```

For each non-empty campaign, use the first `sent` candidate's `publicReplyId`,
source `commentId`, `mediaId`, and frozen `publicReplyText`. Read the reply back
directly from Meta before declaring the send successful. The messaging/comment
client is pinned to Graph `v21.0`:

```bash
curl --fail --silent --show-error "https://graph.instagram.com/v21.0/<publicReplyId>?fields=id,text,timestamp,parent_id&access_token=<approved-access-token>"
```

The returned `id` must equal `publicReplyId`, `parent_id` must equal the source
comment, and text must equal `publicReplyText`. Record a sanitized first-comment
link/ID and timestamp for every non-empty campaign; never retain access tokens.

At first send and at least hourly, run these health checks:

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT rc.audience_segment, c.outcome, COUNT(*) AS candidates
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
  GROUP BY 1, 2 ORDER BY 1, 2;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT rc.id, rc.audience_segment, rc.state, rc.pause_reason,
         COUNT(d.id) FILTER (WHERE d.state IN ('reserved','dispatch_started','sent','uncertain')) AS rolling_hour_capacity
  FROM recovery_campaign rc LEFT JOIN public_recovery_dispatch d
    ON d.campaign_id = rc.id AND d.reserved_at > NOW() - INTERVAL '1 hour'
  WHERE rc.rollout_group_id = :'group_id'::uuid
  GROUP BY rc.id, rc.audience_segment, rc.state, rc.pause_reason
  ORDER BY rc.audience_segment;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT rc.audience_segment, h.kind, h.observed_at, h.source_key, h.safe_detail
  FROM recovery_campaign_health_observation h JOIN recovery_campaign rc ON rc.id = h.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
  ORDER BY h.observed_at DESC;"
psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
  SELECT d.ig_user_id, COUNT(*) AS dispatches
  FROM public_recovery_dispatch d JOIN recovery_campaign rc ON rc.id = d.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid AND d.state IN ('reserved','dispatch_started','sent','uncertain')
  GROUP BY d.ig_user_id HAVING COUNT(*) > 1;"
```

Healthy means combined capacity `<= 10`; no duplicate dispatch rows; no
unexpected `send_failed` or `send_uncertain` accumulation; no complaint,
`opt_out`, `block`, `negative_reply`, or `classifier_anomaly`; no auto-pause;
and no shared circuit open. Any one group health signal can pause all four
campaigns, so inspect every member after an incident.

## 7. Emergency pause and rollback

For any complaint, opt-out, block, negative reply, classifier anomaly, duplicate
reply, uncertainty, source/provider failure, unexpected count, or operator
doubt, pause the entire expanded group immediately. This atomic owner action
affects no unrelated historical or prospective campaign:

```bash
curl --fail --silent --show-error -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"emergency: <concise-safe-reason>"}' \
  "$API_BASE/api/historical-recovery/rollout-groups/$ROLLOUT_GROUP_ID/pause"
curl --fail --silent --show-error -H "Authorization: Bearer $OWNER_TOKEN" "$API_BASE/api/historical-recovery/campaigns"
```

The response must list `pausedCampaignIds` and any terminal `skipped` members.
For a broader rollback, disable the scheduler flags and restart. This stops new
historical sends while preserving immutable manifests, audit evidence, and
already-posted comments. Do **not** reverse the additive migration.

```bash
railway variable set --service "$API_SERVICE" DM_RECOVERY_HISTORICAL_ENABLED=false DM_RECOVERY_ENABLED=false
railway restart --service "$API_SERVICE" --yes
```

Do not resume an automatically paused campaign until the owner has reviewed the
health evidence. The API requires an acknowledgement for an `auto:` pause:

```bash
curl --fail --silent --show-error -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"acknowledgeAutoPause":"<owner-email>: reviewed <incident-id>"}' \
  "$API_BASE/api/historical-recovery/campaigns/<campaign-id>/resume"
```

For a permanent single-campaign stop, call `POST
/api/historical-recovery/campaigns/<campaign-id>/cancel` with a non-empty
`reason`; do not update campaign tables directly. Cancellation abandons pending
rows but never pretends an already-posted Meta comment was removed.
