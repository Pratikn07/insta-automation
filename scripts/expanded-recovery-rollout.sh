#!/usr/bin/env bash
# Fail-closed operator wrapper. Secrets stay in the environment, never state or argv.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_file="${EXPANDED_RECOVERY_STATE_FILE:-$root/.expanded-recovery-rollout.state.json}"
uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
cleanup_armed=0
cleanup_running=0

note() { printf '%s\n' "$*" >&2; }
die() { note "ERROR: $*"; exit 1; }
need() { [[ -n "${!1:-}" ]] || die "$1 is required"; }
uuid() { [[ "$1" =~ $uuid_re ]]; }
tsx() { command tsx "$root/scripts/expanded-recovery-audit.ts" "$@"; }

load_state() {
  [[ -f "$state_file" ]] || return 0
  PHASE="$(jq -er '.phase' "$state_file")"
  ROLLOUT_GROUP_ID="$(jq -r '.rolloutGroupId // empty' "$state_file")"
  CAMPAIGN_IDS_CSV="$(jq -er '.campaignIds | join(",")' "$state_file")"
  EXPECTED_NONEMPTY_CAMPAIGN_COUNT="$(jq -er '.campaignIds | length' "$state_file")"
  DEPLOYMENT_ID="$(jq -r '.deploymentId // empty' "$state_file")"
  HISTORICAL_PRIOR="$(jq -r '.historicalPrior // empty' "$state_file")"
}

save_state() {
  local tmp
  tmp="$(mktemp "${state_file}.XXXXXX")"
  chmod 600 "$tmp"
  jq -n \
    --arg phase "$PHASE" --arg project "$RAILWAY_PROJECT_ID" --arg service "$RAILWAY_SERVICE_ID" \
    --arg environment "$RAILWAY_ENVIRONMENT_ID" --arg deployment "${DEPLOYMENT_ID:-}" \
    --arg instance "${DEPLOYMENT_INSTANCE_ID:-}" --arg group "${ROLLOUT_GROUP_ID:-}" \
    --arg historical "${HISTORICAL_PRIOR:-}" --arg release "${RELEASE_SHA:-}" \
    --arg api "$(printf %s "$API_BASE" | shasum -a 256 | awk '{print $1}')" \
    --arg database "$(printf %s "$EXPECTED_DATABASE_HOST/$EXPECTED_DATABASE_NAME" | shasum -a 256 | awk '{print $1}')" \
    --argjson campaigns "$(printf '%s' "${CAMPAIGN_IDS_CSV:-}" | jq -R 'if length == 0 then [] else split(",") end')" \
    '{phase:$phase,railway:{projectId:$project,serviceId:$service,environmentId:$environment},deploymentId:$deployment,deploymentInstanceId:$instance,rolloutGroupId:$group,campaignIds:$campaigns,historicalPrior:$historical,releaseSha:$release,apiFingerprint:$api,databaseFingerprint:$database}' > "$tmp"
  mv "$tmp" "$state_file"
}

require_common() {
  for tool in railway jq curl tsx; do command -v "$tool" >/dev/null || die "missing $tool"; done
  for value in API_BASE API_SERVICE RAILWAY_ENVIRONMENT RAILWAY_PROJECT_ID RAILWAY_SERVICE_ID RAILWAY_ENVIRONMENT_ID EXPECTED_API_HOST EXPECTED_DATABASE_HOST EXPECTED_DATABASE_NAME PGURL; do need "$value"; done
  [[ "$API_BASE" == "https://$EXPECTED_API_HOST"* ]] || die 'API host mismatch or non-HTTPS'
  [[ "$RAILWAY_ENVIRONMENT" != '' ]] || die 'environment name is required'
}

railway_scope=( )
scope() { railway_scope=(--project "$RAILWAY_PROJECT_ID" --service "$RAILWAY_SERVICE_ID" --environment "$RAILWAY_ENVIRONMENT_ID"); }
api_get() { printf 'header = "Authorization: Bearer %s"\n' "$OWNER_TOKEN" | curl --config - --fail --silent --show-error "$API_BASE$1"; }
api_post() { printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nrequest = "POST"\ndata = %s\n' "$OWNER_TOKEN" "$2" | curl --config - --fail --silent --show-error "$API_BASE$1"; }

require_owner() {
  need OWNER_TOKEN; need OWNER_EMAIL
  [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die 'OWNER_EMAIL invalid'
  [[ "$(api_get /api/me | jq -er '.email')" == "$OWNER_EMAIL" ]] || die 'OWNER_EMAIL does not match authenticated /api/me'
}
assert_circuit_closed() { api_get /api/recovery-reminders/metrics | jq -e '.health.circuitOpen == false' >/dev/null || die 'shared circuit is open'; }

campaign_ids() { IFS=, read -r -a campaign_ids_array <<<"$CAMPAIGN_IDS_CSV"; }
assert_group() {
  uuid "$ROLLOUT_GROUP_ID" || die 'invalid rollout group'
  campaign_ids
  [[ "${#campaign_ids_array[@]}" == "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT" && "$EXPECTED_NONEMPTY_CAMPAIGN_COUNT" =~ ^[1-4]$ ]] || die 'invalid campaign set in state'
  tsx assert-group --group "$ROLLOUT_GROUP_ID" --campaigns "$CAMPAIGN_IDS_CSV" --phase "$1" >/dev/null
}

pause_and_verify() {
  [[ -n "${ROLLOUT_GROUP_ID:-}" && -n "${OWNER_TOKEN:-}" ]] || return 1
  local attempt
  for attempt in 1 2 3; do
    api_post "/api/historical-recovery/rollout-groups/$ROLLOUT_GROUP_ID/pause" '{"reason":"emergency: fail-closed operator cleanup"}' >/dev/null &&
    api_get /api/historical-recovery/campaigns | jq -e --arg group "$ROLLOUT_GROUP_ID" --argjson ids "$(printf '%s' "$CAMPAIGN_IDS_CSV" | jq -R 'split(",")')" '
    [.campaigns[] | select(.rolloutGroupId == $group and (.id as $id | $ids | index($id))) | .state] | length == ($ids|length) and all(.[]; . != "running")' >/dev/null
    if [[ $? == 0 ]]; then return 0; fi
    sleep "$attempt"
  done
  return 1
}
restore_historical_flag() {
  [[ -n "${HISTORICAL_PRIOR:-}" ]] || return 0
  scope
  local attempt
  for attempt in 1 2 3; do
    railway variable set --skip-deploys "${railway_scope[@]}" "DM_RECOVERY_HISTORICAL_ENABLED=$HISTORICAL_PRIOR" >/dev/null && deploy_release 'rollback historical flag' >/dev/null && return 0
    sleep "$attempt"
  done
  return 1
}
cleanup() {
  local code="$1"
  (( cleanup_armed )) || return "$code"
  (( cleanup_running )) && return "$code"
  cleanup_running=1
  set +e
  note 'armed cleanup: pausing exact rollout group and restoring historical flag'
  local failed=0
  pause_and_verify || failed=1
  restore_historical_flag || failed=1
  if (( failed )); then
    PHASE=cleanup_required
    save_state || true
    note 'SAFETY NOT PROVEN: cleanup failed; state is cleanup_required. Do not resume.'
    set -e
    return 75
  fi
  set -e
  return "$code"
}
on_exit() { local code=$? cleanup_code; cleanup "$code" || cleanup_code=$?; exit "${cleanup_code:-$code}"; }
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
arm_cleanup() { cleanup_armed=1; }
disarm_cleanup() { cleanup_armed=0; }

deployment_record() { railway deployment list "${railway_scope[@]}" --limit 100 --json | jq -ce --arg id "$1" '(if type=="array" then . else .deployments end) | map(select(.id==$id)) | if length==1 then .[0] else error("exact deployment missing") end'; }
wait_success() {
  local id="$1" status attempt=1
  while ((attempt <= 60)); do
    status="$(deployment_record "$id" | jq -er '.status')"
    case "$status" in SUCCESS) railway logs "$id" "${railway_scope[@]}" --deployment --lines 200 >&2; return;; WAITING|QUEUED|BUILDING|DEPLOYING|INITIALIZING|PENDING|IN_PROGRESS) sleep 10;; *) die "deployment $id is terminal $status";; esac
    ((attempt++))
  done
  die "deployment $id timed out"
}
deploy_release() {
  local message="$1" up
  up="$(railway up --detach --json "${railway_scope[@]}" --message "$message")"
  DEPLOYMENT_ID="$(jq -er '.id // .deploymentId // .deployment.id' <<<"$up")"
  uuid "$DEPLOYMENT_ID" || die 'deployment ID invalid'
  wait_success "$DEPLOYMENT_ID"
}
capture_historical_prior() {
  scope
  HISTORICAL_PRIOR="$(railway variable get DM_RECOVERY_HISTORICAL_ENABLED "${railway_scope[@]}" --json | jq -er '.value // .DM_RECOVERY_HISTORICAL_ENABLED')"
  [[ "$HISTORICAL_PRIOR" == true || "$HISTORICAL_PRIOR" == false ]] || die 'historical flag is not boolean'
}

deploy_inert() {
  require_common; scope
  [[ "${PHASE:-new}" == new || "${PHASE:-new}" == inert ]] || die 'cannot deploy inert after selection'
  [[ -n "${HISTORICAL_PRIOR:-}" ]] || capture_historical_prior
  railway variable set --skip-deploys "${railway_scope[@]}" DM_RECOVERY_HISTORICAL_ENABLED=false
  deploy_release 'expanded recovery inert'
  PHASE=inert; RELEASE_SHA="$(git rev-parse HEAD)"; save_state
}
select_drafts() {
  require_common; require_owner; scope
  [[ "${PHASE:-}" == inert ]] || die 'select requires inert phase'
  need SELECTOR_PHASE
  [[ "$SELECTOR_PHASE" == confirmed_failure || "$SELECTOR_PHASE" == unknown_read_pilot ]] || die 'SELECTOR_PHASE invalid'
  tsx audit-live >/dev/null
  need DEPLOYMENT_INSTANCE_ID; uuid "$DEPLOYMENT_INSTANCE_ID" || die 'deployment instance invalid'
  RELEASE_SHA="$(git rev-parse HEAD)"
  PHASE=selecting; save_state
  local output
  output="$(railway ssh "${railway_scope[@]}" --deployment-instance "$DEPLOYMENT_INSTANCE_ID" -- bash -lc "test \"\$(git rev-parse HEAD)\" = '$RELEASE_SHA' && test \"\$RAILWAY_PROJECT_ID\" = '$RAILWAY_PROJECT_ID' && test \"\$RAILWAY_SERVICE_ID\" = '$RAILWAY_SERVICE_ID' && test \"\$RAILWAY_ENVIRONMENT_ID\" = '$RAILWAY_ENVIRONMENT_ID' && DM_RECOVERY_HISTORICAL_ENABLED=false npm run recovery:select-expanded -- --phase '$SELECTOR_PHASE'")" || die 'remote selector failed; adopt only if it may have written'
  ROLLOUT_GROUP_ID="$(awk -F: '/rollout group/{gsub(/[[:space:]]/,"",$2);print $2;exit}' <<<"$output")"
  CAMPAIGN_IDS_CSV="$(awk -F: '/campaign id/{gsub(/[[:space:]]/,"",$2);if($2!~/^none/)print $2}' <<<"$output" | paste -sd, -)"
  campaign_ids; EXPECTED_NONEMPTY_CAMPAIGN_COUNT="${#campaign_ids_array[@]}"; assert_group draft
  PHASE=selected; save_state
}
adopt() {
  require_common
  [[ "${PHASE:-}" == inert ]] || die 'adoption requires inert phase'
  need ADOPT_ROLLOUT_GROUP_ID; need ADOPT_CAMPAIGN_IDS_CSV
  ROLLOUT_GROUP_ID="$ADOPT_ROLLOUT_GROUP_ID"; CAMPAIGN_IDS_CSV="$ADOPT_CAMPAIGN_IDS_CSV"; campaign_ids; EXPECTED_NONEMPTY_CAMPAIGN_COUNT="${#campaign_ids_array[@]}"
  assert_group draft
  PHASE=selected; save_state
}
approve_start() {
  arm_cleanup
  require_common; require_owner; scope
  [[ "${PHASE:-}" == selected ]] || die 'approve/start requires selected phase'
  assert_group draft; tsx audit-live >/dev/null; tsx audit-group --group "$ROLLOUT_GROUP_ID" --phase draft >/dev/null; assert_circuit_closed
  [[ "${ROLLOUT_TEST_FAIL_AFTER_ARM:-}" != 1 ]] || die 'test failure after cleanup arm'
  campaign_ids; for id in "${campaign_ids_array[@]}"; do api_post "/api/historical-recovery/campaigns/$id/approve" "$(jq -nc --arg email "$OWNER_EMAIL" '{approvedBy:$email,startPaused:true}')" | jq -e '.ok == true and .state == "paused"' >/dev/null || die 'approval failed'; done
  assert_group paused; PHASE=approved; save_state
  railway variable set --skip-deploys "${railway_scope[@]}" DM_RECOVERY_HISTORICAL_ENABLED=true
  deploy_release 'expanded recovery historical enable'; PHASE=deployed; save_state
  api_get /api/historical-recovery/campaigns | jq -e '.sendingEnabled == true' >/dev/null || die 'sendingEnabled false after exact deployment'
  assert_circuit_closed; for id in "${campaign_ids_array[@]}"; do api_post "/api/historical-recovery/campaigns/$id/resume" '{}' | jq -e '.ok == true and .state == "running"' >/dev/null || die 'resume failed'; done
  assert_group running; PHASE=running; save_state; disarm_cleanup
}
verify() {
  arm_cleanup
  require_common; require_owner
  [[ "${PHASE:-}" == running || "${PHASE:-}" == completed ]] || die 'verify requires running/completed phase'
  assert_group 'running|completed'; assert_circuit_closed
  campaign_ids; for id in "${campaign_ids_array[@]}"; do tsx first-send --campaign "$id" --timeout-seconds 600 | while IFS=$'\t' read -r reply parent text; do printf 'header = "Authorization: Bearer %s"\n' "$META_ACCESS_TOKEN" | curl --config - --fail --silent --show-error "https://graph.instagram.com/v21.0/$reply?fields=id,text,parent_id" | jq -e --arg id "$reply" --arg parent "$parent" --arg text "$text" '.id==$id and .parent_id==$parent and .text==$text' >/dev/null || die 'Meta readback mismatch'; done; done
  tsx audit-group --group "$ROLLOUT_GROUP_ID" --phase 'running|completed' >/dev/null; assert_circuit_closed; PHASE=verified; save_state; disarm_cleanup
}
pause() { require_common; require_owner; assert_group 'paused|running|completed'; arm_cleanup; pause_and_verify; PHASE=paused; save_state; disarm_cleanup; }

load_state
case "${1:-}" in deploy-inert) deploy_inert;; select) select_drafts;; adopt) adopt;; approve-start) approve_start;; verify) verify;; pause) pause;; *) die 'commands: deploy-inert select adopt approve-start verify pause';; esac
