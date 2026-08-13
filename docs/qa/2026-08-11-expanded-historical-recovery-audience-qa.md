# Expanded historical-recovery audience rollout runbook

This is the executable production runbook for the approved v3 segment policy.
It covers only `other`, `unknown_cue`, `unknown_generic`, and
`unknown_no_name`. `western` is never re-selected. `south_asian` is excluded at
both `high` and `low` confidence.

**Hard gate:** expanded sending remains disabled until `audit-live` and
`audit-drafts` both exit successfully. The commands below use
[`scripts/expanded-recovery-rollout.sh`](../../scripts/expanded-recovery-rollout.sh),
which contains the exact SQL and fails closed on every expected-zero gate. It
never sources `.env`.

## One-time preflight

Run these commands from a clean checkout of the release being deployed. Obtain
all values from the approved production operator channel; the `.invalid`
examples deliberately cannot reach production. `PGURL` is an explicit,
read-only production connection used only for the audit queries. The script
rejects loopback URLs and a host, database, environment, or HTTPS-host mismatch.

```bash
set -euo pipefail
export API_SERVICE='api'
export RAILWAY_ENVIRONMENT='production'
export EXPECTED_RAILWAY_ENVIRONMENT='production'
export API_BASE='https://api.example.invalid'
export EXPECTED_API_HOST='api.example.invalid'
export EXPECTED_DATABASE_HOST='postgres.example.invalid'
export EXPECTED_DATABASE_NAME='insta_production'
export PGURL='postgresql://readonly:replace-me@postgres.example.invalid/insta_production'
export REMOTE_RELEASE_DIR='/app'
export PHASE='unknown_read_pilot'
export OWNER_EMAIL='owner@example.invalid'
read -r -s -p 'Owner bearer token: ' OWNER_TOKEN
printf '\n'
export OWNER_TOKEN
bash -n scripts/expanded-recovery-rollout.sh
bash scripts/expanded-recovery-rollout.test.sh
```

The script writes only captured UUIDs and campaign counts to
`.expanded-recovery-rollout.state` (mode `0600`); it never writes a token or a
database URL. Do not substitute `railway run`: Railway CLI 4.65 documents it as
a *local* command with injected variables, not the deployed release filesystem.

## 1. Deploy inert and capture the exact release

```bash
bash scripts/expanded-recovery-rollout.sh deploy-inert
```

`deploy-inert` executes exactly:

- `railway variable set --skip-deploys` with
  `DM_RECOVERY_ENABLED=false` and `DM_RECOVERY_HISTORICAL_ENABLED=false`;
- `railway up --detach --json`, captures its returned deployment UUID, then
  polls that UUID only until `SUCCESS` (60 attempts, 10 seconds each);
- `railway deployment list --json` and `railway logs "$DEPLOYMENT_ID"` for that
  same UUID on success, timeout, or failure.

It never infers “latest successful” deployment. A failed or timed-out poll is a
stop condition; leave both flags false and use the emergency pause below.

## 2. Reclassify and prove the live zero gate

The deployed worker reclassifies the targeted historical pool while both sending
flags remain false. Poll the exact guarded audit rather than assuming a worker
log line proves completion:

```bash
bash scripts/expanded-recovery-rollout.sh wait-live
```

This runs for at most 120 minutes. Its exact SQL prints method/segment/confidence
counts and requires `stale_or_structurally_invalid_targeted_users=0`. It enforces
the full `historicalAudienceSegment.ts` map: `western/us_western`, `other/other`,
the three unknown segments/`unknown`, and `south_asian/south_asian`, each with
`llm_v3` and `high` or `low` confidence. It also applies JavaScript-trim-style
whitespace normalization before removing only ASCII hyphens: whitespace-only
and space-padded `-` are `unknown_no_name`; a space-padded em dash (`—`) is not.

## 3. Select inert drafts in the deployed service

First obtain `DEPLOYMENT_INSTANCE_ID` from the exact captured Railway deployment
record using the operator console. It must be the instance for the recorded
`DEPLOYMENT_ID`; Railway CLI 4.65 has no command that safely maps a deployment
UUID to an instance UUID, so this is an explicit human verification point.

```bash
export DEPLOYMENT_INSTANCE_ID='00000000-0000-4000-8000-000000000000'
bash scripts/expanded-recovery-rollout.sh select
bash scripts/expanded-recovery-rollout.sh audit-drafts
```

Selection runs through `railway ssh --deployment-instance`, not locally. Before
writing it verifies the selected release is `SUCCESS`, checks the deployed
selector file hash against this release checkout, and validates the deployed
service `DATABASE_URL` host and database. It then explicitly sets both recovery
flags false for selection. It fails if it produces zero, more than four, or a
duplicate/non-UUID campaign; only the exact non-empty campaign count may proceed.

`audit-drafts` contains and executes the exact SQL for manifest, method,
segment, confidence, candidate/live/campaign equality, duplicate, stale-target,
South-Asian exclusion, and cap gates. Every one must be zero. It requires:

- one of the four approved expanded segments per campaign;
- `holdout_percent=0`, batch size `1`, per-campaign hourly cap `<=10`, daily
  cap `1000`, and shared rollout-group hourly cap `10`;
- no duplicate person across the rollout, no stale candidate, and no selected
  `south_asian` person at either confidence.

Record the printed counts, decision hashes, group UUID, and campaign UUIDs with
the approval record. Do not start after a nonzero count or an unexpected
method/segment/confidence row.

## 4. Approve and start

The script checks the authenticated shared recovery metrics endpoint and
requires `health.circuitOpen=false` before approval and again before resume.
Approval is paused and all campaign UUIDs must succeed; an approval, flag,
restart, or resume failure triggers an API group pause and exits nonzero.

```bash
bash scripts/expanded-recovery-rollout.sh approve-start
```

It re-audits the immutable paused manifests, sets the two recovery flags with
`--skip-deploys`, refuses an ambiguous Railway restart if any deployment is newer
than the captured inert deployment, restarts, checks the circuit again, then
resumes every approved campaign. There is no partial-success path.

## 5. Verify first Meta comments and ongoing health

Supply a Meta access token without putting it in a URL, then run the verification
gate after the first candidate is sent for every non-empty campaign:

```bash
read -r -s -p 'Meta access token: ' META_ACCESS_TOKEN
printf '\n'
export META_ACCESS_TOKEN
bash scripts/expanded-recovery-rollout.sh verify
```

`verify` performs authenticated `GET /api/recovery-reminders/metrics` checks
before and after validation, requiring `circuitOpen=false`. For each campaign it
reads the first sent candidate through the owner API and reads the exact Meta
comment using `Authorization: Bearer $META_ACCESS_TOKEN`. It requires matching
reply ID, parent comment ID, and frozen reply text, then reruns the exact
running-state audit: caps `10/1000`, duplicates zero, stale/inconsistent zero,
and both-confidence South-Asian exclusion.

## Rollback and emergency pause

Use this immediately for a complaint, opt-out, block, negative reply,
classifier anomaly, duplicate, circuit opening, provider failure, an unexpected
count, a partial operation, or operator doubt:

```bash
export EMERGENCY_REASON='unexpected recovery health signal'
bash scripts/expanded-recovery-rollout.sh pause
```

The authenticated group pause is atomic for this rollout only. Keep both Railway
flags false for a broader rollback; do not reverse the additive migration or
alter campaign rows directly. The captured deployment, audit outputs, health
signals, and already-posted Meta comment IDs remain the incident evidence.
