#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/expanded-recovery-rollout.sh"

bash -n "$script"

set +e
output="$(bash "$script" not-a-command 2>&1)"
status=$?
set -e

[[ "$status" -eq 1 ]]
[[ "$output" == *"commands: deploy-inert select adopt approve-start verify pause retry-cleanup"* ]]

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cp "$(command -v git)" "$tmp/bin/real-git"
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "status --porcelain=v1" ]]; then
  sleep "${FAKE_GIT_DELAY:-0}"
  exit 0
fi
if [[ "$1 $2" == "rev-parse HEAD" ]]; then
  printf '%040d\n' 0
  exit 0
fi
if [[ "$1 $2" == "ls-files -z" ]]; then
  exit 0
fi
exec "$(dirname "$0")/real-git" "$@"
EOF
chmod +x "$tmp/bin/git"

write_valid_state() {
  local state="$1"
  cat > "$state" <<'EOF'
{
  "version": 3,
  "revision": 1,
  "phase": "inert",
  "identity": {
    "railway": {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "serviceId": "22222222-2222-4222-8222-222222222222",
      "environmentId": "33333333-3333-4333-8333-333333333333",
      "environmentName": "production",
      "serviceName": "api"
    },
    "releaseSha": "0000000000000000000000000000000000000000",
    "sourceTreeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "selectorSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "api": {
      "origin": "https://api.example.test",
      "host": "api.example.test",
      "ownerEmail": "owner@example.test",
      "fingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "database": {
      "protocol": "postgresql:",
      "host": "db.example.test",
      "port": "5432",
      "name": "app",
      "fingerprint": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  },
  "historicalPrior": false,
  "selectorDeployment": { "id": "44444444-4444-4444-8444-444444444444", "instanceId": null },
  "activeDeploymentId": "44444444-4444-4444-8444-444444444444",
  "rollout": null,
  "operation": null,
  "cleanup": null
}
EOF
}

run_signal_case() {
  local signal="$1"
  local state="$tmp/state-$signal.json"
  write_valid_state "$state"
  set +e
  PATH="$tmp/bin:$PATH" FAKE_GIT_DELAY=1 EXPANDED_RECOVERY_STATE_FILE="$state" \
    bash "$script" deploy-inert >"$tmp/$signal.out" 2>&1 &
  local pid=$!
  for _ in {1..100}; do
    [[ -d "$state.lock" ]] && break
    sleep 0.02
  done
  [[ -d "$state.lock" ]]
  kill -s "$signal" "$pid"
  wait "$pid"
  local code=$?
  set -e
  [[ "$code" -eq 75 ]]
  [[ -f "$state.cleanup-required" ]]
}

run_signal_case INT
run_signal_case TERM
run_signal_case HUP

state="$tmp/concurrent.json"
write_valid_state "$state"
set +e
PATH="$tmp/bin:$PATH" FAKE_GIT_DELAY=1 EXPANDED_RECOVERY_STATE_FILE="$state" \
  bash "$script" deploy-inert >"$tmp/first.out" 2>&1 &
first_pid=$!
for _ in {1..100}; do
  [[ -d "$state.lock" ]] && break
  sleep 0.02
done
[[ -d "$state.lock" ]]
PATH="$tmp/bin:$PATH" EXPANDED_RECOVERY_STATE_FILE="$state" \
  bash "$script" deploy-inert >"$tmp/second.out" 2>&1
second_status=$?
wait "$first_pid"
first_status=$?
set -e
[[ "$second_status" -eq 75 ]]
[[ "$first_status" -eq 75 ]]
[[ "$(cat "$tmp/second.out")" == *"exclusive lock exists"* ]]

"$root/node_modules/.bin/vitest" run \
  "$root/src/services/expandedRecoveryRolloutCore.test.ts" \
  "$root/src/services/expandedRecoveryRolloutOperator.test.ts"

printf 'behavioral rollout safety tests passed\n'
