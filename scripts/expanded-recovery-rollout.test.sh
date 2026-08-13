#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/expanded-recovery-rollout.sh"

bash -n "$script"

require_literal() {
  local literal="$1"
  rg --fixed-strings --quiet -- "$literal" "$script"
}

require_literal 'set -euo pipefail'
require_literal 'load_state'
require_literal 'never sources'
require_literal 'railway variable set --skip-deploys'
require_literal 'DM_RECOVERY_ENABLED=false'
require_literal 'DM_RECOVERY_HISTORICAL_ENABLED=false'
require_literal 'railway up --detach --json'
require_literal 'railway deployment list'
require_literal 'railway logs "$deployment_id"'
require_literal 'railway ssh'
require_literal '--deployment-instance "$DEPLOYMENT_INSTANCE_ID"'
require_literal 'EXPECTED_DATABASE_HOST'
require_literal 'EXPECTED_DATABASE_NAME'
require_literal 'EXPECTED_RAILWAY_ENVIRONMENT'
require_literal 'assert_circuit_closed'
require_literal 'Authorization: Bearer $META_ACCESS_TOKEN'
require_literal 'rollout_group_hourly_cap'
require_literal 'unknown_no_name'
require_literal 'south_asian'
require_literal 'wait_for_live_audit'
require_literal 'stale_or_structurally_invalid_targeted_users'
require_literal 'c.audience_segment IS DISTINCT FROM u.audience_segment'
