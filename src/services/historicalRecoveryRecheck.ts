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

export type RecheckFacts = {
  /** Did the source comment still resolve just now? */
  commentStillExists: boolean;
  /** Is it visible? A hidden comment means a reply nobody will see. */
  commentHidden: boolean;
  /** Any inbound message since selection — the premise no longer holds. */
  repliedSinceSelection: boolean;
  /** Completed the guide since selection, by any route. */
  completedSinceSelection: boolean;
  /** A public recovery reached them since selection (prospective or historical). */
  contactedSinceSelection: boolean;
  /** Live origin verdict, which may have been rewritten since selection. */
  audienceOrigin: string | null;
  westernOnly: boolean;
  /** Campaign still running — a pause between claim and send must stop the send. */
  campaignRunning: boolean;
  /** Hourly cap headroom for this campaign. */
  sentThisHour: number;
  hourlyCap: number;
};

export type RecheckDecision =
  | { kind: "send" }
  | { kind: "suppress"; reason: string }
  /** Not this person's fault — try again on a later tick. */
  | { kind: "defer"; reason: string };

export function recheckBeforeSend(facts: RecheckFacts): RecheckDecision {
  // Campaign state first: a pause is the owner's emergency stop, and it must take
  // effect even for a row already claimed this tick.
  if (!facts.campaignRunning) {
    return { kind: "defer", reason: "campaign_not_running" };
  }

  // The cap is a rate limit, not a judgement about this person, so the row is
  // deferred rather than suppressed and will send on a later tick.
  if (facts.sentThisHour >= facts.hourlyCap) {
    return { kind: "defer", reason: "hourly_cap_reached" };
  }

  // Replying to a deleted comment fails at the API; replying to a HIDDEN one
  // succeeds silently and nobody sees it, which is worse — it would count as a send
  // and pollute the experiment with a message that was never visible.
  if (!facts.commentStillExists) {
    return { kind: "suppress", reason: "source_comment_deleted" };
  }
  if (facts.commentHidden) {
    return { kind: "suppress", reason: "source_comment_hidden" };
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

  // Re-applied on the LIVE verdict, not the snapshot: a verdict is retired when the
  // name it came from changes, so someone classified in-market at selection can read
  // out-of-market now. Withholds at either confidence, matching dmRecoveryPolicy.
  if (facts.westernOnly && facts.audienceOrigin === "south_asian") {
    return { kind: "suppress", reason: "audience_out_of_market" };
  }

  return { kind: "send" };
}
