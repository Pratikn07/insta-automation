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
 * Timestamps are earliest-wins by event time, including reverse and concurrent webhook
 * delivery. The question is "did they come back after we contacted them", so the FIRST
 * chronological return is the answer; a later one tells us nothing new.
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

type AttributedRow = {
  campaignId: string;
  arm: "treatment" | "holdout";
};

/**
 * Treatment starts at the final pre-network dispatch stamp. `sent_at` and
 * `last_attempt_at` are compatibility fallbacks for legacy settled rows created before
 * that stamp existed. Holdout starts at approval (`campaign.started_at`).
 *
 * These are two deliberately static statements rather than interpolating a column
 * name. Besides keeping the SQL parameterized, each statement makes its campaign-owned
 * window explicit. The changed-value predicate makes the returned rows exactly the
 * rows whose earliest timestamp moved.
 */
async function attributeInbound(input: AttributionInput): Promise<AttributedRow[]> {
  return prisma.$queryRaw<AttributedRow[]>`
    WITH eligible AS (
      SELECT
        rc."id",
        rc."campaign_id",
        CASE
          WHEN rc."arm" = 'treatment' THEN
            COALESCE(rc."dispatch_started_at", rc."sent_at", rc."last_attempt_at")
          ELSE campaign."started_at"
        END AS anchor_at,
        campaign."inbound_window_hours" AS window_hours
      FROM "recovery_candidate" rc
      JOIN "recovery_campaign" campaign ON campaign."id" = rc."campaign_id"
      WHERE rc."ig_user_id" = ${input.igUserId}
        AND (
          (
            rc."arm" = 'treatment'
            AND rc."outcome" IN ('sent', 'send_uncertain')
          )
          OR (
            rc."arm" = 'holdout'
            AND rc."outcome" = 'holdout_withheld'
          )
        )
    )
    UPDATE "recovery_candidate" rc
    SET
      "later_inbound_at" = LEAST(
        COALESCE(rc."later_inbound_at", ${input.at}),
        ${input.at}
      ),
      "updated_at" = CURRENT_TIMESTAMP
    FROM eligible
    WHERE rc."id" = eligible."id"
      AND eligible.anchor_at IS NOT NULL
      AND ${input.at} >= eligible.anchor_at
      AND ${input.at} <= eligible.anchor_at
        + make_interval(hours => eligible.window_hours)
      AND (rc."later_inbound_at" IS NULL OR ${input.at} < rc."later_inbound_at")
    RETURNING rc."campaign_id" AS "campaignId", rc."arm"::text AS "arm"
  `;
}

async function attributeCompletion(input: AttributionInput & { keywordId: string }): Promise<AttributedRow[]> {
  return prisma.$queryRaw<AttributedRow[]>`
    WITH eligible AS (
      SELECT
        rc."id",
        rc."campaign_id",
        CASE
          WHEN rc."arm" = 'treatment' THEN
            COALESCE(rc."dispatch_started_at", rc."sent_at", rc."last_attempt_at")
          ELSE campaign."started_at"
        END AS anchor_at,
        campaign."completion_window_hours" AS window_hours
      FROM "recovery_candidate" rc
      JOIN "recovery_campaign" campaign ON campaign."id" = rc."campaign_id"
      WHERE rc."ig_user_id" = ${input.igUserId}
        AND rc."keyword_id" = ${input.keywordId}::uuid
        AND (
          (
            rc."arm" = 'treatment'
            AND rc."outcome" IN ('sent', 'send_uncertain')
          )
          OR (
            rc."arm" = 'holdout'
            AND rc."outcome" = 'holdout_withheld'
          )
        )
    )
    UPDATE "recovery_candidate" rc
    SET
      "later_completed_at" = LEAST(
        COALESCE(rc."later_completed_at", ${input.at}),
        ${input.at}
      ),
      "updated_at" = CURRENT_TIMESTAMP
    FROM eligible
    WHERE rc."id" = eligible."id"
      AND eligible.anchor_at IS NOT NULL
      AND ${input.at} >= eligible.anchor_at
      AND ${input.at} <= eligible.anchor_at
        + make_interval(hours => eligible.window_hours)
      AND (rc."later_completed_at" IS NULL OR ${input.at} < rc."later_completed_at")
    RETURNING rc."campaign_id" AS "campaignId", rc."arm"::text AS "arm"
  `;
}

/**
 * Attribute one return event, then close any campaign it finishes.
 *
 * Idempotent and order-independent: a replay is a no-op, an earlier event can move the
 * timestamp backward, and a later event can never move it forward.
 */
export async function attributeRecoveryOutcome(input: AttributionInput): Promise<number> {
  // A completion identifies one guide. Missing identity must not silently broaden it
  // into person-level attribution; inbound is the intentionally person-level signal.
  if (input.kind === "completed" && !input.keywordId) return 0;

  const candidates = input.kind === "inbound"
    ? await attributeInbound(input)
    : await attributeCompletion(input as AttributionInput & { keywordId: string });
  const count = candidates.length;

  if (count > 0) {
    await logEvent("historical_recovery_attributed", {
      kind: input.kind,
      igUserId: input.igUserId,
      keywordId: input.keywordId ?? null,
      candidates: count,
      // Split in the log so the lift can be read without re-querying.
      treatment: candidates.filter((candidate) => candidate.arm === "treatment").length,
      holdout: candidates.filter((candidate) => candidate.arm === "holdout").length,
    });
  }

  // A completion can be the last thing a campaign was waiting on.
  for (const campaignId of new Set(candidates.map((candidate) => candidate.campaignId))) {
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
