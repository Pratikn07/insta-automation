/**
 * The final safety check, immediately before a public comment is posted.
 *
 * A candidate is a snapshot taken at selection, possibly days earlier. Between then
 * and now the world moves: the person may have replied, the comment may have been
 * deleted, the origin verdict may have been rewritten. §34 requires these to be
 * rechecked rather than trusted, because the cost of being wrong is a public comment
 * that cannot be recalled.
 *
 * Pure function over freshly-read facts, so every branch is testable without a
 * database or the Graph API.
 */

import {
  evaluateHistoricalAudience,
  evaluateHistoricalOrigin,
} from "./historicalRecoveryOriginPolicy.js";

/**
 * What we learned by reading the source comment just now (QA-09).
 *
 * Three states, not two, because "Meta told us it is gone" and "we could not ask Meta"
 * lead to opposite actions and were previously collapsed into one boolean. The worker
 * caught every read failure and reported "not there", so a timeout, a rate limit, a
 * 5xx, or an expired token permanently suppressed a candidate whose comment was fine.
 *
 *   - `visible`   — resolved, not hidden. Safe to reply.
 *   - `hidden`    — resolved but hidden. Suppress: a reply nobody would see would still
 *                   be counted as a send and would pollute the experiment.
 *   - `missing`   — Meta answered that the object is not there. Suppress, terminally.
 *   - `auth`      — credentials or permissions. Defer AND open the shared circuit.
 *   - `unknown`   — we could not ask. Defer. Never terminal.
 */
export type SourceCommentState =
  | "visible"
  | "hidden"
  | "missing"
  | "auth"
  | "unknown"
  | "source_set_exhausted";

export type RecheckFacts = {
  /**
   * The result of reading the source comment. Replaces the old
   * `commentStillExists` / `commentHidden` pair, whose `false` could mean either
   * "deleted" or "the network failed" — and was read as the former.
   */
  sourceComment: SourceCommentState;
  /** Any inbound message since selection — the premise no longer holds. */
  repliedSinceSelection: boolean;
  /** Completed the guide since selection, by any route. */
  completedSinceSelection: boolean;
  /** A public recovery reached them since selection (prospective or historical). */
  contactedSinceSelection: boolean;
  /** Live origin verdict, which may have been rewritten since selection. */
  audienceOrigin: string | null;
  /** Confidence belongs to the persisted Gemini verdict and is forwarded unchanged. */
  audienceOriginConfidence: string | null;
  /** Classifier method/version for the live verdict; anything else is stale. */
  audienceOriginMethod: string | null;
  /** Current persisted structural segment; free-text evidence is never consulted. */
  audienceSegment: string | null;
  /** Segment frozen into the immutable candidate snapshot, null for legacy rows. */
  frozenCandidateAudienceSegment: string | null;
  /** Segment frozen into the immutable campaign manifest, null for legacy rows. */
  frozenCampaignAudienceSegment: string | null;
  /**
   * Retained for the frozen campaign manifest and caller compatibility. It cannot
   * weaken either legacy fail-closed authorization or exact expanded-segment matching.
   */
  westernOnly: boolean;
  /** Campaign still running — a pause between claim and send must stop the send. */
  campaignRunning: boolean;
  /** Hourly cap headroom for this campaign. */
  sentThisHour: number;
  hourlyCap: number;
  /**
   * Daily headroom. Enforced as well as the hourly cap, because the hourly one alone
   * permits 24x its own value per day: at 3/hour a "daily cap 10" campaign would post
   * 72 comments, which is not the conservative launch the caps are meant to describe.
   */
  sentToday: number;
  dailyCap: number;
};

export type RecheckSuppressionReason =
  | "source_comment_deleted"
  | "source_comment_hidden"
  | "source_set_exhausted"
  | "replied_since_selection"
  | "completed_since_selection"
  | "contacted_since_selection"
  | "audience_south_asian";

export type RecheckDeferralReason =
  | "campaign_not_running"
  | "daily_cap_reached"
  | "hourly_cap_reached"
  | "source_read_auth_failed"
  | "source_read_failed"
  | "origin_not_current_gemini"
  | "audience_segment_changed";

export type RecheckDecision =
  | { kind: "send" }
  | { kind: "suppress"; reason: RecheckSuppressionReason }
  /** Not this person's fault — try again on a later tick. */
  | { kind: "defer"; reason: RecheckDeferralReason };

export type LiveAudienceAuthorizationDecision =
  | { kind: "allow" }
  | { kind: "suppress"; reason: "audience_south_asian" }
  | {
      kind: "defer";
      reason: "origin_not_current_gemini" | "audience_segment_changed";
    };

/**
 * Authorize legacy and expanded snapshots without letting one weaken the other.
 *
 * Legacy campaigns have no campaign segment and retain their current fail-closed
 * origin-only compatibility rule; selectors may still persist a candidate's audit
 * segment on those rows. Once the campaign freezes a segment, the candidate must match
 * it and both must match a structurally valid live classification. South Asian is
 * terminal even when it represents drift; every other malformed or changed expanded
 * classification is recoverable after reclassification and therefore defers.
 */
export function authorizeLiveHistoricalAudience(input: {
  audienceSegment: string | null;
  audienceOrigin: string | null;
  audienceOriginConfidence: string | null;
  audienceOriginMethod: string | null;
  frozenCandidateAudienceSegment: string | null;
  frozenCampaignAudienceSegment: string | null;
}): LiveAudienceAuthorizationDecision {
  const isExpanded = input.frozenCampaignAudienceSegment !== null;
  if (!isExpanded) {
    const legacy = evaluateHistoricalOrigin({
      origin: input.audienceOrigin,
      confidence: input.audienceOriginConfidence,
      method: input.audienceOriginMethod,
    });
    if (legacy.kind === "stale") return { kind: "defer", reason: legacy.reason };
    if (legacy.kind === "block") return { kind: "suppress", reason: legacy.reason };
    return { kind: "allow" };
  }

  const live = evaluateHistoricalAudience({
    segment: input.audienceSegment,
    origin: input.audienceOrigin,
    confidence: input.audienceOriginConfidence,
    method: input.audienceOriginMethod,
  });
  if (live.kind === "block") return { kind: "suppress", reason: live.reason };
  if (
    live.kind === "defer"
    || input.frozenCandidateAudienceSegment !== input.frozenCampaignAudienceSegment
    || input.audienceSegment !== input.frozenCampaignAudienceSegment
  ) {
    return { kind: "defer", reason: "audience_segment_changed" };
  }
  return { kind: "allow" };
}

export function recheckBeforeSend(facts: RecheckFacts): RecheckDecision {
  // Campaign state first: a pause is the owner's emergency stop, and it must take
  // effect even for a row already claimed this tick.
  if (!facts.campaignRunning) {
    return { kind: "defer", reason: "campaign_not_running" };
  }

  // Caps are rate limits, not judgements about this person, so the row is deferred
  // rather than suppressed and will send on a later tick.
  //
  // Both are checked. The hourly cap alone allows 24x its value per day, so a
  // campaign configured for 10 a day would have posted 72.
  if (facts.sentToday >= facts.dailyCap) {
    return { kind: "defer", reason: "daily_cap_reached" };
  }
  if (facts.sentThisHour >= facts.hourlyCap) {
    return { kind: "defer", reason: "hourly_cap_reached" };
  }

  // Replying to a deleted comment fails at the API; replying to a HIDDEN one
  // succeeds silently and nobody sees it, which is worse — it would count as a send
  // and pollute the experiment with a message that was never visible.
  //
  // Only a definitive answer from Meta is terminal. `auth` and `unknown` defer, because
  // suppressing costs the candidate permanently while deferring costs one tick — and
  // the failures in that bucket (timeout, 429, 5xx, expired token) say nothing at all
  // about whether the comment is still there.
  if (facts.sourceComment === "missing") {
    return { kind: "suppress", reason: "source_comment_deleted" };
  }
  if (facts.sourceComment === "hidden") {
    return { kind: "suppress", reason: "source_comment_hidden" };
  }
  if (facts.sourceComment === "source_set_exhausted") {
    return { kind: "suppress", reason: "source_set_exhausted" };
  }
  if (facts.sourceComment === "auth") {
    return { kind: "defer", reason: "source_read_auth_failed" };
  }
  if (facts.sourceComment === "unknown") {
    return { kind: "defer", reason: "source_read_failed" };
  }

  // The reminder says "I don't think my DM reached you". Any of these makes that
  // false, and saying it anyway would be both wrong and visibly careless.
  if (facts.repliedSinceSelection) {
    return { kind: "suppress", reason: "replied_since_selection" };
  }
  if (facts.completedSinceSelection) {
    return { kind: "suppress", reason: "completed_since_selection" };
  }
  if (facts.contactedSinceSelection) {
    return { kind: "suppress", reason: "contacted_since_selection" };
  }

  // Historical public replies always require fresh structural classification.
  // `westernOnly` is frozen for compatibility and never relaxes this gate. Expanded
  // campaigns require exact live/candidate/campaign segment equality; legacy campaigns
  // keep the current fail-closed origin-only policy.
  const audienceDecision = authorizeLiveHistoricalAudience({
    audienceSegment: facts.audienceSegment,
    audienceOrigin: facts.audienceOrigin,
    audienceOriginConfidence: facts.audienceOriginConfidence,
    audienceOriginMethod: facts.audienceOriginMethod,
    frozenCandidateAudienceSegment: facts.frozenCandidateAudienceSegment,
    frozenCampaignAudienceSegment: facts.frozenCampaignAudienceSegment,
  });
  if (audienceDecision.kind === "defer") {
    return { kind: "defer", reason: audienceDecision.reason };
  }
  if (audienceDecision.kind === "suppress") {
    return { kind: "suppress", reason: audienceDecision.reason };
  }

  return { kind: "send" };
}
