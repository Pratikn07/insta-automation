# Expanded historical-recovery fail-closed rollout

This runbook covers `other`, `unknown_cue`, `unknown_generic`, and
`unknown_no_name`. `south_asian` is excluded at both confidence levels.
Expanded historical sending stays disabled until audited drafts pass. The
operator command is [`scripts/expanded-recovery-rollout.sh`](../../scripts/expanded-recovery-rollout.sh);
it never sources `.env`, never stores secrets, and writes only a mode-0600,
gitignored state file containing identity fingerprints, IDs, phase, and flag
history.

```bash
set -euo pipefail
export API_BASE='https://api.example.invalid'
export EXPECTED_API_HOST='api.example.invalid'
export OWNER_EMAIL='owner@example.invalid'
read -r -s -p 'Owner bearer token: ' OWNER_TOKEN; printf '\n'; export OWNER_TOKEN
export PGURL='postgresql://readonly:replace-me@db.example.invalid/insta_production'
export EXPECTED_DATABASE_HOST='db.example.invalid'
export EXPECTED_DATABASE_NAME='insta_production'
export API_SERVICE='api'
export RAILWAY_ENVIRONMENT='production'
export RAILWAY_PROJECT_ID='project-id'
export RAILWAY_SERVICE_ID='service-id'
export RAILWAY_ENVIRONMENT_ID='environment-id'
bash -n scripts/expanded-recovery-rollout.sh
bash scripts/expanded-recovery-rollout.test.sh
```

The owner token is checked against authenticated `GET /api/me`. Database audits
run in `BEGIN READ ONLY`, check `transaction_read_only`, and require an audit
role with no campaign DML privilege. `PGURL` is read from the environment by the
Node helper, never passed in a child argv. The test-only override for the local
disposable database is not a production instruction.

## Deploy and reclassify

```bash
bash scripts/expanded-recovery-rollout.sh deploy-inert
```

This captures the prior **historical** flag only; it never changes
`DM_RECOVERY_ENABLED` (the prospective master switch). It sets
`DM_RECOVERY_HISTORICAL_ENABLED=false` using `railway variable set --skip-deploys`,
creates a new deployment with `railway up --detach --json`, captures its exact
UUID, waits for `SUCCESS` (including `WAITING` as non-terminal), and reads logs
for that UUID. The Node audit shares `classifyIdentityPresence` and
`evaluateHistoricalAudience` with production code, so JavaScript `trim` parity
and the full method/origin/segment/confidence mapping are enforced directly.

## Select and explicit audited adoption

Selection must run only in the exact SSH instance of the captured deployment.
The wrapper pins Railway project, service, and environment IDs; it proves the
complete release commit and remote Railway identities before allowing a remote
selector command. If the selector may have succeeded but state was not written,
it intentionally refuses to create another group. Record the selector output,
then explicitly adopt exactly one audited group:

```bash
export ADOPT_ROLLOUT_GROUP_ID='00000000-0000-4000-8000-000000000000'
export ADOPT_CAMPAIGN_IDS_CSV='00000000-0000-4000-8000-000000000001'
bash scripts/expanded-recovery-rollout.sh adopt
```

Adoption queries the database and requires exact set equality between supplied
campaign IDs and the rollout group, exact non-empty count (1–4), and `draft`
state. It will not infer a group from “latest” data.

## Audit, approve, deploy enabled configuration, and start

```bash
bash scripts/expanded-recovery-rollout.sh approve-start
```

Before its first mutation this command confirms `/api/me`, circuit closed,
exact group/campaign set, and the full draft audit: live/candidate/campaign
segment equality, zero stale, zero duplicates, both-confidence South-Asian
exclusion, group cap 10, per-campaign hourly cap <=10, and daily cap 1000.
It then arms an EXIT/INT/TERM cleanup, approves every campaign paused, deploys
a **new captured** Railway release with only the historical flag true, waits for
that exact release, requires API `sendingEnabled=true`, and resumes every exact
campaign. Any error pauses and verifies the exact group non-running and restores
the prior historical flag through another captured deployment.

## First-send verification and emergency pause

```bash
read -r -s -p 'Meta access token: ' META_ACCESS_TOKEN; printf '\n'; export META_ACCESS_TOKEN
bash scripts/expanded-recovery-rollout.sh verify
export EMERGENCY_REASON='unexpected recovery health signal'
bash scripts/expanded-recovery-rollout.sh pause
```

Verification arms the same cleanup across its bounded first-send wait. For every
non-empty campaign it queries the actual sent dispatch ledger and candidate data
ordered by `sent_at`, verifies the dispatch/candidate reply IDs agree, then
reads Meta with `Authorization: Bearer` and requires reply ID, parent comment,
and frozen text to match. A campaign may drain to `completed`; interruption,
timeout, circuit opening, query mismatch, or Meta mismatch pauses the exact
group. `pause` is the explicit atomic emergency action and verifies no exact
member remains running.
