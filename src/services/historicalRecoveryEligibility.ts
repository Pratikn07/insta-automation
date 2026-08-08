import { assignRecoveryCohort } from "./dmRecoveryPolicy.js";

/**
 * Who may be contacted by a historical recovery campaign — as pure functions.
 *
 * Separated from the query so §34/§35 can be tested exhaustively without a
 * database. Every rule here decides whether the account posts a PUBLIC comment
 * naming a real person, so a wrong `include` is visible to that person's followers
 * and cannot be recalled.
 */

/** Everything the decision needs, gathered per canonical intent. */
export type EligibilityFacts = {
  intentId: string;
  igUserId: string;
  /** The comment the reply would be posted on. Null means unusable. */
  commentId: string | null;
  /** `dm` journeys have no comment to reply to (§35). */
  triggerKind: string;
  commentAt: Date;
  /** Meta accepted the gate DM — the Phase 2 basis. */
  gateAccepted: boolean;
  /** The gate demonstrably never delivered — the Phase 1 basis. */
  gateExhausted: boolean;
  /**
   * The gate failed with "user cannot be found". 59 of 63 exhausted rows in this
   * data are exactly this: deleted or blocking accounts.
   */
  recipientUnreachable: boolean;
  /** An earlier public attempt whose outcome we cannot establish (§35). */
  ambiguousPriorSend: boolean;
  /** Any inbound reply, reaction, or read evidence at all (§35). */
  hasEngagementEvidence: boolean;
  /** Completed this keyword during or after the window (§34). */
  completedSameKeyword: boolean;
  /** A confirmed or in-flight public recovery already exists for this person. */
  priorPublicRecovery: boolean;
  /** A newer live journey that should own the request instead (§34). */
  supersededByNewerJourney: boolean;
  keywordActive: boolean;
  audienceOrigin: string | null;
  /** `DM_RECOVERY_WESTERN_ONLY`. When false the origin is ignored entirely. */
  westernOnly: boolean;
};

export type EligibilityDecision =
  | { kind: "include"; evidence: "gate_exhausted" | "gate_sent_no_read" }
  | { kind: "exclude"; reason: string };

/**
 * Apply §34 and §35 to one intent.
 *
 * Order matters: the cheapest and most absolute disqualifiers come first, so the
 * reported reason is the most informative one rather than whichever rule happened
 * to be checked. Exclusions are returned rather than thrown — the campaign report
 * needs to show WHY each excluded row was dropped (§37).
 */
export function decideEligibility(facts: EligibilityFacts): EligibilityDecision {
  // A DM-origin journey has no comment. Nothing to reply to, so this can never be
  // a candidate regardless of every other signal.
  if (facts.triggerKind === "dm") {
    return { kind: "exclude", reason: "dm_origin_no_comment" };
  }
  if (!facts.commentId) {
    return { kind: "exclude", reason: "no_source_comment" };
  }

  // Publicly apologising to a deleted account is the failure mode that makes this
  // feature look broken, and it is the single largest class in the confirmed-failure
  // cohort. Checked before anything else that could make the row look sendable.
  if (facts.recipientUnreachable) {
    return { kind: "exclude", reason: "recipient_unreachable" };
  }

  // Any sign the person engaged means the premise ("you never saw this") is false.
  if (facts.hasEngagementEvidence) {
    return { kind: "exclude", reason: "has_engagement_evidence" };
  }
  if (facts.completedSameKeyword) {
    return { kind: "exclude", reason: "already_completed_keyword" };
  }

  // Contacting someone twice publicly is the worst outcome here, so both a known
  // prior send and an UNKNOWN one exclude. Uncertainty is not permission.
  if (facts.priorPublicRecovery) {
    return { kind: "exclude", reason: "prior_public_recovery" };
  }
  if (facts.ambiguousPriorSend) {
    return { kind: "exclude", reason: "ambiguous_prior_send" };
  }

  if (facts.supersededByNewerJourney) {
    return { kind: "exclude", reason: "superseded_by_newer_journey" };
  }
  if (!facts.keywordActive) {
    return { kind: "exclude", reason: "keyword_inactive" };
  }

  // The Western-market rule, matching the prospective feature exactly: a
  // `south_asian` verdict withholds at EITHER confidence. Applied here at
  // selection, and rechecked before send because a verdict is retired when the
  // name it came from changes.
  if (facts.westernOnly && facts.audienceOrigin === "south_asian") {
    return { kind: "exclude", reason: "audience_out_of_market" };
  }

  // Evidence classification. `gate_exhausted` is the stronger claim — we know the
  // DM never arrived — so it wins when both are somehow true.
  if (facts.gateExhausted) {
    return { kind: "include", evidence: "gate_exhausted" };
  }
  if (facts.gateAccepted) {
    return { kind: "include", evidence: "gate_sent_no_read" };
  }

  // Neither basis. §34 requires positive evidence that a gate was accepted or
  // definitively failed; "we have no record" is not grounds to contact anybody.
  return { kind: "exclude", reason: "no_gate_evidence" };
}

/**
 * Split a decided pool into what a campaign may send, keeping a count per reason.
 *
 * `assertNoDuplicates` is deliberately a hard failure rather than a filter: the
 * pool measured zero duplicate person-keyword candidates, and if that ever stops
 * being true the right response is to stop and look, not to quietly drop rows.
 */
export function summarise(
  decisions: Array<{ facts: EligibilityFacts; decision: EligibilityDecision }>,
): {
  included: Array<{ facts: EligibilityFacts; evidence: string }>;
  excludedByReason: Map<string, number>;
} {
  const included: Array<{ facts: EligibilityFacts; evidence: string }> = [];
  const excludedByReason = new Map<string, number>();

  for (const { facts, decision } of decisions) {
    if (decision.kind === "include") {
      included.push({ facts, evidence: decision.evidence });
    } else {
      excludedByReason.set(decision.reason, (excludedByReason.get(decision.reason) ?? 0) + 1);
    }
  }

  return { included, excludedByReason };
}

/**
 * Keep one candidate per person: their MOST RECENT unanswered request.
 *
 * 43 of 1,487 eligible people asked more than once, holding 101 intents between
 * them. All 43 had a gate DM that Meta accepted, yet 41 never completed a single
 * guide — versus 46 of 1,444 single-request people. So they are not unreachable,
 * they are the segment being failed most consistently, and dropping them would
 * remove the strongest signal from the campaign.
 *
 * Most recent rather than oldest, for how the message reads: the copy says "I don't
 * think my DM reached you", which sounds attentive on a recent comment and odd on a
 * six-week-old one, where the notification is also likelier to be missed. Their
 * requests span 7 days on average, so the two rules rarely differ by much.
 *
 * Unverified: nobody has sent one of these yet, so this is a judgement about
 * phrasing, not a measured result. The stage-1 holdout is what will test it.
 */
export function keepLatestPerPerson<T extends { facts: EligibilityFacts }>(included: T[]): T[] {
  const latestByPerson = new Map<string, T>();

  for (const entry of included) {
    const existing = latestByPerson.get(entry.facts.igUserId);
    if (!existing || entry.facts.commentAt > existing.facts.commentAt) {
      latestByPerson.set(entry.facts.igUserId, entry);
    }
  }

  // Preserve the caller's ordering (oldest first) rather than Map insertion order,
  // so a staged `limit` still takes the oldest cohort first.
  const kept = new Set([...latestByPerson.values()].map((e) => e.facts.intentId));
  return included.filter((entry) => kept.has(entry.facts.intentId));
}

/**
 * Refuse to build a campaign that would contact anyone twice.
 *
 * The database enforces one candidate per intent and per person via unique
 * indexes, but that would surface as a mid-insert P2002 with half a campaign
 * written. Checking first turns it into a clean refusal with a readable message.
 *
 * Kept as a hard failure even though `keepLatestPerPerson` now runs first: this is
 * the last line before a public send, and if the dedup ever regresses the right
 * response is to stop and look rather than quietly contact someone twice.
 */
export function assertNoDuplicates(included: Array<{ facts: EligibilityFacts }>): void {
  const seenPeople = new Map<string, string>();
  const seenIntents = new Set<string>();

  for (const { facts } of included) {
    if (seenIntents.has(facts.intentId)) {
      throw new Error(
        `historical recovery selection produced two candidates for intent ${facts.intentId}`,
      );
    }
    seenIntents.add(facts.intentId);

    const priorIntent = seenPeople.get(facts.igUserId);
    if (priorIntent) {
      throw new Error(
        `historical recovery selection would contact ${facts.igUserId} twice ` +
          `(intents ${priorIntent} and ${facts.intentId}) — one public recovery per person per campaign`,
      );
    }
    seenPeople.set(facts.igUserId, facts.intentId);
  }
}

/** The two rollout phases, each with exactly one permitted evidence basis. */
export type CampaignPhase = "confirmed_failure" | "unknown_read_pilot";

/**
 * The evidence a phase is allowed to contain.
 *
 * A campaign's phase decides its copy, its approval, its sequencing, and how its
 * results are read. If the two cohorts mix, none of those mean what the label says:
 * a `confirmed_failure` campaign would tell someone "I couldn't send your guide"
 * when Meta actually accepted it, and a pilot's metrics would blend two populations.
 *
 * Verified in production before this existed: a campaign labelled
 * `unknown_read_pilot` held 988 gate_sent_no_read rows AND 2 gate_exhausted rows.
 */
const PHASE_EVIDENCE: Record<CampaignPhase, string> = {
  confirmed_failure: "gate_exhausted",
  unknown_read_pilot: "gate_sent_no_read",
};

export function evidenceForPhase(phase: CampaignPhase): string {
  return PHASE_EVIDENCE[phase];
}

/**
 * Is this candidate's evidence permitted in this phase?
 *
 * Exact match rather than a subset rule: an evidence type added later must be
 * assigned to a phase deliberately, not inherited into whichever cohort happens to
 * be permissive.
 */
export function evidenceMatchesPhase(phase: CampaignPhase, evidence: string): boolean {
  return PHASE_EVIDENCE[phase] === evidence;
}

/**
 * Assign treatment or holdout for one person.
 *
 * Delegates to the prospective feature's `assignRecoveryCohort`, which already hashes
 * (experimentVersion, igUserId) into a 0-100 bucket. Reused rather than reimplemented
 * so both experiments partition the same way and a fix to one applies to both.
 *
 * Replaces `index % 100 < holdoutPercent` on an oldest-first list, which was broken
 * two separate ways (QA-07):
 *
 *   N=25 at 50%  ->  25 holdout, 0 treatment.  The pilot sent to NOBODY.
 *   N=25 at 10%  ->  10 holdout, 15 treatment. 40% withheld, not 10%.
 *   N=990 at 50% ->  the oldest 50 of every 100 went to holdout, so the arm was
 *                    confounded with comment age and the experiment could not
 *                    separate "the reminder worked" from "recent requests convert".
 *
 * Hashing on the person means the split is stable across reruns, independent of
 * ordering and pool size, and identical for someone re-selected into a later campaign.
 */
export function assignArm(
  igUserId: string,
  experimentVersion: string,
  holdoutPercent: number,
): "treatment" | "holdout" {
  const cohort = assignRecoveryCohort(igUserId, experimentVersion, holdoutPercent);
  // The prospective feature calls its withheld arm "control"; the candidate schema
  // calls it "holdout". Same meaning, different vocabulary per feature.
  return cohort === "control" ? "holdout" : "treatment";
}

/**
 * Refuse a campaign whose realized split cannot answer the question it exists for.
 *
 * A hash on a small pool does not land on the nominal percentage, and at pilot sizes
 * it can land somewhere useless. Checked at creation, when the fix is free, rather
 * than discovered after approval.
 */
export function validateArmSplit(input: {
  treatment: number;
  holdout: number;
  holdoutPercent: number;
}): { ok: true } | { ok: false; reason: string } {
  const total = input.treatment + input.holdout;
  if (total === 0) return { ok: false, reason: "no_candidates_selected" };

  // The campaign sends to nobody. This is exactly what the old modulo produced for a
  // 25-person pilot at 50%.
  if (input.treatment === 0) {
    return { ok: false, reason: "no_treatment_candidates" };
  }
  // A holdout was asked for and none materialised, so there is nothing to compare
  // against and the campaign cannot measure lift.
  if (input.holdoutPercent > 0 && input.holdout === 0) {
    return { ok: false, reason: "no_holdout_candidates" };
  }

  return { ok: true };
}
