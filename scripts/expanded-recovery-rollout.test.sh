#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/expanded-recovery-rollout.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
log="$tmp/calls.log"
state="$tmp/state.json"

cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *'/api/recovery-reminders/metrics'*) printf '%s\n' '{"health":{"circuitOpen":false}}' ;;
  *'/api/me'*) printf '%s\n' '{"email":"owner@example.test"}' ;;
  *'/rollout-groups/'*'/pause'*) printf '%s\n' '{"pausedCampaignIds":["10000000-0000-4000-8000-000000000001"]}' ;;
  *'/historical-recovery/campaigns'*) printf '%s\n' '{"sendingEnabled":true,"campaigns":[{"id":"10000000-0000-4000-8000-000000000001","state":"paused"}]}' ;;
  *) printf '%s\n' '{}' ;;
esac
SH
cat > "$tmp/bin/railway" <<'SH'
#!/usr/bin/env bash
printf 'railway %s\n' "$*" >> "$FAKE_LOG"
case "$*" in *'restart'*) exit 97;; esac
printf '%s\n' '{"id":"20000000-0000-4000-8000-000000000001","status":"SUCCESS"}'
SH
cat > "$tmp/bin/tsx" <<'SH'
#!/usr/bin/env bash
printf 'tsx %s\n' "$*" >> "$FAKE_LOG"
[[ "${FAKE_GROUP_MISMATCH:-}" != 1 ]] || exit 9
case "$*" in *'assert-group'*) printf '%s\n' '{"campaignIds":["10000000-0000-4000-8000-000000000001"],"phase":"draft"}' ;; *'first-send'*) printf 'reply-1\tparent-1\ttext-1\n' ;; *) printf '%s\n' '{"ok":true}' ;; esac
SH
chmod +x "$tmp/bin"/*

export PATH="$tmp/bin:$PATH"
export FAKE_LOG="$log"
export EXPANDED_RECOVERY_STATE_FILE="$state"
export API_BASE='https://api.example.test'
export OWNER_TOKEN='token-must-not-appear'
export OWNER_EMAIL='owner@example.test'
export RAILWAY_PROJECT_ID='project-id'
export RAILWAY_SERVICE_ID='service-id'
export RAILWAY_ENVIRONMENT_ID='environment-id'
export RAILWAY_ENVIRONMENT='production'
export API_SERVICE='api'
export EXPECTED_API_HOST='api.example.test'
export EXPECTED_DATABASE_HOST='db.example.test'
export EXPECTED_DATABASE_NAME='app'
export PGURL='postgresql://secret:never-log@db.example.test/app'
export ROLLOUT_GROUP_ID='30000000-0000-4000-8000-000000000001'
export CAMPAIGN_IDS_CSV='10000000-0000-4000-8000-000000000001'
export EXPECTED_NONEMPTY_CAMPAIGN_COUNT='1'
export ROLLOUT_TEST_FAIL_AFTER_ARM='1'

jq -n '{phase:"selected",rolloutGroupId:"30000000-0000-4000-8000-000000000001",campaignIds:["10000000-0000-4000-8000-000000000001"],historicalPrior:"false"}' > "$state"

set +e
bash "$script" approve-start >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]
rg -q '/pause' "$log"
! rg -q 'restart' "$log"
! rg -q 'token-must-not-appear|secret:never-log' "$log"
! rg -q 'token-must-not-appear|secret:never-log' "$state"

: > "$log"
export FAKE_GROUP_MISMATCH=1
unset ROLLOUT_TEST_FAIL_AFTER_ARM
set +e
bash "$script" approve-start >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]
! rg -q '/approve' "$log"

: > "$log"
unset FAKE_GROUP_MISMATCH
export META_ACCESS_TOKEN='meta-secret-must-not-appear'
jq '.phase="running"' "$state" > "$state.next" && mv "$state.next" "$state"
set +e
bash "$script" verify >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]
rg -q '/pause' "$log"
! rg -q 'meta-secret-must-not-appear' "$log"

printf 'behavioral rollout safety tests passed\n'
