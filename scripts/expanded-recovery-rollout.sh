#!/usr/bin/env bash
#
# Operator-only expanded historical-recovery rollout. This script never sources
# .env: selection runs in an explicitly selected Railway deployment instance and
# every database read is host/name guarded before psql is invoked.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly STATE_FILE="${EXPANDED_RECOVERY_STATE_FILE:-$REPO_DIR/.expanded-recovery-rollout.state}"
readonly SEGMENTS=(other unknown_cue unknown_generic unknown_no_name)
readonly UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
need() { [[ -n "${!1:-}" ]] || die "$1 is required"; }
is_uuid() { [[ "$1" =~ $UUID_RE ]]; }

load_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      DEPLOYMENT_ID|ROLLOUT_GROUP_ID|CAMPAIGN_IDS_CSV|EXPECTED_NONEMPTY_CAMPAIGN_COUNT)
        [[ "$value" =~ ^[0-9A-Za-z,-]+$ ]] || die "unsafe value in rollout state for $key"
        printf -v "$key" '%s' "$value"
        export "$key"
        ;;
      '') ;;
      *) die "unexpected key in rollout state: $key" ;;
    esac
  done < "$STATE_FILE"
}

write_state() {
  local temporary
  temporary="$(mktemp "${STATE_FILE}.XXXXXX")"
  chmod 600 "$temporary"
  {
    [[ -n "${DEPLOYMENT_ID:-}" ]] && printf 'DEPLOYMENT_ID=%s\n' "$DEPLOYMENT_ID"
    [[ -n "${ROLLOUT_GROUP_ID:-}" ]] && printf 'ROLLOUT_GROUP_ID=%s\n' "$ROLLOUT_GROUP_ID"
    [[ -n "${CAMPAIGN_IDS_CSV:-}" ]] && printf 'CAMPAIGN_IDS_CSV=%s\n' "$CAMPAIGN_IDS_CSV"
    [[ -n "${EXPECTED_NONEMPTY_CAMPAIGN_COUNT:-}" ]] && printf 'EXPECTED_NONEMPTY_CAMPAIGN_COUNT=%s\n' "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT"
  } > "$temporary"
  mv "$temporary" "$STATE_FILE"
}

require_tools() {
  local command
  for command in railway jq curl node psql shasum; do
    command -v "$command" >/dev/null || die "missing required command: $command"
  done
}

require_common() {
  require_tools
  need API_SERVICE
  need RAILWAY_ENVIRONMENT
  need EXPECTED_RAILWAY_ENVIRONMENT
  need API_BASE
  need EXPECTED_API_HOST
  [[ "$RAILWAY_ENVIRONMENT" == "$EXPECTED_RAILWAY_ENVIRONMENT" ]] \
    || die "RAILWAY_ENVIRONMENT must equal EXPECTED_RAILWAY_ENVIRONMENT"
  node -e '
    const [base, expected] = process.argv.slice(1);
    const url = new URL(base);
    if (url.protocol !== "https:" || url.hostname !== expected) process.exit(1);
  ' "$API_BASE" "$EXPECTED_API_HOST" \
    || die "API_BASE must be HTTPS and match EXPECTED_API_HOST"
}

railway_scope() {
  printf '%s\0' --service "$API_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
}

railway_args=()
load_railway_args() {
  railway_args=(--service "$API_SERVICE" --environment "$RAILWAY_ENVIRONMENT")
}

require_owner() {
  need OWNER_EMAIL
  need OWNER_TOKEN
  [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "OWNER_EMAIL must be nonblank email-shaped text"
}

require_database_guard() {
  need PGURL
  need EXPECTED_DATABASE_HOST
  need EXPECTED_DATABASE_NAME
  node -e '
    const [raw, host, database] = process.argv.slice(1);
    const url = new URL(raw);
    const actualDatabase = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (!/^postgres(?:ql)?:$/.test(url.protocol) || localHosts.has(url.hostname)
      || url.hostname !== host || actualDatabase !== database) process.exit(1);
  ' "$PGURL" "$EXPECTED_DATABASE_HOST" "$EXPECTED_DATABASE_NAME" \
    || die "PGURL must be a non-loopback PostgreSQL URL for the expected host and database"
}

require_group() {
  need ROLLOUT_GROUP_ID
  is_uuid "$ROLLOUT_GROUP_ID" || die "ROLLOUT_GROUP_ID must be a UUID"
}

require_expected_campaign_count() {
  need EXPECTED_NONEMPTY_CAMPAIGN_COUNT
  [[ "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT" =~ ^[1-4]$ ]] \
    || die "EXPECTED_NONEMPTY_CAMPAIGN_COUNT must be 1 through 4"
}

api_get() {
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $OWNER_TOKEN" \
    "$API_BASE$1"
}

api_post() {
  local path="$1" body="$2"
  curl --fail --silent --show-error -X POST \
    -H "Authorization: Bearer $OWNER_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "$API_BASE$path"
}

assert_circuit_closed() {
  local metrics
  metrics="$(api_get '/api/recovery-reminders/metrics')"
  jq -e '.health.circuitOpen == false' >/dev/null <<<"$metrics" \
    || die 'shared recovery circuit is open; do not start or continue the rollout'
}

deployment_record() {
  local deployment_id="$1" deployments
  deployments="$(railway deployment list "${railway_args[@]}" --limit 100 --json)"
  jq -ce --arg id "$deployment_id" '
    (if type == "array" then . else .deployments // [] end)
    | map(select((.id // .deploymentId) == $id))
    | if length == 1 then .[0] else error("exact deployment not found uniquely") end
  ' <<<"$deployments"
}

deployment_id_from_up_json() {
  jq -er '
    if type != "object" then error("railway up JSON must be an object")
    elif (.id | type) == "string" then .id
    elif (.deploymentId | type) == "string" then .deploymentId
    elif (.deployment.id | type) == "string" then .deployment.id
    else error("railway up JSON has no unambiguous deployment id")
    end
  '
}

inspect_exact_deployment() {
  local deployment_id="$1"
  deployment_record "$deployment_id" | jq . >&2
  railway logs "$deployment_id" "${railway_args[@]}" --deployment --lines 200
}

wait_for_success() {
  local deployment_id="$1" attempt=1 record status
  while (( attempt <= 60 )); do
    record="$(deployment_record "$deployment_id")" || {
      note 'Could not retrieve the exact deployment record; refusing to infer latest success.'
      inspect_exact_deployment "$deployment_id" || true
      exit 1
    }
    status="$(jq -er '.status' <<<"$record")" || die 'exact deployment record has no status'
    case "$status" in
      SUCCESS)
        note "Exact deployment $deployment_id reached SUCCESS."
        inspect_exact_deployment "$deployment_id"
        return
        ;;
      QUEUED|BUILDING|DEPLOYING|INITIALIZING|PENDING|IN_PROGRESS)
        note "Exact deployment $deployment_id is $status (attempt $attempt/60)."
        sleep 10
        ;;
      *)
        note "Exact deployment $deployment_id ended in unexpected/non-success status: $status"
        inspect_exact_deployment "$deployment_id" || true
        exit 1
        ;;
    esac
    ((attempt += 1))
  done
  note "Timed out waiting for exact deployment $deployment_id to reach SUCCESS."
  inspect_exact_deployment "$deployment_id" || true
  exit 1
}

deploy_inert() {
  require_common
  load_railway_args
  local up_json
  railway variable set --skip-deploys "${railway_args[@]}" \
    DM_RECOVERY_ENABLED=false \
    DM_RECOVERY_HISTORICAL_ENABLED=false \
    DM_RECOVERY_ORIGIN_LLM_ENABLED=true
  up_json="$(railway up --detach --json "${railway_args[@]}" --message 'expanded recovery: inert deploy')"
  DEPLOYMENT_ID="$(deployment_id_from_up_json <<<"$up_json")" \
    || die 'unable to capture exact deployment ID from railway up JSON'
  is_uuid "$DEPLOYMENT_ID" || die 'captured deployment ID is not a UUID'
  wait_for_success "$DEPLOYMENT_ID"
  write_state
  printf 'Captured exact deployment ID: %s\n' "$DEPLOYMENT_ID"
}

require_remote_release() {
  require_common
  load_railway_args
  need DEPLOYMENT_ID
  need DEPLOYMENT_INSTANCE_ID
  need REMOTE_RELEASE_DIR
  need EXPECTED_DATABASE_HOST
  need EXPECTED_DATABASE_NAME
  is_uuid "$DEPLOYMENT_ID" || die 'DEPLOYMENT_ID must be a UUID captured by deploy-inert'
  is_uuid "$DEPLOYMENT_INSTANCE_ID" || die 'DEPLOYMENT_INSTANCE_ID must be the UUID from that exact deployment record'
  [[ "$REMOTE_RELEASE_DIR" == /* ]] || die 'REMOTE_RELEASE_DIR must be an absolute path in the deployed service'
  deployment_record "$DEPLOYMENT_ID" | jq -e '.status == "SUCCESS"' >/dev/null \
    || die 'captured deployment is not SUCCESS; do not target an SSH instance'
  EXPECTED_SELECTOR_SHA256="$(shasum -a 256 "$REPO_DIR/scripts/select-expanded-historical-recovery.ts" | awk '{print $1}')"
}

remote_preflight() {
  local node_check remote
  node_check='const [host, database] = process.argv.slice(1); const u = new URL(process.env.DATABASE_URL || ""); const actual = decodeURIComponent(u.pathname.replace(/^\//, "")); const local = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]); if (!/^postgres(?:ql)?:$/.test(u.protocol) || local.has(u.hostname) || u.hostname !== host || actual !== database) process.exit(1);'
  printf -v remote 'set -euo pipefail; cd %q; test -f package.json; test -f scripts/select-expanded-historical-recovery.ts; actual=$(shasum -a 256 scripts/select-expanded-historical-recovery.ts | awk "{print \$1}"); [ "$actual" = %q ] || { echo "deployed selector hash mismatch" >&2; exit 1; }; node -e %q %q %q' \
    "$REMOTE_RELEASE_DIR" "$EXPECTED_SELECTOR_SHA256" "$node_check" "$EXPECTED_DATABASE_HOST" "$EXPECTED_DATABASE_NAME"
  railway ssh "${railway_args[@]}" --deployment-instance "$DEPLOYMENT_INSTANCE_ID" -- bash -lc "$remote"
}

select_drafts() {
  require_remote_release
  need PHASE
  [[ "$PHASE" == confirmed_failure || "$PHASE" == unknown_read_pilot ]] \
    || die 'PHASE must be confirmed_failure or unknown_read_pilot'
  local remote selection_output campaign_count
  remote_preflight
  printf -v remote 'set -euo pipefail; cd %q; DM_RECOVERY_ENABLED=false DM_RECOVERY_HISTORICAL_ENABLED=false npm run recovery:select-expanded -- --phase %q' \
    "$REMOTE_RELEASE_DIR" "$PHASE"
  selection_output="$(railway ssh "${railway_args[@]}" --deployment-instance "$DEPLOYMENT_INSTANCE_ID" -- bash -lc "$remote")"
  printf '%s\n' "$selection_output"
  ROLLOUT_GROUP_ID="$(awk -F: '/rollout group/{gsub(/[[:space:]]/, "", $2); print $2; exit}' <<<"$selection_output")"
  is_uuid "$ROLLOUT_GROUP_ID" || die 'selector did not emit a valid rollout group UUID'
  CAMPAIGN_IDS=()
  local selected_campaign_id
  while IFS= read -r selected_campaign_id; do
    [[ -n "$selected_campaign_id" ]] && CAMPAIGN_IDS+=("$selected_campaign_id")
  done < <(awk -F: '/campaign id/{gsub(/[[:space:]]/, "", $2); if ($2 !~ /^none/) print $2}' <<<"$selection_output")
  campaign_count="${#CAMPAIGN_IDS[@]}"
  (( campaign_count >= 1 && campaign_count <= 4 )) || die 'selection must produce 1 through 4 non-empty campaigns'
  printf '%s\n' "${CAMPAIGN_IDS[@]}" | while IFS= read -r campaign_id; do is_uuid "$campaign_id" || die 'selector emitted a non-UUID campaign ID'; done
  [[ "$(printf '%s\n' "${CAMPAIGN_IDS[@]}" | sort -u | wc -l | tr -d ' ')" == "$campaign_count" ]] \
    || die 'selector emitted duplicate campaign IDs'
  CAMPAIGN_IDS_CSV="$(IFS=,; printf '%s' "${CAMPAIGN_IDS[*]}")"
  EXPECTED_NONEMPTY_CAMPAIGN_COUNT="$campaign_count"
  write_state
  printf 'Captured rollout group: %s; non-empty campaigns: %s\n' "$ROLLOUT_GROUP_ID" "$campaign_count"
}

normalize_identity_cte() {
  cat <<'SQL'
WITH targeted AS (
  SELECT DISTINCT ji.ig_user_id
  FROM journey_intent ji
  JOIN journey_trigger jt ON jt.intent_id = ji.id
  WHERE jt.trigger_kind = 'comment'
    AND jt.received_at < NOW() - INTERVAL '7 days'
), identity_normalized AS (
  SELECT u.*, regexp_replace(COALESCE(u.username, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS username_trimmed,
         regexp_replace(COALESCE(u.name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS name_trimmed
  FROM targeted t JOIN ig_users u ON u.id = t.ig_user_id
), normalized AS (
  SELECT *, regexp_replace(username_trimmed, '^-+$', '') AS username_clean,
         regexp_replace(name_trimmed, '^-+$', '') AS name_clean
  FROM identity_normalized
)
SQL
}

scalar() {
  local label="$1" sql="$2" value
  value="$(psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="${ROLLOUT_GROUP_ID:-}" -Atqc "$sql")"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label did not return one integer: $value"
  printf '%s=%s\n' "$label" "$value"
  [[ "$value" == 0 ]] || die "$label must be zero"
}

audit_live_classification() {
  require_database_guard
  local cte
  cte="$(normalize_identity_cte)"
  scalar stale_or_structurally_invalid_targeted_users "$cte
SELECT COUNT(*)
FROM normalized u
WHERE u.origin_method IS DISTINCT FROM 'llm_v3'
   OR (u.origin_confidence IS DISTINCT FROM 'high' AND u.origin_confidence IS DISTINCT FROM 'low')
   OR (u.audience_segment = 'western' AND u.inferred_origin IS DISTINCT FROM 'us_western')
   OR (u.audience_segment = 'other' AND u.inferred_origin IS DISTINCT FROM 'other')
   OR (u.audience_segment IN ('unknown_cue', 'unknown_generic', 'unknown_no_name') AND u.inferred_origin IS DISTINCT FROM 'unknown')
   OR (u.audience_segment = 'south_asian' AND u.inferred_origin IS DISTINCT FROM 'south_asian')
   OR (u.audience_segment IS NULL OR u.audience_segment NOT IN ('western', 'other', 'unknown_cue', 'unknown_generic', 'unknown_no_name', 'south_asian'))
   OR ((u.username_clean = '' AND u.name_clean = '')
       AND (u.audience_segment IS DISTINCT FROM 'unknown_no_name'
         OR u.inferred_origin IS DISTINCT FROM 'unknown'
         OR u.origin_confidence IS DISTINCT FROM 'low'))
   OR ((u.username_clean <> '' OR u.name_clean <> '') AND u.audience_segment = 'unknown_no_name');"
  psql "$PGURL" -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(origin_method, 'missing') AS method,
       COALESCE(audience_segment::text, 'missing') AS segment,
       COALESCE(origin_confidence, 'missing') AS confidence,
       COUNT(*) AS users
FROM ig_users GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;"
  psql "$PGURL" -v ON_ERROR_STOP=1 -c "
SELECT origin_confidence, COUNT(*) AS south_asian_users
FROM ig_users
WHERE origin_method = 'llm_v3' AND audience_segment = 'south_asian'
GROUP BY origin_confidence ORDER BY origin_confidence;"
}

wait_for_live_audit() {
  local attempt
  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    if bash "$SCRIPT_DIR/expanded-recovery-rollout.sh" audit-live; then
      note "Live classification audit passed on attempt $attempt/60."
      return 0
    fi
    note "Live classification audit is not yet zero (attempt $attempt/60); retrying in 120 seconds."
    sleep 120
  done
  die 'live classification audit did not reach zero within 120 minutes; expanded sending remains disabled'
}

audit_drafts() {
  require_database_guard
  require_group
  require_expected_campaign_count
  local expected_state="${1:-draft}"
  [[ "$expected_state" == draft || "$expected_state" == paused || "$expected_state" == running ]] \
    || die 'audit state must be draft, paused, or running'
  scalar bad_manifest_shape "
SELECT COUNT(*)
FROM recovery_campaign rc
WHERE rc.rollout_group_id = :'group_id'::uuid
  AND (rc.audience_segment IS NULL OR rc.audience_segment NOT IN ('other','unknown_cue','unknown_generic','unknown_no_name')
    OR rc.holdout_percent <> 0 OR rc.batch_size <> 1 OR rc.hourly_cap > 10
    OR rc.daily_cap <> 1000 OR rc.rollout_group_hourly_cap <> 10
    OR rc.state <> '$expected_state' OR rc.selection_fingerprint IS NULL OR rc.decision_hash IS NULL);"
  local actual_campaign_count
  actual_campaign_count="$(psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -Atqc "SELECT COUNT(*) FROM recovery_campaign WHERE rollout_group_id = :'group_id'::uuid;")"
  [[ "$actual_campaign_count" == "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT" ]] \
    || die "campaign count $actual_campaign_count does not equal expected $EXPECTED_NONEMPTY_CAMPAIGN_COUNT"
  scalar duplicate_people_across_rollout "
SELECT COUNT(*) FROM (
  SELECT c.ig_user_id
  FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
  WHERE rc.rollout_group_id = :'group_id'::uuid
  GROUP BY c.ig_user_id HAVING COUNT(*) > 1
) duplicates;"
  scalar selected_south_asian "
SELECT COUNT(*)
FROM recovery_candidate c JOIN recovery_campaign rc ON rc.id = c.campaign_id
WHERE rc.rollout_group_id = :'group_id'::uuid AND c.audience_segment = 'south_asian';"
  scalar stale_or_inconsistent_candidate_live_campaign "
SELECT COUNT(*)
FROM recovery_candidate c
JOIN recovery_campaign rc ON rc.id = c.campaign_id
JOIN ig_users u ON u.id = c.ig_user_id
WHERE rc.rollout_group_id = :'group_id'::uuid
  AND (c.audience_origin_method IS DISTINCT FROM 'llm_v3'
    OR (c.audience_origin_confidence IS DISTINCT FROM 'high' AND c.audience_origin_confidence IS DISTINCT FROM 'low')
    OR c.audience_segment IS NULL OR c.audience_segment NOT IN ('other','unknown_cue','unknown_generic','unknown_no_name')
    OR c.audience_segment IS DISTINCT FROM rc.audience_segment
    OR c.audience_segment IS DISTINCT FROM u.audience_segment
    OR c.audience_origin_method IS DISTINCT FROM u.origin_method
    OR c.audience_origin_confidence IS DISTINCT FROM u.origin_confidence
    OR c.audience_origin IS DISTINCT FROM u.inferred_origin
    OR (c.audience_segment = 'western' AND c.audience_origin IS DISTINCT FROM 'us_western')
    OR (c.audience_segment = 'other' AND c.audience_origin IS DISTINCT FROM 'other')
    OR (c.audience_segment IN ('unknown_cue','unknown_generic','unknown_no_name') AND c.audience_origin IS DISTINCT FROM 'unknown')
    OR (c.audience_segment = 'south_asian' AND c.audience_origin IS DISTINCT FROM 'south_asian')) ;"
  scalar group_capacity_over_ten "
SELECT CASE WHEN COUNT(*) FILTER (WHERE d.state IN ('reserved','dispatch_started','sent','uncertain')) <= 10 THEN 0 ELSE 1 END
FROM public_recovery_dispatch d JOIN recovery_campaign rc ON rc.id = d.campaign_id
WHERE rc.rollout_group_id = :'group_id'::uuid AND d.reserved_at > NOW() - INTERVAL '1 hour';"
  psql "$PGURL" -v ON_ERROR_STOP=1 -v group_id="$ROLLOUT_GROUP_ID" -c "
SELECT reason, COUNT(DISTINCT ig_user_id) AS excluded_people
FROM recovery_selection_exclusion e JOIN recovery_campaign rc ON rc.id = e.campaign_id
WHERE rc.rollout_group_id = :'group_id'::uuid AND reason = 'audience_south_asian'
GROUP BY reason;"
}

load_campaign_ids() {
  need CAMPAIGN_IDS_CSV
  require_expected_campaign_count
  IFS=, read -r -a CAMPAIGN_IDS <<<"$CAMPAIGN_IDS_CSV"
  [[ "${#CAMPAIGN_IDS[@]}" == "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT" ]] \
    || die 'CAMPAIGN_IDS_CSV count does not match EXPECTED_NONEMPTY_CAMPAIGN_COUNT'
  local campaign_id
  for campaign_id in "${CAMPAIGN_IDS[@]}"; do is_uuid "$campaign_id" || die 'CAMPAIGN_IDS_CSV contains a non-UUID'; done
  [[ "$(printf '%s\n' "${CAMPAIGN_IDS[@]}" | sort -u | wc -l | tr -d ' ')" == "${#CAMPAIGN_IDS[@]}" ]] \
    || die 'CAMPAIGN_IDS_CSV contains duplicates'
}

pause_group_or_warn() {
  if [[ -n "${ROLLOUT_GROUP_ID:-}" && -n "${OWNER_TOKEN:-}" ]]; then
    api_post "/api/historical-recovery/rollout-groups/$ROLLOUT_GROUP_ID/pause" \
      '{"reason":"emergency: rollback after partial approval/start failure"}' || note 'Emergency pause failed; escalate immediately.'
  fi
}

approve_and_start() {
  require_common
  require_owner
  require_group
  load_campaign_ids
  load_railway_args
  assert_circuit_closed
  local campaign_id response
  trap 'pause_group_or_warn' ERR
  for campaign_id in "${CAMPAIGN_IDS[@]}"; do
    response="$(api_post "/api/historical-recovery/campaigns/$campaign_id/approve" "{\"approvedBy\":\"$OWNER_EMAIL\",\"startPaused\":true}")"
    jq -e '.ok == true and .state == "paused"' >/dev/null <<<"$response" \
      || die "approval did not leave campaign $campaign_id paused"
  done
  audit_drafts paused
  railway variable set --skip-deploys "${railway_args[@]}" \
    DM_RECOVERY_ENABLED=true DM_RECOVERY_HISTORICAL_ENABLED=true
  note 'Railway 4.65 restart cannot target a deployment ID. Refusing to restart unless the captured inert deployment is still the latest exact record.'
  need DEPLOYMENT_ID
  [[ "$(railway deployment list "${railway_args[@]}" --limit 1 --json | jq -er 'if type == "array" then .[0].id else .deployments[0].id end')" == "$DEPLOYMENT_ID" ]] \
    || die 'another deployment is newer; do not restart an ambiguous service'
  railway restart "${railway_args[@]}" --yes
  assert_circuit_closed
  for campaign_id in "${CAMPAIGN_IDS[@]}"; do
    response="$(api_post "/api/historical-recovery/campaigns/$campaign_id/resume" '{}')"
    jq -e '.ok == true and .state == "running"' >/dev/null <<<"$response" \
      || die "resume did not start campaign $campaign_id"
  done
  trap - ERR
}

verify_first_sends() {
  require_common
  require_owner
  require_group
  load_campaign_ids
  need META_ACCESS_TOKEN
  assert_circuit_closed
  local campaign_id candidate_json reply_id source_id reply_text meta_json
  for campaign_id in "${CAMPAIGN_IDS[@]}"; do
    candidate_json="$(api_get "/api/historical-recovery/candidates?campaignId=$campaign_id&view=sent&limit=1")"
    reply_id="$(jq -er '.candidates | if length == 1 then .[0].publicReplyId else error("expected exactly one first sent candidate") end' <<<"$candidate_json")"
    source_id="$(jq -er '.candidates[0].approvedSources[0].commentId' <<<"$candidate_json")"
    reply_text="$(jq -er '.candidates[0].publicReplyText' <<<"$candidate_json")"
    meta_json="$(curl --fail --silent --show-error \
      -H "Authorization: Bearer $META_ACCESS_TOKEN" \
      "https://graph.instagram.com/v21.0/$reply_id?fields=id,text,timestamp,parent_id")"
    jq -e --arg id "$reply_id" --arg parent "$source_id" --arg text "$reply_text" \
      '.id == $id and .parent_id == $parent and .text == $text' >/dev/null <<<"$meta_json" \
      || die "Meta readback mismatch for campaign $campaign_id"
  done
  audit_drafts running
  assert_circuit_closed
}

emergency_pause() {
  require_common
  require_owner
  require_group
  need EMERGENCY_REASON
  [[ -n "${EMERGENCY_REASON//[[:space:]]/}" ]] || die 'EMERGENCY_REASON must be nonblank'
  api_post "/api/historical-recovery/rollout-groups/$ROLLOUT_GROUP_ID/pause" \
    "$(jq -nc --arg reason "emergency: $EMERGENCY_REASON" '{reason: $reason}')" | jq .
}

usage() {
  cat <<'USAGE'
Usage: scripts/expanded-recovery-rollout.sh <command>

Commands:
  deploy-inert       Stage both recovery flags false without deployment, deploy, capture and poll exact ID.
  audit-live         Run the zero-gate llm_v3 classification audit through guarded read-only PGURL.
  wait-live          Poll the guarded live audit for up to 120 minutes; it never enables sending.
  select             SSH into the exact deployment instance, verify release hash/database, and create draft manifests.
  audit-drafts       Run guarded campaign/candidate/cap/duplicate audits for ROLLOUT_GROUP_ID.
  approve-start      Approve paused, re-audit, start with rollback-on-partial-failure, then resume all campaigns.
  verify             Verify first Meta replies with bearer auth, health, cap, duplicate, and shared circuit gates.
  pause              Atomically pause a rollout group with EMERGENCY_REASON.
USAGE
}

load_state

case "${1:-}" in
  deploy-inert) deploy_inert ;;
  audit-live) audit_live_classification ;;
  wait-live) wait_for_live_audit ;;
  select) select_drafts ;;
  audit-drafts) audit_drafts ;;
  approve-start) approve_and_start ;;
  verify) verify_first_sends ;;
  pause) emergency_pause ;;
  *) usage; exit 2 ;;
esac
