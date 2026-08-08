import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent } from "./eventLogger.js";
import { completeCampaignIfDrained } from "./recoveryCampaignControl.js";

/**
 * Record what happened AFTER a historical recovery candidate was settled (QA-12).
 *
 * `laterInboundAt` and `laterCompletedAt` existed in the schema and were read by the
 * API and the dashboard, but nothing ever wrote them. So the "recovered" view was
 * permanently empty and the recovery rate — the one number that says whether the
 * campaign was worth running — could not be computed at all.
 *
 * BOTH arms are attributed, which is what makes the experiment mean something:
 *
 *   - treatment: they were publicly reminded, then came back. The lift.
 *   - holdout:   they were NOT reminded, and came back anyway. The baseline.
 *
 * Attributing only treatment would produce a number with nothing to compare it to, and
 * every recovery would look like a success.
 *
 * Scoping differs by kind, because the two events carry different information:
 *
 *   - `completed` KNOWS its keyword. A completion is for one specific guide, so it is
 *     matched on person + keyword — the same scoping QA-11 applied to the pre-send
 *     checks. Someone who returns for a different guide has not recovered THIS one.
 *   - `inbound` does NOT. Measured over 60 days: 608 of 683 inbound messages are a bare
 *     "DONE" with no keyword in them at all. So an inbound is person-level evidence and
 *     is attributed to every attributable candidate for that person.
 *
 * Pretending an inbound could be resolved to a keyword would mean guessing, and a guess
 * recorded as measurement is worse than a coarser number that is true. `laterInboundAt`
 * is the leading indicator ("they came back to us"); `laterCompletedAt` is the outcome
 * ("they got the guide"), and only the second is keyword-exact.
 *
 * Timestamps are earliest-wins and never overwritten. The question is "did they come
 * back after we contacted them", so the FIRST return is the answer; a later one tells us
 * nothing new, and letting it overwrite would inflate the measured delay.
 *
 * Non-throwing. This is measurement, and losing a data point must never roll back the
 * completion or the inbound message that triggered it — the same reasoning as
 * `suppressRecoveriesForCompletionSafely`.
 */

/** Which timestamp an event feeds. */
export type AttributionKind = "inbound" | "completed";

export type AttributionInput = {
  igUserId: string;
  /**
   * The guide this event concerns. Required for `completed`, omitted for `inbound`.
   *
   * An inbound DM does not name a keyword — 608 of 683 measured are a bare "DONE" — so
   * requiring one here would force the caller to invent it.
   */
  keywordId?: string;
  at: Date;
  kind: AttributionKind;
};

/**
 * Candidates this event can be attributed to.
 *
 * Only rows that were SETTLED before the event: a `sent` treatment row, or a
 * `holdout_withheld` control row. A pending row has not been acted on yet, so a return
 * cannot be a response to it.
 *
 * `send_uncertain` counts as settled for treatment, because the comment may well have
 * posted — excluding it would drop real recoveries from the numerator.
 */
function attributableWhere(input: AttributionInput): Prisma.RecoveryCandidateWhereInput {
  return {
    igUserId: input.igUserId,
    // Only when the event knows which guide it is about. See the note above.
    ...(input.keywordId ? { keywordId: input.keywordId } : {}),
    OR: [
      // Treatment: publicly contacted at or before the event.
      {
        outcome: { in: ["sent", "send_uncertain"] },
        arm: "treatment",
        OR: [{ sentAt: { lte: input.at } }, { lastAttemptAt: { lte: input.at } }],
      },
      // Holdout: deliberately not contacted. The withholding decision is made at
      // approval, so the campaign's start is the reference point.
      {
        outcome: "holdout_withheld",
        arm: "holdout",
        campaign: { startedAt: { lte: input.at } },
      },
    ],
  };
}

/**
 * Attribute one return event, then close any campaign it finishes.
 *
 * Idempotent: replaying the same event is a no-op, because each write is conditional on
 * the column still being null. A webhook redelivery therefore cannot move a timestamp.
 */
export async function attributeRecoveryOutcome(input: AttributionInput): Promise<number> {
  const column = input.kind === "inbound" ? "laterInboundAt" : "laterCompletedAt";

  const candidates = await prisma.recoveryCandidate.findMany({
    where: {
      ...attributableWhere(input),
      // Earliest-wins: only rows that have not recorded this yet.
      [column]: null,
    },
    select: { id: true, campaignId: true, arm: true },
  });

  if (candidates.length === 0) return 0;

  // Conditional on still being null, so two concurrent webhooks cannot both write and
  // the earlier one wins regardless of arrival order.
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id: { in: candidates.map((c) => c.id) }, [column]: null },
    data: { [column]: input.at },
  });

  if (count > 0) {
    await logEvent("historical_recovery_attributed", {
      kind: input.kind,
      igUserId: input.igUserId,
      keywordId: input.keywordId ?? null,
      candidates: count,
      // Split in the log so the lift can be read without re-querying.
      treatment: candidates.filter((c) => c.arm === "treatment").length,
      holdout: candidates.filter((c) => c.arm === "holdout").length,
    });
  }

  // A completion can be the last thing a campaign was waiting on.
  for (const campaignId of new Set(candidates.map((c) => c.campaignId))) {
    await completeCampaignIfDrained(campaignId, input.at);
  }

  return count;
}

/**
 * The non-throwing wrapper the live paths call.
 *
 * Measurement must never break delivery. A failure here loses one data point; a failure
 * that propagated would roll back a completion and re-gate someone who already has
 * their guide.
 */
export async function attributeRecoveryOutcomeSafely(input: AttributionInput): Promise<void> {
  try {
    await attributeRecoveryOutcome(input);
  } catch (err) {
    logger.error(
      {
        errorCode: "historical_recovery_attribution_failed",
        kind: input.kind,
        igUserId: input.igUserId,
      },
      "Could not attribute a historical recovery outcome",
    );
  }
}
