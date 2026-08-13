# Expanded historical-recovery fail-closed rollout

This runbook covers `other`, `unknown_cue`, `unknown_generic`, and
`unknown_no_name`. Both high- and low-confidence `south_asian` users remain
excluded. Use only the typed operator behind
[`scripts/expanded-recovery-rollout.sh`](../../scripts/expanded-recovery-rollout.sh).
The shell file is a signal-transparent `exec` wrapper; all lifecycle, identity,
audit, and rollback decisions live in the tested TypeScript operator.

The operator never sources `.env`. It stores no token or database URL. Its
mode-0600 state file contains exact Railway IDs, deployment/instance IDs,
release and selector hashes, API/DB fingerprints, the original historical
flag, the selector decision hashes, and a durable phase/cleanup lock.

## One-time operator environment

Use exact production values; the UUIDs below are shape examples, not defaults.

```bash
set -euo pipefail
export API_BASE='https://api.example.invalid'
export EXPECTED_API_HOST='api.example.invalid'
export OWNER_EMAIL='owner@example.invalid'
read -r -s -p 'Owner bearer token: ' OWNER_TOKEN; printf '\n'; export OWNER_TOKEN

export PGURL='postgresql://readonly:replace-me@db.example.invalid/insta_production?sslmode=require'
export EXPECTED_DATABASE_HOST='db.example.invalid'
export EXPECTED_DATABASE_NAME='insta_production'

export API_SERVICE='api'
export RAILWAY_ENVIRONMENT='production'
export RAILWAY_PROJECT_ID='11111111-1111-4111-8111-111111111111'
export RAILWAY_SERVICE_ID='22222222-2222-4222-8222-222222222222'
export RAILWAY_ENVIRONMENT_ID='33333333-3333-4333-8333-333333333333'

bash -n scripts/expanded-recovery-rollout.sh
bash scripts/expanded-recovery-rollout.test.sh
```

`API_BASE` must be one exact HTTPS origin—credentials, path, query, fragment,
and suffix-host matches are rejected. `PGURL` must be PostgreSQL with the exact
host, port, and database. Audit subprocesses receive `PGURL` through their
environment, never argv; owner and Meta tokens are removed from that child
environment. The audit opens a repeatable-read, read-only transaction and
rejects a production audit role with campaign DML privileges.

## 1. Capture the prior flag and deploy inert

```bash
bash scripts/expanded-recovery-rollout.sh deploy-inert
```

This first durably records the original `DM_RECOVERY_HISTORICAL_ENABLED` value.
It then sets only that historical flag to `false` with `--skip-deploys`, creates
a new Railway deployment, captures its exact ID, waits for the exact deployment
record to reach `SUCCESS`, and requires `/health` to attest the same project,
service, environment, deployment, local release SHA, and disabled flag. It does
not change `DM_RECOVERY_ENABLED` and never uses a latest-deployment fallback or
restart.

## 2. Select on the exact deployed instance

```bash
export SELECTOR_PHASE='unknown_read_pilot' # or confirmed_failure
export DEPLOYMENT_INSTANCE_ID='44444444-4444-4444-8444-444444444444'
bash scripts/expanded-recovery-rollout.sh select
```

Before selection, the operator verifies the active API deployment, owner,
shared circuit, and live audience parity. The remote instance must attest that
it belongs to the saved deployment and has the exact Railway IDs, release SHA,
selector SHA-256, PostgreSQL protocol/host/port/database, and historical flag
`false`. The selector returns one strict JSON record with the canonical four
segments, 10/hour rollout cap, 1000/day campaign caps, zero holdout, fixed
policy/selection/copy versions, frozen counts, and decision hashes. Human text,
malformed output, duplicate IDs, wrong order, or a wrong phase is rejected.

The state is written as `selecting` before the remote command. If transport
becomes uncertain, do not run selection again. Adoption is allowed only from
that exact saved deployment instance and only with the exact original one-line
selector record:

```bash
export ADOPT_SELECTION_JSON='{"schemaVersion":1,"kind":"expanded-recovery-selection",...}'
bash scripts/expanded-recovery-rollout.sh adopt
```

Never guess an ID/hash or adopt “latest.” If the exact record is unavailable,
stop and reconstruct it through a separately reviewed read-only investigation.

## 3. Atomically approve, deploy enabled, and resume

```bash
bash scripts/expanded-recovery-rollout.sh approve-start
```

Before any approval mutation, the operator revalidates the exact active API
deployment, owner, closed circuit, live parity, and every non-empty campaign in
one complete group audit. The authenticated API then locks the singleton
recovery control, all exact campaign members, users, candidates, approved
sources, and exclusions in one transaction. It recomputes and binds the
selection fingerprint and selector decision hashes; verifies exact phase,
policy/selection/copy versions, frozen candidate/exclusion counts, treatment
arms, source topology/order, audience parity, and caps; and only then performs
one group approval mutation. There is no approve-one-then-fail-later loop.

The operator resumes safely from `selected`, `approved`, `deployed`, or a fully
cleaned `recovery_ready` phase. It deploys a new exact release with the
historical flag true, proves that exact deployment through `/health`, confirms
API sending is enabled and the circuit remains closed, then atomically resumes
the exact group. Existing `startedAt` timestamps are preserved on a resumed
campaign.

## 4. Verify first sends or pause

```bash
read -r -s -p 'Meta access token: ' META_ACCESS_TOKEN; printf '\n'; export META_ACCESS_TOKEN
bash scripts/expanded-recovery-rollout.sh verify

bash scripts/expanded-recovery-rollout.sh pause
```

Verification accepts running or completed campaigns. For every non-empty
campaign, it requires a sent dispatch whose `source_kind` is `historical`,
whose `source_id` is the candidate ID, and whose dispatch comment is in that
candidate's immutable approved source set. It then reads the exact Instagram
reply with an Authorization header and verifies reply ID, parent comment, and
frozen text. Circuit and complete group audits run before and after readback.

`pause` and every armed failure/signal (`INT`, `TERM`, `HUP`) run the same
idempotent fail-closed cleanup: pause and verify the exact group, restore the
original historical flag through a new captured deployment, and verify the
serving API identity. Both actions retry three bounded times. Cleanup writes
`cleanup_required` before attempts and returns status 75 if either proof or the
durable state transition remains unverified.

While `cleanup_required` is present, every command except this one is blocked:

```bash
bash scripts/expanded-recovery-rollout.sh retry-cleanup
```

`retry-cleanup` re-proves both current safety conditions; it does not trust
stale partial-success flags. The lock clears to `recovery_ready` only after the
exact group is non-running and the original historical flag is served by the
newly captured rollback deployment.
