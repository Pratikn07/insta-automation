# Guide Access V2 production recovery QA

Date: 2026-08-24 (America/Los_Angeles)  
Branch: `codex/guide-access-v2-production-recovery`  
Production base: `f8597a2` (contains production merge `860c79e`)  
Verdict: **READY FOR CONTROLLED PRODUCTION REPAIR**

This verdict authorizes the migration-first code deployment and read-only
production audit. It does **not** authorize `replay-swallowed-actions`; that mode
contacts real parents and still requires separate approval of its fresh count and
resource breakdown.

## Scope and invariants

The release repairs the defects observed in V2 without turning V2 off:

- five fresh follow checks and three automatic follow responses are supported by
  both runtime and database;
- request and follow actions remain usable for the complete current 24-hour
  messaging window;
- one exact webhook redelivery is idempotent, while a second genuine tap on an old
  card is a distinct durable event;
- every routed action is presented or becomes visible to the creator—no accepted
  action intentionally ends in silence;
- no guide is sent until a fresh Meta read confirms the parent follows TinySoho;
- an access review cannot be released or reset if delivery already owns recovery;
- creator recovery requires an acknowledgement and never retries an uncertain send
  automatically;
- repair is read-only by default, exact-count fenced, redacted, and Instagram replay
  requires an additional switch.

## Disposable database evidence

Database identity:

```text
container: insta-guide-access-v2-pg
image: postgres:16
host: 127.0.0.1:5434
database/schema: postgres/public
MIGRATION_TEST_DATABASE_DISPOSABLE=true
```

The container was deleted and recreated immediately before the release gate. The
roles `anon` and `authenticated` were created before migration so the Supabase
grant-revocation branch was exercised.

`npx prisma migrate deploy` applied all **61 migrations** from an empty database.
`npx prisma migrate status` then reported: `Database schema is up to date!`.

Schema inspection proved:

```text
guide_access_attempt_follow_counts_check:
  follow_check_count between 0 and 5
  follow_response_count between 0 and 3
  validated = true

guide_action_event_receipt:
  RLS enabled
  primary key valid
  token foreign key valid
  token_id index present
  anon grants = 0
  authenticated grants = 0
  permissive RLS policies = 0
```

There is no temporary `_v2` constraint after migration. Both forward migrations
use a five-second lock timeout and a 30-second statement timeout; applied
migrations were not edited.

## Automated results

Focused guide-access evidence:

- repository PostgreSQL contract: **27/27 passed**;
- creator-review backend/API/repository suites: **84/84 passed**;
- routed action/recovery focused suites: **293/293 passed** during implementation;
- repair classification/CLI safety: **12/12 passed**;
- creator access card + Conversations integration: **20/20 passed**;
- metrics/health focused backend: **90/90 passed**;
- metrics/health console: **8/8 passed**.

Complete gates:

```text
npm test (without database contracts)
  190 files passed, 33 database files skipped
  3,102 tests passed, 434 skipped

npm --prefix web test
  74 files passed
  955 tests passed

npm run build
  passed

npm run check:guide-delivery-bypasses
  guide_delivery_bypass_check_passed

npx prisma validate
  valid

npm --prefix web run lint
  passed

npm --prefix web run build
  passed (existing bundle-size warning only)

git diff --check
  passed
```

The database-enabled full backend gate exposes two failures in legacy guide-cover
contract tests:

```text
221 files passed, 2 legacy guide-cover files failed
3,534 tests passed, 2 legacy guide-cover tests failed
```

- `guideCoverRepositoryContract`: an outdated expectation still requires changing
  an unpublished collection to fail, while production commit `7051d86` intentionally
  permits that move;
- `guideCoverOrphanCleanupContract`: its pre-existing concurrent two-worker fixture
  nondeterministically expects two rows to be claimed in one tick but observes one.

The source and tests for both failures are byte-identical to `origin/main`, and the
`7051d86` commit message records “2 pre-existing failures identical on clean main.”
They do not touch guide access, the new migrations, or the creator recovery surface.
They are recorded rather than concealed and are not treated as a release regression.

## Journey regressions proved

- A request token labelled expired by the legacy ten-minute implementation is
  accepted when its real parent action occurred two hours later inside the current
  messaging window.
- Fresh follower → one durable guide delivery, no follow gate.
- Fresh non-follower → gate → re-ask → update-delay message → closing message →
  typed `DONE` after following → one fresh check and one delivery.
- The database independently enforces the five-check/three-response budget under
  concurrent writers.
- Same event ID twice → one action; a different event ID on the persistent old card
  → fresh recovery; a stale card after delivery → already-sent guidance without
  redelivery.
- Meta follow-read unavailable → neutral message, guide withheld.
- uncertain send or transition failure → `needs_review`, no automatic retry.
- closed window → no misleading creator send control.
- delivery-owned access attempt → access remedies refused in favor of delivery
  review.
- creator sees the list badge and drawer card, confirms a fresh action/release,
  refreshes list/detail/count caches, and gets refresh-only guidance after an
  unknown mutation result.

## Repair command evidence

Against the disposable production-shaped schema:

```text
npm run audit:guide-access-recovery
Selected candidates: 0
counter_constraint_review: 0
swallowed_opening_action: 0
logically_expired_active_token: 0
```

No-argument execution calls no write dependency. Every write mode rejects a missing
actor or expected count; one-row count drift aborts before the write dependency;
replay refuses to run without `--send-instagram`; output tests reject parent,
conversation, attempt, and token identifiers; replay stops on the first uncertain
outcome.

## Remaining live checks

The following require deployed Meta/platform state and therefore cannot be claimed
from local tests:

1. Railway migration/start logs and deployed commit identity.
2. Production schema and aggregate health readback.
3. Vercel authenticated Conversations list badge and drawer card.
4. Authorized test-account journeys, including a tap after more than ten minutes.
5. Fresh read-only production repair counts.
6. Fifteen-minute, one-hour, six-hour, and 24-hour monitoring checkpoints.

The deployment must stop before Instagram replay and ask for explicit owner approval
if the read-only audit finds any open `swallowed_opening_action` candidates.
