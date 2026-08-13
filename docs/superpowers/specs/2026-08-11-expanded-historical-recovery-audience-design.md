# Expanded Historical-Recovery Audience Design

**Date:** 2026-08-11

**Status:** Approved in conversation; awaiting written-spec review

**Scope:** Historical public-comment recovery audience classification and staged dispatch

## Context

Historical recovery currently authorizes a public comment only for a user with a current Gemini verdict of `us_western`. It blocks `south_asian`, `other`, and `unknown`. Production analysis showed that this policy is overly broad:

- `other` includes clearly non-South-Asian users, including Western European names that the current four-way taxonomy places inconsistently.
- `unknown` combines meaningfully different cases: ambiguous cultural cues, generic handles, and users with neither a username nor a display name.
- A missing name is an absence of evidence, not evidence that a user is South Asian.

The owner-approved policy is now: **a current positive South Asian classification is the only audience-origin reason to block historical recovery.** Both high- and low-confidence South Asian verdicts are blocked. All specified non-South-Asian and unknown segments may be contacted, including users with no username and no display name.

This policy applies only to historical recovery. It does not change guide delivery, keyword matching, ordinary comment automation, or prospective DM-recovery policy unless a later design explicitly does so.

## Goals

1. Replace the ambiguous `other` and `unknown` authorization decision with explicit, auditable audience segments.
2. Block current Gemini `south_asian` verdicts at both confidence levels.
3. Allow Western, other, unknown-with-cue, generic-handle, and no-name users in separate historical campaigns.
4. Run eligible campaigns continuously without an observation pause.
5. Enforce at most 10 historical public-recovery dispatch starts across the four newly expanded cohorts in any rolling hour.
6. Preserve all existing per-person, source-comment, journey, health, circuit-breaker, and audit protections.

## Non-goals

- Proving a user's nationality, residence, ethnicity, or actual geography from Instagram identity strings.
- Relabelling no-name or generic-handle users as Western.
- Relaxing the block for any South Asian verdict, including low confidence.
- Sending to a user after they replied, completed the guide, received another recovery contact, opted out, or became otherwise ineligible.
- Rewriting the completed experiment's historical control rows.
- Adding a manual review queue or a 24-hour observation checkpoint.

## Audience Model

### Stored segment

Add a versioned structured `audienceSegment` with these values:

| Segment | Meaning | Historical eligibility |
|---|---|---|
| `western` | Current Gemini positively identifies US/UK/Canada/Australia/Western Europe | Allow |
| `other` | Current Gemini positively identifies a non-South-Asian cue outside `western` | Allow |
| `unknown_cue` | A meaningful cultural cue exists, but Gemini cannot place it reliably | Allow |
| `unknown_generic` | At least one identity string exists, but it is generic, numeric, emoji-only, too short, or otherwise has no meaningful cue | Allow |
| `unknown_no_name` | Both normalized username and display name are empty | Allow |
| `south_asian` | Current Gemini identifies a South Asian cue, at high or low confidence | Block |

`audienceSegment` is an operational classification based only on the available username and display name. It must not be presented as verified demographic or location data.

### Deterministic no-name handling

When both normalized username and display name are empty, assign `unknown_no_name` deterministically without asking Gemini to infer an origin. This avoids paying for an empty model request and prevents the model from manufacturing a cultural label from no evidence.

### Structured Gemini response

For accounts with at least one identity string, use a new classifier method version and require structured fields sufficient to derive one segment without inspecting free-text evidence. The response must retain:

- origin family;
- high or low confidence;
- structured cue assessment;
- structured cue kind distinguishing a generic/no-cue identity from an ambiguous meaningful cue;
- short free-text evidence for audit only.

Free-text evidence must never authorize or block a send. Malformed, incomplete, failed, or stale classifier output is not an allowed segment and remains deferred until valid current classification succeeds.

### Authorization rule

Historical audience authorization becomes:

1. A missing or stale classifier method: defer.
2. A malformed segment/confidence/provenance combination: defer.
3. Segment `south_asian` at either confidence: block.
4. Any of the five approved non-South-Asian segments: allow.

The policy decision is evaluated during selection and again from live user data immediately before dispatch. The final locked authorization repeats the critical check before any Meta provider call.

## Campaign Structure

The already supported `western` population is not duplicated. The newly expanded population is selected into four separate campaigns:

1. `other`
2. `unknown_cue`
3. `unknown_generic`
4. `unknown_no_name`

Each campaign has a frozen, owner-approved manifest and its own outcome reporting. This preserves segment-level measurement even though there is no waiting checkpoint between campaigns.

All four campaigns start continuously after deployment, reclassification, manifest audit, and approval. There is no 20-person stage and no 24-hour observation pause.

The selection pipeline continues to enforce one candidate per person and excludes anyone with existing engagement, completion, previous public recovery, an inactive keyword, an unreachable recipient, a superseding journey, or no approved source comment.

## Pacing

The combined expanded rollout must not exceed **10 dispatch starts in any rolling hour across the four new campaigns**. Ten per campaign would violate the approved policy.

Implement this as a dedicated aggregate cohort cap enforced inside the shared, lock-protected dispatch reservation. It must count `sent`, `uncertain`, and currently reserved/in-flight dispatches for campaigns in the expanded rollout. The cap cannot rely on the worker's earlier advisory count.

Existing broader account-wide limits remain in force. If prospective recovery or another historical campaign consumes broader account capacity, the expanded campaigns wait; the new cohort cap does not grant additional account-wide throughput.

Each campaign uses:

- batch size `1`;
- campaign hourly cap no greater than `10`;
- daily cap `1,000`.

The daily cap is intentionally non-binding for this cohort under a 10/hour aggregate ceiling, while remaining finite and auditable.

## Immutable Selection and Audit

Persist the segment and classifier method on `IgUser`. Freeze the following on every `RecoveryCandidate`:

- `audienceSegment`;
- classifier method;
- origin family;
- confidence;
- existing source-comment manifest and selection facts.

Include the segment in the selection decision hash, fingerprint inputs where applicable, approval verification, candidate detail API, and campaign reports. Mutating a user's later classification must not alter an approved manifest; it can only cause the live pre-send check to defer or block it.

Campaign metadata must identify the expanded-rollout group so the aggregate cap can be enforced without inferring membership from names, free-text selection versions, or campaign IDs embedded in code.

## Dispatch Safeguards

Before each public comment, preserve or strengthen all current checks:

- campaign is approved and running;
- shared circuit is closed;
- campaign health inbox is fully captured;
- person has not sent an inbound message since selection;
- same-keyword journey has not completed since selection;
- no prior recovery dispatch has contacted the person;
- canonical intent and conversation aliases remain valid;
- keyword is still active;
- candidate's current classifier method and segment are valid;
- current segment is not `south_asian`;
- source comment is in the approved immutable source set and is currently visible;
- per-person cooldown, duplicate prevention, campaign caps, expanded-cohort cap, and global caps have capacity.

A source read failure defers. A definitively deleted or hidden source suppresses. An ambiguous Meta send remains `send_uncertain` and is never retried automatically.

## Health and Emergency Stop

Existing automatic campaign pauses remain active for complaints, opt-outs, blocks, negative replies, classifier anomalies, duplicate public replies, excessive public failures, uncertainty, and source unavailability.

Add one owner emergency action that pauses every currently running campaign belonging to the expanded rollout group. The action must be atomic from the owner's perspective: return which campaigns paused and surface any campaign that was already terminal or could not transition. It must never affect unrelated historical or prospective recovery campaigns.

Any complaint, opt-out, block, negative reply, or classifier anomaly associated with one expanded campaign also pauses all running campaigns in the same expanded rollout group. Rate-based source/provider health remains campaign-specific unless the shared circuit opens.

## Reporting

The admin API and Historical Recovery UI expose:

- frozen segment and current segment provenance;
- selected, pending, sent, suppressed, failed, uncertain, inbound, and completed counts by campaign;
- aggregate expanded-rollout sends in the current rolling hour;
- explicit exclusion/suppression reasons;
- whether an emergency group pause or health-triggered group pause is active.

No-name users display as `unknown_no_name`, never as Western and never as an inferred demographic.

## Data Flow

1. Normalize username and display name.
2. Assign `unknown_no_name` deterministically when both are empty; otherwise call the versioned Gemini classifier.
3. Validate the structured response and persist the segment with provenance using compare-and-set semantics.
4. Select four segment-specific draft campaigns from current valid classifications.
5. Audit counts and manifests, then approve and start all four without an observation delay.
6. On each tick, claim one due candidate and perform live advisory checks.
7. Under the shared dispatch lock, repeat critical identity, inbound, keyword, source, duplicate, and capacity authorization, including the aggregate 10/hour cap.
8. Post the existing recovery copy to the approved Instagram source comment.
9. Finalize the durable dispatch and update segment-specific attribution and health.

## Failure Handling

- Gemini unavailable, stale, malformed, or incomplete: defer; never default-allow.
- Current `south_asian`, high or low confidence: terminal audience suppression.
- Segment drift from an allowed snapshot to `south_asian`: suppress before dispatch.
- Segment drift to stale or malformed: defer pending valid reclassification.
- Aggregate cap reached: release/defer without consuming candidate state.
- Inbound or completion race: final locked authorization prevents the provider call.
- Meta source-read auth failure: open the shared circuit and stop sending.
- Meta send uncertainty: record uncertainty, do not retry, and apply existing health thresholds.
- Group health signal: pause all running campaigns in the expanded rollout group.

## Testing

### Pure policy and classifier tests

- Both high- and low-confidence `south_asian` map to `south_asian` and block.
- `western`, `other`, `unknown_cue`, `unknown_generic`, and `unknown_no_name` allow.
- Empty normalized identity deterministically yields `unknown_no_name` without a Gemini call.
- Generic, numeric, emoji-only, and too-short identities map to `unknown_generic` from structured fields.
- Meaningful but unplaceable cues map to `unknown_cue`.
- Free-text evidence cannot change a structured decision.
- Stale, missing, duplicate, malformed, or out-of-enum responses defer and cannot authorize.

### Selection and snapshot tests

- Each approved segment is selected only into its matching campaign.
- South Asian users of either confidence are recorded as exclusions.
- One person cannot appear twice within a campaign or across the four manifests.
- Segment and method changes invalidate snapshot verification.
- No-name users are auditable as `unknown_no_name` and never `western`.

### Database and concurrency tests

- Two or more expanded campaigns racing for the tenth rolling-hour slot cannot exceed ten combined reservations.
- In-flight and uncertain dispatches consume the aggregate ceiling correctly.
- Unrelated campaigns do not count against the dedicated expanded-cohort cap, but all sends still obey broader global account caps.
- An inbound, completion, keyword change, or segment change racing dispatch prevents unsafe posting.
- Group pause stops all expanded campaigns and leaves unrelated campaigns unchanged.

### Worker and API tests

- Every allowed segment reaches Meta only after final locked authorization.
- South Asian and malformed live classifications never call Meta.
- Existing source, retry, uncertainty, duplicate, and circuit behavior is preserved.
- Reporting returns campaign and aggregate segment metrics accurately.

## Production Rollout

1. Deploy schema and code with expanded sending disabled.
2. Run migrations and verify database constraints and indexes.
3. Reclassify the historical pool with the new method until no targeted user has stale or incomplete provenance.
4. Audit counts and representative examples for every segment, especially `other`, `unknown_cue`, and `unknown_no_name`.
5. Create four frozen campaign manifests and verify there are no cross-campaign duplicate people.
6. Verify all South Asian high/low users are excluded and all selected candidates belong to exactly one approved segment.
7. Approve and start all four campaigns without an observation pause.
8. Keep the aggregate cohort cap at 10/hour and daily cap at 1,000.
9. Verify the first successful comment in each non-empty campaign directly through Meta and monitor automated health/group-pause signals.

## Acceptance Criteria

- Only a current, valid `south_asian` segment blocks on audience origin; both confidence levels block.
- No-name users are eligible and stored as `unknown_no_name`.
- Generic and ambiguous unknowns are distinguishable and reported separately.
- The four newly expanded campaigns never exceed 10 combined dispatch starts in a rolling hour.
- No free-text Gemini evidence controls authorization.
- Every send is protected by live and final locked checks.
- One person cannot receive duplicate recovery comments across the expanded rollout.
- Negative safety signals can stop all four campaigns together.
- Existing campaign records and the completed control experiment remain immutable.
