#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --import tsx "$root/scripts/expanded-recovery-rollout.ts" "$@"
