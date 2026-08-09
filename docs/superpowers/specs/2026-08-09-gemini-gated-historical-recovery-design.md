# Gemini-Gated Historical Recovery Design

**Date:** 2026-08-09
**Status:** Approved for implementation planning

## Context

The current historical-recovery campaign was paused after 18 sends. Although Gemini origin classification was enabled in production, the campaign admitted legacy user records whose `originMethod` was `name`. Those records could remain `unknown` with low confidence and still pass historical selection because the existing rule excluded only users stored as `south_asian`.

Enabling Gemini therefore did not guarantee that every historical recipient had been classified by the current Gemini prompt. Historical recovery must fail closed unless a current Gemini classification explicitly identifies the user as `us_western`.

## Goals

- Require a classification produced by the current Gemini prompt version before any historical public recovery reply can be sent.
- Allow `us_western` classifications at either high or low confidence.
- Exclude `south_asian` classifications at both high and low confidence.
- Exclude `unknown` and `other` classifications.
- Downgrade contradictory `us_western` classifications whose evidence says the handle is generic or has no meaningful cue.
- Preserve the 50% control holdout, one-recipient batches, a 10-per-hour send cap, and the practical 1,000-per-day global cap.
- Make the classification method auditable in each frozen campaign candidate.

## Non-goals

- This design does not claim to determine a person's actual geography or identity. A username or display name is only a targeting proxy.
- This design does not change normal keyword-triggered DM guide delivery.
- This design does not change prospective recovery behavior unless that flow already shares the same fail-closed policy and is covered by its tests.
- The existing paused campaign will not be resumed or modified into compliance. It will be replaced by a clean campaign after reclassification.

## Design

### 1. Normalize Gemini classifications

The current classifier method is the exported prompt version, currently `llm_v1`. The classifier will normalize a Gemini `us_western` response to `unknown` with low confidence when its evidence is contradictory—for example, evidence containing phrases such as `generic handle`, `no cue`, or `no strong cue`.

This normalization belongs in the origin-classification service so selection and sending consume one canonical verdict. It must be deterministic and covered by unit tests.

### 2. Reclassify stale and legacy users

The origin-enrichment worker will treat a user as needing classification when either:

- `originCheckedAt` is null; or
- `originMethod` does not equal the current Gemini prompt version.

This causes legacy `name` classifications to be replaced by current Gemini results while preserving existing worker batch and budget safeguards.

### 3. Select only current Gemini `us_western` users

Historical campaign selection will require all of the following:

- `originMethod` equals the current Gemini prompt version;
- `audienceOrigin` equals `us_western`; and
- `audienceOriginConfidence` is either `high` or `low`.

Selection will explicitly exclude and count these reasons:

- `origin_not_current_gemini`
- `audience_south_asian`
- `audience_unknown`
- `audience_other`

The frozen `RecoveryCandidate` snapshot will include `audienceOriginMethod` in addition to origin and confidence. The snapshot hash and approval verification will cover this field so a candidate cannot become eligible through later mutation or omitted provenance.

### 4. Recheck eligibility immediately before sending

The worker will fail closed by querying the user's current origin, confidence, and method before each provider call.

- A missing or stale method is deferred without sending so enrichment can process it.
- A current `south_asian`, `unknown`, or `other` result is suppressed without sending.
- Only a current Gemini `us_western` result may send; both high and low confidence are accepted.

No Instagram Graph API write may occur for a stale or disallowed classification. Existing shared circuit breakers, provider idempotency, hourly limits, and daily limits remain in force.

### 5. Replace the frozen campaign safely

The current campaign remains paused while the change is implemented and deployed. Once the new code is live and legacy users have been reclassified:

1. Preview a new campaign and audit its method, origin, confidence, treatment, and holdout counts.
2. Cancel the old paused campaign; never resume it.
3. Create the replacement with a 50% holdout, batch size 1, 10 sends per hour, and 1,000 sends per day.
4. Approve the replacement only after confirming every selected candidate uses the current Gemini method and is `us_western`.
5. Verify the first provider response and visible Instagram comment before relying on the automatic scheduler.

## Data model and migration

Add a nullable `audience_origin_method` field to `RecoveryCandidate`. Existing candidate rows remain null. New campaign snapshots populate it from `IgUser.originMethod`.

The migration is additive and does not require destructive backfill. Snapshot serialization, hashing, approval verification, API responses, and candidate detail views must include the method for new campaigns.

## Observability

Campaign preview and reporting must expose counts grouped by classification method, origin, and confidence. Worker outcomes must distinguish stale-method deferrals from origin-based suppressions. Existing provider result IDs and failure classifications remain available for send auditing.

## Test strategy

Tests will be written before implementation and must cover:

- Contradictory low-confidence `us_western` evidence is normalized to `unknown`.
- Legacy `name` records are eligible for reclassification.
- Selection admits current Gemini `us_western` at both high and low confidence.
- Selection rejects `south_asian` at both high and low confidence.
- Selection rejects `unknown`, `other`, stale methods, and missing methods.
- Candidate snapshot verification detects a changed or omitted origin method.
- The send worker defers stale methods and suppresses every disallowed origin.
- Integration tests prove no Instagram Graph API POST occurs for stale or disallowed candidates.
- Existing holdout, idempotency, hourly-cap, and daily-cap behavior remains intact.

## Deployment and rollback

Deploy with no historical campaign running. Run migrations, confirm service health, and allow enrichment to process stale classifications before creating the replacement campaign.

If production behavior is unexpected, pause or cancel the new campaign and set `DM_RECOVERY_HISTORICAL_ENABLED=false`. The schema change is additive and can remain in place during rollback.

## Acceptance criteria

- The old campaign remains paused until it is cancelled and is never resumed.
- The replacement campaign contains zero candidates with a legacy, missing, or stale origin method.
- Every selected replacement candidate has the current Gemini method and normalized origin `us_western`.
- Both high- and low-confidence `south_asian` users are excluded.
- `unknown` and `other` users are excluded.
- The replacement campaign has the intended 50% holdout and 10-per-hour limit.
- The first send has a successful provider result ID, is visible on Instagram, and introduces no uncertain or failed send outcome before automatic processing continues.
