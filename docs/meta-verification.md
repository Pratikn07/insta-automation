# Raising the Instagram messaging rate limit (Meta verification playbook)

## Why this matters

Our comment→DM gate uses Instagram's **Private Replies API**. It fails ~92% of the
time with error `code 100 / subcode 2534025` ("comment is invalid for a private
reply").

Two separate things are true about that error, and conflating them causes the
wrong fix. **What Meta means by it** is a catch-all: the comment cannot receive a
private reply — deleted, older than seven days, already replied to, or otherwise
ineligible. **Why we get so many of them** is, on the evidence below, an
account-level rate/quota limit; a quota rejection surfaces through this same
catch-all rather than through a dedicated rate-limit code.

So this playbook treats it as a quota problem *to solve*, while the code never
classifies it as a rate limit — see "Do not add `100:2534025`" below. The
evidence that the cause is quota, not per-comment eligibility:

- At low volume it succeeds 100%; under real volume it drops to a few sends/hour.
- Our traffic (~50–100 comments/hr) is far below Meta's documented 750/hr cap, so
  the *effective* quota on this account is unusually low — the signature of a
  **new / unverified / low-reputation** app + account.

The **retry queue** (already shipped) works around this by re-attempting within the
7-day window. **This document is the other half: raising the actual ceiling** so
more sends succeed on the first try. It is operator/account work — not code.

> Verify the exact current steps in the Meta App Dashboard and
> https://developers.facebook.com/docs/ — Meta changes this flow periodically.
> Treat the steps below as the checklist, not a guarantee of today's UI labels.

## What raises the limit (in priority order)

### 1. Meta Business Verification  ← the gateway, do this first
Almost every higher-access path is gated behind a verified Business.

1. Go to **business.facebook.com** → **Business Settings** → **Security Center**
   (or **Business Verification**).
2. Submit the legal business: legal name, address, phone, and a verification
   document (business registration / utility bill / etc. as Meta lists).
3. Confirm via the phone/email/domain method Meta offers.
4. Wait for approval (typically a few business days).

**Prerequisite:** the Instagram professional account and the app must be attached
to this Business in Business Settings → Accounts → Instagram accounts / Apps.

### 2. App Review → Advanced Access for messaging permissions
Standard Access (the default) carries the low limits. **Advanced Access** is what
production messaging apps run on.

1. Meta App Dashboard → your app → **App Review → Permissions and Features**.
2. Request **Advanced Access** for the messaging permissions the app uses:
   - `instagram_business_manage_messages` (sending DMs / private replies)
   - `instagram_business_basic`
   - (whichever the app actually requests at login)
3. Provide what App Review requires:
   - A clear use-case description (comment-keyword → deliver requested guide via DM).
   - A **screencast** demonstrating the full flow end-to-end.
   - Privacy policy URL + how data is used.
4. Submit and wait for review.

**Note:** the app must currently be in / moving to **Live** mode (not Development)
for Advanced Access to take effect in production.

### 3. Warm up + good sending behaviour (reduces throttling regardless of tier)
Rate limits are partly reputation-based. Lower the spam signal:

- Keep pacing conservative (the retry worker already spaces sends).
- **Vary the gate message wording**; avoid identical, emoji-only, link-heavy text.
- Avoid sudden bursts right after a viral reel (the worker's adaptive backoff helps).
- Make sure the Instagram account itself is in good standing (no recent violations).

## How we'll know it worked

After verification + Advanced Access is granted, watch the same metrics we used to
diagnose this (via the Supabase MCP / Activity page):

- The **first-try `dm_failed` (2534025) rate should drop** — more gates succeed
  immediately, fewer land in the retry queue.
- `gateQueuePending` on the Home dashboard should trend down.
- Re-run the recovery query (failed-gate users vs. never-recovered) — the
  never-recovered count should shrink.

## Honest expectation

Verification is an **application with no guaranteed outcome or timeline**, and Meta
does not publish the exact post-verification limit. The retry queue is what
guarantees recovery *today*; verification is the lever that should raise the
first-try ceiling over time. Pursue both — they compound.

---

# DM recovery: launch runbook

Everything below concerns the read-recovery reminder feature, which may post a
public reply on someone's original comment when their gate DM has no confirmed
read. Under `read-recovery-timing-v2`, a follower is assigned to a two-hour,
six-hour, or no-reminder arm. The historical v1 path used one ten-hour delay.
It posts publicly, on a real person's comment, so the order of these steps
matters.

## Deploy owner checklist

- [ ] Add `messaging_seen`, `message_reactions`, and `messaging_postbacks` beside `comments` and `messages`.
- [ ] Receive one real signed webhook fixture for each new field.
- [ ] Match a real `read.mid` to the accepted gate's stored `instagramGateMessageId`.
- [ ] Confirm duplicate delivery leaves one evidence update.
- [ ] Confirm the settings-blocked signature allowlist is empty unless the exact code/subcode has an active, unexpired registry record backed by a sanitized controlled-account evidence package.
- [ ] Confirm the recovery circuit is closed and the hourly cap is conservative.
- [ ] Confirm the v2 version, start, and day-42 maximum end are fixed before launch.
- [ ] Confirm the real-Postgres migration contract ran with zero skips.
- [ ] Audit the first 20 v2 treatment comments against stored evidence and Instagram.
- [ ] Complete the owner checklist in `docs/dm-recovery-timing-experiment-runbook.md`.

## The premise, stated once

**No event means "No confirmed read". It never means "Unread".**

Meta gives no per-message unread signal. Business Suite's gray "not delivered"
warning is a UI affordance and **is not available as a webhook event** — nothing
in this codebase can observe it, and no amount of polling will surface it. The
only positive evidence available is `messaging_seen`, a reaction, a postback, or
an inbound message. Absence of all four is the absence of evidence, which is why
the copy says "Check your DMs/Requests" rather than asserting anything about
whether the message arrived.

Never write code, or a query, that infers "unread" from missing signals.

## Verifying the new webhook fields

Enable the fields in Meta Developer Dashboard → your app → Webhooks → Instagram,
then send yourself each kind of event from a test account.

Redacted fixture shapes (the fields the handlers actually read):

```jsonc
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "read":     { "mid": "…" } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "reaction": { "mid": "…", "action": "react" } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "postback": { "mid": "…", "payload": "…" } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "message":  { "mid": "…", "text": "…" } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "message":  { "mid": "…", "attachments": [ … ] } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "message":  { "mid": "…", "quick_reply": { "payload": "…" } } }
{ "sender": { "id": "…" }, "timestamp": 1786003200000, "message":  { "mid": "…", "is_deleted": true } }
```

Correlation checks, run against the database after each:

| Signal | Expected local effect |
|---|---|
| `read.mid` | `dm_message.seen_at` set on the **outbound** row with that `instagram_message_id`, and `dm_recovery_reminder.seen_at` set where `instagram_gate_message_id` matches |
| `reaction` with `action: "react"` | `reacted_at` **and** the shared `engaged_at` / `first_engagement_kind` set |
| `postback` | `postback_at` **and** the shared `engaged_at` / `first_engagement_kind` set |
| inbound message | `replied_at` and `engaged_at` for that person's unfinished rows |
| deletion | `dm_message.deleted_at` set; **no** new engagement invented |

Only `action: "react"` counts as engagement. `unreact` deliberately does nothing —
taking an emoji back does not un-prove that the DM was opened — and an unknown or
missing action records nothing at all.

**Replay:** send the same signal twice. Evidence keeps the **earliest** provider
timestamp and the earliest receipt time, so a duplicate must leave the stored
values unchanged. **Signature:** a request with a bad `X-Hub-Signature-256` must
be rejected before dispatch; the server acknowledges valid requests with 200
*before* processing, which is what stops Meta retry storms.

## Enabling the settings-blocked fallback

`DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES` **starts empty, and should stay empty**
until a real structured Meta response has been captured **and** its controlled
verification record has been activated. An empty allowlist means no automatic
settings fallback ever fires — which is the safe default, because that copy tells
someone their own message-request settings blocked a DM.

QA-17 uses two independent gates. The environment allowlist is the operator arming
layer. The versioned `settings_blocked_verification` registry is the evidence layer.
Both must contain the same exact numeric code/subcode, and the registry record must be
active, unretired, and inside its validity window. Missing, stale, retired, malformed,
or mismatched evidence creates no public fallback on either the first-send handler or
the retry worker.

### Controlled verification procedure

This procedure contacts a real controlled Meta account. Do not run it without the
test-account credentials, an approved test window, and explicit authorization from the
account owner. This repository work did **not** run it and did not contact Meta.

1. Use a sandbox/test Instagram professional account and a separate controlled recipient.
   Create a fresh test comment inside Meta's private-reply eligibility window. Confirm
   the comment is present, has not already received a private reply, and is otherwise
   eligible before changing the recipient's message-request setting.
2. Reproduce the settings rejection on the first-send path. Confirm Meta rejected the
   request; do not infer rejection from a timeout, missing response, or Business Suite UI.
3. Preserve the raw response only in the approved restricted evidence store. Create a
   separate sanitized JSON package containing: numeric Graph code/subcode, HTTP status,
   semantic category `settings_blocked`, API version, controlled test-case identifier,
   verification time, and the fact that Meta did not accept the send. Remove tokens,
   URLs, request/response bodies, trace IDs, account IDs, usernames, comment text, DM
   text, media IDs, and personal identifiers.
4. Have a second owner check the sanitized package against the restricted original.
   Hash the sanitized file with SHA-256 and record its approved internal reference. The
   application registry accepts only a lowercase 64-character SHA-256 value.
5. Create a new **inactive** registry row with a unique immutable version, exact numeric
   signature, verification/expiry timestamps, verifier identity, controlled context,
   API version, sanitized evidence reference/hash, and semantic category. Use a short,
   explicit validity window so an API/version change forces reverification. Never edit
   the evidence fields later; create a new version instead.
6. Deploy with the allowlist still empty and confirm the admin dashboard shows the new
   record as `inactive`. Stale and retired records deliberately have no Activate control.
7. Activate the record from the owner dashboard (or the authenticated
   `POST /api/recovery-reminders/settings-verifications/{id}/activate` endpoint). Then
   add only that exact `code:subcode` pair to
   `DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES` and redeploy. Activation and retirement are
   audited; only one version per exact signature can be active.
8. Repeat the controlled rejection through the first-send path and confirm one reminder
   carries the exact registry ID/version, code/subcode, classification time, sanitized
   evidence reference, and hash. Exact replay must retain those original values.
9. Exercise the queued retry path with a controlled queued gate and confirm it records
   the same evidence contract. Retire the registry record immediately if either path
   differs, if the API version changes, or if the signature is no longer unambiguous.
10. Clean up controlled comments/messages according to the test-account policy. Retain
    the sanitized evidence package and audit record; do not copy the restricted raw
    response into this repository, logs, API, dashboard, or application database.

Before any activation, verify these classification properties:

1. Confirm Meta **rejected** the private-reply request rather than accepting it.
2. Capture only the numeric `graphCode` and `graphSubcode` through `describeGraphError`.
3. Confirm it is not a rate-limit signature: HTTP status is not `429`, and
   `graphCode` is not `4`, `17`, `32`, or `613`. Those are the only rate-limit
   matches the classifier makes — it never matches on a subcode.
4. Confirm an active, unexpired registry version exists for the exact pair before adding
   the pair to the environment variable.
5. Redeploy and audit the first immediate fallback row in the dashboard. Its evidence
   state must be `current`; `stale`, `retired`, and `missing` are release blockers.

Malformed entries are rejected at startup rather than silently ignored, so a typo
fails the deploy instead of quietly disarming the fallback.

> **Do not add `100:2534025`.** That subcode belongs to error code 100, "the
> comment is invalid for a private reply", which also covers a deleted comment, a
> comment older than seven days, and one already replied to. Allowlisting it
> would tell people their message-request settings blocked a DM when none of that
> applies to them.
>
> **This does not contradict the opening section.** There, `100:2534025` is
> described as our quota symptom — that is a claim about the *cause* of the
> volume we see, established from how the rate tracks traffic. Here the claim is
> about *classification*: the subcode itself is not evidence of a rate limit,
> because the identical code and subcode arrive for a deleted or expired comment,
> where retrying is pointless and where "your settings blocked this" would be
> false. Raising the quota is the right fix; branching on the subcode is not.
>
> Note also that the implementation plan's Task 3 and Task 7 describe `2534025`
> as a rate-limit subcode. That is wrong, and the code deliberately does not
> follow it: rate limiting is matched by HTTP status `429` or error code `4`,
> `17`, `32`, or `613` only — never by a bare subcode.

Never classify by error message text, and never by the Business Suite gray
warning.

## Timing-experiment launch sequence

Use the complete
[`dm-recovery-timing-experiment-runbook.md`](dm-recovery-timing-experiment-runbook.md).
In summary: deploy the additive schema and compatible code while v1 remains
configured, prove the real-Postgres contracts with zero skips, verify Meta
signals, then change the version and 42-day maximum window at one recorded
cutover instant. V2 uses a fixed 45% two-hour, 45% six-hour, and 10%
no-reminder split. It does not use the legacy delay or holdout settings.

Do not inspect completion outcomes at the blinded day-28 and day-35 enrollment
checks. Close enrollment when both treatment arms have 1,700 matured followers,
or at day 42 regardless, then wait 48 hours before full-range analysis. Owner
review is required before any rollout, and
`DM_RECOVERY_POST_EXPERIMENT_ENABLED` must remain false for v2.

A settings-blocked fallback remains eligible immediately and is excluded from
the timing experiment. If its allowlist is populated, audit it from the first
minute using the controlled-verification procedure above.

## Rollback

**There are two switches, and one does not stop the other.**

`DM_RECOVERY_ENABLED=false` stops public comments. It does **not** stop the
origin enrichment worker, which runs on `DM_RECOVERY_ORIGIN_LLM_ENABLED` and
keeps calling Gemini every two minutes. To stop everything, clear both.

Set `DM_RECOVERY_ENABLED=false` and redeploy or restart. That stops the sending
half:

- Ingestion and persistence continue; evidence keeps accruing.
- No new public sends occur.
- Pending rows do **not** expire. Their v2 two-hour or six-hour eligibility is
  frozen from Meta acceptance, so an overdue row remains pending if the switch
  is later restored. Document the interruption and resulting lateness before
  resuming the same experiment version.
- Instagram comments already posted are untouched. Nothing is deleted.
- **Do not reverse the migration.** It is additive and the dashboard reads it.

## Incidents

### The circuit is open

Check the `attention` view and `/api/recovery-reminders/metrics` → `health`.
Five of the six reasons clear themselves after three consecutive healthy
evaluations: `webhook_signal_gap`, `backlog_anomaly`, `public_failure_rate`,
`hourly_cap`, `database_failures`.

`auth_or_permission` is **latched** and never auto-clears — a worker cannot
verify that credentials were fixed. First validate or rotate the token and
confirm permissions using the verification steps above. Then reset the singleton
row through the trusted database console:

```sql
UPDATE "dm_recovery_control"
SET "circuit_open" = false,
    "reason" = NULL,
    "reset_at" = NOW(),
    "reset_by" = 'owner_after_meta_verification'
WHERE "id" = 1 AND "circuit_open" = true;
```

Leave batching and caps in place afterwards. The worker re-evaluates every
overdue row and sends gradually rather than in a burst.

### What to watch

| Signal | Where | Healthy |
|---|---|---|
| Queue depth and oldest eligibility | `/counts` → `ready` | small, not growing |
| Duplicate attempts | metrics → `duplicateAttempts` | near zero |
| Cooldown suppressions | metrics → `cooldownSuppressions` | expected, not dominant |
| Stale leases | metrics → `staleLeases` | zero outside restarts |
| Public failures | metrics → `failed` | near zero |
| Uncertain outcomes | metrics → `uncertain`, `attention` view | reviewed, not accumulating |
| `send_uncertain` recovery rows | `attention` view | each one reviewed by hand; the send may or may not have posted, so it is never retried automatically |
| `send_uncertain` **gate queue** rows | Automation health → "Needs review" | normally zero. These are a different table from the row above and have no reviewer of their own — see below |
| Delayed webhooks | metrics → `delayedPreSendSignalFalsePositives` | low; high means we comment on people who had already read |
| Signal coverage | metrics → `readEventCoverage` | high; a fall means the subscription may have lapsed |

## Running the database contract tests

There is **no CI in this repository**. The schema, RLS, constraint, and
claim-concurrency contracts are gated behind an environment variable, and a
skipped test looks exactly like a passing one in the summary line. Run them
before any release that touches the schema:

```bash
docker run -d --name insta-pg-contract -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insta_contract -p 55432:5432 postgres:16-alpine
```

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" npm test
```

A correct run reports **0 skipped**. Any skipped count means the contracts did
not execute.

## Historical-recovery audience classification

The expanded historical-recovery policy is versioned as `llm_v3` and applies
only to **historical public-comment recovery**. It does not change keyword
matching, guide delivery, ordinary comment automation, or prospective DM
recovery.

This is an operational classification based only on the available Instagram
username and display name. It is not a claim of verified geography, nationality,
or ethnicity. Free-text Gemini evidence is audit-only and never authorizes or
blocks a send.

| Stored segment | Eligibility for historical recovery |
|---|---|
| `western` | Allow; it is an existing, separate population and is not duplicated by the expanded rollout. |
| `other` | Allow in its own expanded campaign. |
| `unknown_cue` | Allow in its own expanded campaign. |
| `unknown_generic` | Allow in its own expanded campaign. |
| `unknown_no_name` | Allow in its own expanded campaign. |
| `south_asian` | Block at both `high` and `low` confidence. |

Both normalized identity fields empty produce `unknown_no_name`
deterministically; Gemini is not called. For every other account, a current,
structurally valid `llm_v3` method, origin, confidence, and segment are
required. Missing, stale, malformed, incomplete, or contradictory provenance
defers the historical send and never default-allows it.

**What is withheld is the unsolicited historical public comment, never the
guide.** Anyone who comments a keyword continues through the ordinary gate and
guide flow. The classifier only participates in the separately approved
historical-recovery policy.

### Switches, and the order to use them

| Variable | Default | Effect |
|---|---|---|
| `DM_RECOVERY_ORIGIN_LLM_ENABLED` | `false` | Runs the enrichment worker and populates current `llm_v3` origin provenance and `audience_segment`. It sends nothing by itself. |
| `DM_RECOVERY_WESTERN_ONLY` | `false` | Frozen on historical campaign manifests for compatibility/audit; it does not weaken the current segment authorization rule. |
| `DM_RECOVERY_ORIGIN_BATCH_SIZE` | `25` | Users per Gemini call. |
| `DM_RECOVERY_ORIGIN_INTERVAL_MS` | `120000` | Worker pacing. |

Enable enrichment by itself, let it reclassify the targeted historical pool to
`llm_v3`, and audit the structured method/segment/confidence counts before any
expanded campaign is selected. Expanded sending stays disabled until that audit
passes; the full sequence is in
`docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md`.

### Production dependency

**`GEMINI_API_KEY` must be set in the deployed API environment.** A local `.env`
value does not propagate. Without it the worker no-ops and targeted users remain
stale or incomplete, which is an audit failure rather than permission to send.
Spend is bounded by the existing `GEMINI_DAILY_BUDGET_USD`.

### What this is, and is not

It is a **name-based operational proxy, not geography.** Meta exposes no
per-user country. The approved policy does not treat a missing or low-confidence
classification as permission by default: `south_asian` is blocked at either
confidence, all five listed non-South-Asian segments are eligible, and every
missing/stale/malformed/inconsistent result defers.

Verdicts are stored with their method and segment and are retired when the name
or username they were derived from changes. Selection freezes that provenance on
the candidate, while each send rechecks current provenance and repeats the
critical authorization under the dispatch lock.

## Known follow-up

`gate_queue` has no unique index on `comment_id`, and production may hold
duplicate rows created before comment webhooks became idempotent. Adding the
index requires inspecting and cleaning that data first; it is deliberately not
part of the recovery work.

### `send_uncertain` gate rows have no reviewer of their own

A gate send whose outcome is ambiguous is parked as `send_uncertain` and **never
retried** — Meta may already have delivered the DM, and a retry would send it
twice. That decision stands.

The consequence is that the row is terminal by accident. `runGateQueueTick` only
ever claims `pending`, and nothing else in the codebase reads gate-queue
`send_uncertain`: `conversations.routes.ts` filters `pending`, `statsService`
counted only `pending` and `exhausted`, and `conversationService` updates only
`pending`. So the person may never have received their gate, with nothing saying
so.

Both creators — `reconcileStaleSendingClaims` and the `commentHandler` uncertain
path — schedule a `tracking_unavailable` recovery row as the intended review
surface, and that row *is* reachable from the `attention` view. But the mirror is
best-effort: `reconcileStaleSendingClaims` skips it when the conversation or
keyword is missing, and both call sites swallow a scheduling failure. When the
mirror is absent, the gate row is invisible.

**What was done instead of a second reviewer UI:** `statsService` now counts
`send_uncertain`, and Automation health surfaces it as "Needs review" only when
non-zero. That makes a mirror-less row impossible to miss without building a
review queue for a state that should read zero almost always. A dedicated
reviewer is only worth building if that count starts moving.
