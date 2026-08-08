import { prisma } from "../lib/prisma.js";
import {
  decideEligibility,
  summarise,
  keepLatestPerPerson,
  assertNoDuplicates,
  evidenceMatchesPhase,
  assignArm,
  validateArmSplit,
  type CampaignPhase,
  type EligibilityFacts,
} from "./historicalRecoveryEligibility.js";
import { recoveryCopyFor } from "./historicalRecoveryCopy.js";

/**
 * Build the candidate list for a historical recovery campaign (design §34–§37).
 *
 * Selection is a SNAPSHOT, not a live query. The underlying data moves — origin
 * verdicts are rewritten, people reply, journeys complete — so re-selecting during
 * a send could contact somebody the owner never approved. Everything the send
 * needs is frozen onto the candidate row.
 *
 * This does not send. It produces a draft campaign for review.
 */

/** Raw per-intent facts, one row per canonical intent, gathered in one query. */
type SelectionRow = {
  intentId: string;
  igUserId: string;
  keywordId: string;
  conversationId: string;
  commentId: string | null;
  mediaId: string | null;
  triggerKind: string;
  commentAt: Date;
  keywordSnapshot: string;
  publicReplyText: string;
  keywordActive: boolean;
  gateAccepted: boolean;
  gateExhausted: boolean;
  recipientUnreachable: boolean;
  ambiguousPriorSend: boolean;
  hasEngagementEvidence: boolean;
  completedSameKeyword: boolean;
  priorPublicRecovery: boolean;
  supersededByNewerJourney: boolean;
  audienceOrigin: string | null;
  audienceOriginConfidence: string | null;
};

export type SelectionReport = {
  campaignId: string | null;
  sourceDataCutoff: Date;
  rawIntents: number;
  eligible: number;
  eligiblePeople: number;
  byEvidence: Record<string, number>;
  excludedByReason: Record<string, number>;
};

/**
 * Gather the facts. One query rather than per-row lookups: at ~4,200 intents a
 * per-row approach would issue tens of thousands of round trips.
 *
 * `cutoff` bounds every time-sensitive subquery, so re-running the same selection
 * version reproduces the same list even as new data arrives.
 */
async function loadRows(cutoff: Date): Promise<SelectionRow[]> {
  return prisma.$queryRaw<SelectionRow[]>`
    SELECT
      ji."id"          AS "intentId",
      ji."ig_user_id"  AS "igUserId",
      ji."keyword_id"  AS "keywordId",
      c."id"           AS "conversationId",
      jt."comment_id"  AS "commentId",
      jt."media_id"    AS "mediaId",
      COALESCE(jt."trigger_kind", 'unknown') AS "triggerKind",
      COALESCE(jt."received_at", c."created_at") AS "commentAt",
      k."keyword"      AS "keywordSnapshot",
      k."public_reply" AS "publicReplyText",
      k."active"       AS "keywordActive",

      -- Meta accepted the gate: either a dm_sent event for this conversation, or a
      -- gate_queue row that reached 'sent'. gate_queue alone is NOT sufficient —
      -- it is a failure queue, so a successful live send leaves no row there.
      (
        EXISTS (SELECT 1 FROM "event_log" e
                 WHERE e."kind" = 'dm_sent'
                   AND (e."payload"->>'conversationId')::uuid = c."id"
                   AND e."created_at" <= ${cutoff})
        OR EXISTS (SELECT 1 FROM "gate_queue" g
                    WHERE g."conversation_id" = c."id" AND g."status" = 'sent')
      ) AS "gateAccepted",

      EXISTS (SELECT 1 FROM "gate_queue" g
               WHERE g."conversation_id" = c."id" AND g."status" = 'exhausted') AS "gateExhausted",

      -- The dead-account guard. 59 of 63 exhausted rows here are this exact error.
      EXISTS (SELECT 1 FROM "gate_queue" g
               WHERE g."conversation_id" = c."id"
                 AND g."last_error" ILIKE '%cannot be found%') AS "recipientUnreachable",

      -- An earlier gate attempt whose outcome we cannot establish. It may have
      -- posted, so a second public attempt risks double-posting.
      EXISTS (SELECT 1 FROM "gate_queue" g
               WHERE g."conversation_id" = c."id"
                 AND g."status" = 'send_uncertain') AS "ambiguousPriorSend",

      -- ANY inbound message from this person is positive engagement evidence, which
      -- falsifies the premise of the reminder ("you never saw this").
      EXISTS (SELECT 1 FROM "dm_message" m
               JOIN "dm_thread" t ON t."id" = m."thread_id"
               WHERE t."ig_user_id" = ji."ig_user_id"
                 AND m."direction" = 'inbound'
                 AND m."created_at" <= ${cutoff}) AS "hasEngagementEvidence",

      EXISTS (SELECT 1 FROM "conversations" c2
               WHERE c2."ig_user_id" = ji."ig_user_id"
                 AND c2."keyword_id" = ji."keyword_id"
                 AND c2."state" = 'completed') AS "completedSameKeyword",

      EXISTS (SELECT 1 FROM "dm_recovery_reminder" r
               WHERE r."ig_user_id" = ji."ig_user_id"
                 AND r."status" IN ('sent', 'sending', 'send_uncertain')) AS "priorPublicRecovery",

      -- A newer live journey for the same request should own it instead.
      EXISTS (SELECT 1 FROM "journey_intent" ji2
               WHERE ji2."ig_user_id" = ji."ig_user_id"
                 AND ji2."keyword_id" = ji."keyword_id"
                 AND ji2."window_started_at" > ji."window_started_at"
                 AND ji2."completed_at" IS NULL) AS "supersededByNewerJourney",

      u."inferred_origin"   AS "audienceOrigin",
      u."origin_confidence" AS "audienceOriginConfidence"

    FROM "journey_intent" ji
    JOIN "conversations" c ON c."id" = ji."canonical_conversation_id"
    JOIN "keywords" k ON k."id" = ji."keyword_id"
    LEFT JOIN "ig_users" u ON u."id" = ji."ig_user_id"
    -- The originating trigger carries the comment to reply to. LEFT JOIN so an
    -- intent WITHOUT one is still counted and reported as excluded, rather than
    -- silently vanishing from the totals.
    LEFT JOIN LATERAL (
      SELECT t."comment_id", t."media_id", t."trigger_kind", t."received_at"
      FROM "journey_trigger" t
      WHERE t."intent_id" = ji."id"
      ORDER BY t."received_at" ASC
      LIMIT 1
    ) jt ON TRUE
    WHERE ji."completed_at" IS NULL
      AND c."state" <> 'completed'
      AND ji."window_started_at" <= ${cutoff}
    ORDER BY ji."window_started_at" ASC
  `;
}

/**
 * Select candidates and, when `persist` is set, write a draft campaign.
 *
 * A written campaign is always `draft`: it cannot send until an owner approves it,
 * which the `chk_campaign_running_is_approved` constraint enforces.
 */
export async function selectHistoricalCandidates(input: {
  phase: CampaignPhase;
  selectionVersion: string;
  copyVersion: string;
  westernOnly: boolean;
  /** Oldest comment to consider. Omit for no lower bound. */
  commentFrom?: Date;
  /** Newest comment to consider — e.g. "at least 7 days old". */
  commentTo?: Date;
  /** Cap the campaign to the first N candidates, oldest first (staged rollout). */
  limit?: number;
  holdoutPercent?: number;
  persist: boolean;
  now?: Date;
}): Promise<SelectionReport> {
  const cutoff = input.now ?? new Date();
  const rows = await loadRows(cutoff);

  const decided = rows.map((row) => {
    const facts: EligibilityFacts = {
      intentId: row.intentId,
      igUserId: row.igUserId,
      commentId: row.commentId,
      triggerKind: row.triggerKind,
      commentAt: row.commentAt,
      gateAccepted: row.gateAccepted,
      gateExhausted: row.gateExhausted,
      recipientUnreachable: row.recipientUnreachable,
      ambiguousPriorSend: row.ambiguousPriorSend,
      hasEngagementEvidence: row.hasEngagementEvidence,
      completedSameKeyword: row.completedSameKeyword,
      priorPublicRecovery: row.priorPublicRecovery,
      supersededByNewerJourney: row.supersededByNewerJourney,
      keywordActive: row.keywordActive,
      audienceOrigin: row.audienceOrigin,
      westernOnly: input.westernOnly,
    };
    return { row, facts, decision: decideEligibility(facts) };
  });

  // Age window, applied after eligibility so the report distinguishes "not eligible"
  // from "eligible but outside the approved age range".
  const inWindow = decided.filter(({ row, decision }) => {
    if (decision.kind !== "include") return true;
    if (input.commentFrom && row.commentAt < input.commentFrom) return false;
    if (input.commentTo && row.commentAt > input.commentTo) return false;
    return true;
  });
  const outOfWindow = decided.length - inWindow.length;

  const { included: allEligible, excludedByReason } = summarise(
    inWindow.map(({ facts, decision }) => ({ facts, decision })),
  );
  if (outOfWindow > 0) excludedByReason.set("outside_age_window", outOfWindow);

  // Phase filter, applied BEFORE dedup, limit, and arm assignment so all three see
  // the real cohort. A campaign's phase decides its copy and how its results are
  // read, so a mixed pool makes the label untrue: verified in production, a campaign
  // labelled unknown_read_pilot contained 2 gate_exhausted rows.
  const included = allEligible.filter((entry) => evidenceMatchesPhase(input.phase, entry.evidence));
  if (allEligible.length > included.length) {
    excludedByReason.set("wrong_phase_for_campaign", allEligible.length - included.length);
  }

  // One public comment per person. 43 people hold 101 eligible intents, so without
  // this the campaign would try to contact them repeatedly; their most recent
  // unanswered request is the one recovered.
  const perPerson = keepLatestPerPerson(included);
  if (included.length > perPerson.length) {
    excludedByReason.set("older_request_same_person", included.length - perPerson.length);
  }

  // Last line before a public send: if the dedup above ever regresses, stop rather
  // than contact anyone twice.
  assertNoDuplicates(perPerson);

  const byIntent = new Map(inWindow.map((d) => [d.facts.intentId, d]));
  const selected = typeof input.limit === "number" ? perPerson.slice(0, input.limit) : perPerson;
  if (typeof input.limit === "number" && perPerson.length > selected.length) {
    excludedByReason.set("beyond_stage_cap", perPerson.length - selected.length);
  }

  const byEvidence: Record<string, number> = {};
  for (const entry of selected) {
    byEvidence[entry.evidence] = (byEvidence[entry.evidence] ?? 0) + 1;
  }

  const report: SelectionReport = {
    campaignId: null,
    sourceDataCutoff: cutoff,
    rawIntents: rows.length,
    eligible: selected.length,
    eligiblePeople: new Set(selected.map((e) => e.facts.igUserId)).size,
    byEvidence,
    excludedByReason: Object.fromEntries(excludedByReason),
  };

  if (!input.persist) return report;

  const holdoutPercent = input.holdoutPercent ?? 50;
  const campaign = await prisma.recoveryCampaign.create({
    data: {
      phase: input.phase,
      selectionVersion: input.selectionVersion,
      copyVersion: input.copyVersion,
      sourceDataCutoff: cutoff,
      commentFrom: input.commentFrom ?? null,
      commentTo: input.commentTo ?? null,
      holdoutPercent,
      candidateCount: selected.length,
      excludedCount: rows.length - selected.length,
    },
  });

  // Arms assigned by hashing (selectionVersion, igUserId), NOT by list position.
  // Position-based assignment on an oldest-first list gave 0 treatment for a 25-person
  // pilot at 50%, and confounded the arm with comment age at scale (QA-07).
  const arms = new Map(
    selected.map((entry) => [
      entry.facts.intentId,
      assignArm(entry.facts.igUserId, input.selectionVersion, holdoutPercent),
    ]),
  );

  // A hash on a small pool does not land on the nominal percentage, so check the
  // realized split before writing rather than discovering it after approval.
  const split = validateArmSplit({
    treatment: [...arms.values()].filter((a) => a === "treatment").length,
    holdout: [...arms.values()].filter((a) => a === "holdout").length,
    holdoutPercent,
  });
  if (!split.ok) {
    throw new Error(
      `historical recovery selection produced an unusable arm split: ${split.reason}`,
    );
  }

  await prisma.$transaction(
    selected.map((entry) => {
      const row = byIntent.get(entry.facts.intentId)!.row;
      const arm = arms.get(entry.facts.intentId)!;
      return prisma.recoveryCandidate.create({
        data: {
          campaignId: campaign.id,
          // Denormalised so the database can enforce phase/evidence agreement rather
          // than trusting the filter above to keep working.
          campaignPhase: input.phase,
          intentId: row.intentId,
          igUserId: row.igUserId,
          conversationId: row.conversationId,
          keywordId: row.keywordId,
          commentId: row.commentId!,
          mediaId: row.mediaId,
          commentAt: row.commentAt,
          // Frozen: the keyword may be renamed and the copy revised, but an approved
          // campaign sends what the owner approved.
          keywordSnapshot: row.keywordSnapshot,
          // Recovery copy, NOT the keyword's publicReply. The keyword says "Check
          // your DMs!", which points a person at the exact thing that failed.
          // Chosen by evidence so we never publicly claim the DM failed when all we
          // know is that no read receipt arrived.
          // Rendered with the keyword, because the instruction IS to DM that keyword.
          // Copy without it would tell the person to send something we never named.
          publicReplyText: recoveryCopyFor(entry.evidence, row.keywordSnapshot),
          evidence: entry.evidence,
          audienceOrigin: row.audienceOrigin,
          audienceOriginConfidence: row.audienceOriginConfidence,
          arm,
          eligibleAt: cutoff,
        },
      });
    }),
  );

  report.campaignId = campaign.id;
  return report;
}
