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

"$root/node_modules/.bin/vitest" run \
  "$root/src/services/expandedRecoveryRolloutCore.test.ts" \
  "$root/src/services/expandedRecoveryRolloutOperator.test.ts"

printf 'behavioral rollout safety tests passed\n'
