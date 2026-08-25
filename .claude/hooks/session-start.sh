#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Two jobs:
#   1. npm deps, so `npm test` and the web eslint config actually run.
#   2. the graphify CLI + `graphify update .`, so the knowledge graph committed
#      under graphify-out/ is refreshed against the current checkout instead of
#      answering from whatever commit last built it.
#
# Safe to re-run: every step is a no-op when its work is already done.
set -euo pipefail

# Local machines already have their own toolchain; only set up the web sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "[session-start] installing npm dependencies..."
npm install --no-audit --no-fund

if [ -f web/package.json ]; then
  echo "[session-start] installing web/ dependencies..."
  npm install --no-audit --no-fund --prefix web
fi

# src/config/env.ts validates on import and calls process.exit(1) when a var is
# missing, which takes down every vitest file before a single test runs. The web
# sandbox has no .env, so seed placeholders that satisfy the zod schema. These
# are NOT credentials and reach nothing real - they only get the schema to pass
# so unit tests can import the module. Never overwrite an existing .env.
# Contract tests still need a real Postgres via MIGRATION_TEST_DATABASE_URL.
if [ ! -f .env ]; then
  echo "[session-start] seeding placeholder .env for unit tests..."
  cat > .env <<'ENVEOF'
# Placeholders written by .claude/hooks/session-start.sh so `npm test` can run
# in Claude Code on the web. Not real credentials. Delete to use your own.
META_APP_SECRET=placeholder
META_VERIFY_TOKEN=placeholder
IG_ACCESS_TOKEN=placeholder
IG_USER_ID=placeholder
SUPABASE_SERVICE_KEY=placeholder
SUPABASE_URL=https://placeholder.supabase.co
DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
DIRECT_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
CODEX_RUNTIME_URL=https://placeholder.invalid
CODEX_RUNTIME_TOKEN=placeholder_placeholder_placeholder_00
TINY_SOHO_INTERNAL_TOKEN=placeholder_placeholder_placeholder_00
ENVEOF
fi

# uv is preinstalled in the web sandbox; fall back to pip if it ever is not.
echo "[session-start] installing graphify..."
if command -v uv >/dev/null 2>&1; then
  uv tool install --quiet "graphifyy[sql]" || true
  # uv drops executables here; later steps and the PreToolUse hooks need it.
  export PATH="$HOME/.local/bin:$PATH"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
elif ! command -v graphify >/dev/null 2>&1; then
  pip install --quiet "graphifyy[sql]" || true
fi

# --update is incremental: unchanged files come from manifest.json, so this is
# seconds on a warm checkout rather than a full re-parse. --code-only keeps it
# key-free; docs/images would need an LLM backend.
if command -v graphify >/dev/null 2>&1; then
  echo "[session-start] refreshing knowledge graph..."
  graphify . --code-only --update && graphify cluster-only .
else
  echo "[session-start] graphify unavailable; leaving graphify-out/ at its committed state." >&2
fi

echo "[session-start] done."
