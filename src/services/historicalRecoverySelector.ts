import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
import {
  buildSelectionDecisionHash,
  buildSelectionFingerprint,
  EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION,
  type SelectionSnapshotConfiguration,
  type SelectionSnapshotExclusion,
  type SelectionSnapshotInclusion,
} from "./historicalRecoverySnapshot.js";
import { AUDIENCE_SEGMENTS, type AudienceSegment } from "./historicalAudienceSegment.js";

export const HISTORICAL_RECOVERY_ELIGIBILITY_POLICY_VERSION = "eligibility-v3";
const DEFAULT_INBOUND_WINDOW_HOURS = 24;
const DEFAULT_COMPLETION_WINDOW_HOURS = 48;

/**
 * PostgreSQL accepts several UUID spellings but stores only its lowercase,
 * hyphenated representation. Normalize at the selection boundary so the reviewed
 * hash, persisted campaign, and later approval reconstruction use one identity.
 */
function normalizeRolloutGroupId(value: string): string | null {
  if (value !== value.trim()) return null;
  const hasOpeningBrace = value.startsWith("{");
  const hasClosingBrace = value.endsWith("}");
  if (hasOpeningBrace !== hasClosingBrace) return null;
  const unbraced = hasOpeningBrace ? value.slice(1, -1) : value;
  const compact = /^[0-9a-f]{32}$/i.test(unbraced)
    ? unbraced
    : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(unbraced)
      ? unbraced.replaceAll("-", "")
      : null;
  if (!compact) return null;
  const lowercase = compact.toLowerCase();
  return `${lowercase.slice(0, 8)}-${lowercase.slice(8, 12)}-${lowercase.slice(12, 16)}`
    + `-${lowercase.slice(16, 20)}-${lowercase.slice(20)}`;
}

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
  audienceOriginMethod: string | null;
  audienceSegment: AudienceSegment | null;
  sources: Array<{
    commentId: string;
    mediaId: string | null;
    receivedAt: string | Date;
  }>;
};

export type SelectionReport = {
  campaignId: string | null;
  selectionFingerprint: string;
  /**
   * Fingerprint of the decision set (QA-14). Printed by the CLI so two runs can be
   * compared without querying, and stored on the campaign so an approval can be tied
   * back to the exact list that was reviewed.
   */
  decisionHash: string;
  sourceDataCutoff: Date;
  rawIntents: number;
  eligible: number;
  eligiblePeople: number;
  /** Distinct people represented by one or more recorded exclusions. */
  excludedPeople: number;
  /**
   * Stable, non-free-text exclusion identities for a coordinating transaction.
   * They are not operator CLI output; callers use them only to derive aggregate
   * exclusion counts without losing zero-candidate selection decisions.
   */
  excludedIgUserIds?: string[];
  byEvidence: Record<string, number>;
  /** Selected candidates by non-sensitive origin provenance. */
  originBreakdown: Record<string, number>;
  excludedByReason: Record<string, number>;
};

/**
 * Gather the facts. One query rather than per-row lookups: at ~4,200 intents a
 * per-row approach would issue tens of thousands of round trips.
 *
 * `cutoff` bounds every time-sensitive subquery, so re-running the same selection
 * version reproduces the same list even as new data arrives.
 */
async function loadRows(
  cutoff: Date,
  database: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
): Promise<SelectionRow[]> {
  return database.$queryRaw<SelectionRow[]>`
    SELECT
      ji."id"          AS "intentId",
      ji."ig_user_id"  AS "igUserId",
      ji."keyword_id"  AS "keywordId",
      c."id"           AS "conversationId",
      jt."comment_id"  AS "commentId",
      jt."media_id"    AS "mediaId",
      COALESCE(jt."sources", '[]'::jsonb) AS "sources",
      -- Reported from ANY trigger, not from the chosen comment trigger.
      --
      -- The lateral join below deliberately considers comment triggers only, so a
      -- DM-origin journey has no jt row. Reading the kind from jt alone would
      -- relabel every DM journey as no_source_comment, collapsing two different
      -- exclusions — "they asked by DM, there is nothing to reply to" and "we lost the
      -- comment id" — into one and making the campaign report misleading (§37).
      --
      -- Measured: 480 of the alias conversations QA-16 swept were DM-sourced, so this is
      -- the larger of the two classes by far.
      COALESCE(jt."trigger_kind", any_t."trigger_kind", 'unknown') AS "triggerKind",
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

      -- Engagement AFTER the request, not at any point in the person's history (QA-11).
      --
      -- This previously matched any inbound message ever sent, so someone who had DMed
      -- months earlier about something else was treated as having engaged with THIS
      -- request. Measured: 4 eligible intents were excluded on evidence that predated
      -- the ask they were being excluded from.
      --
      -- Bounded at both ends: at or after the window opened, and at or before the
      -- cutoff, so the answer is reproducible for a fixed selection version (QA-14).
      --
      -- Positive engagement of any kind counts, from both places it is recorded.
      --
      -- An inbound message is one form. The other is a read receipt or a reaction, which
      -- do NOT arrive as messages: the webhook writes them onto dm_recovery_reminder as
      -- seen_at / engaged_at. Checking messages alone missed the strongest evidence
      -- there is — a read receipt is direct proof the gate DM was opened.
      --
      -- Verified against production rather than assumed: no dm_read / dm_reaction /
      -- dm_postback event kinds exist in event_log, and 42 intents in the eligible pool
      -- carry seen_at or engaged_at on a prospective reminder.
      (
        EXISTS (SELECT 1 FROM "dm_message" m
                 JOIN "dm_thread" t ON t."id" = m."thread_id"
                 WHERE t."ig_user_id" = ji."ig_user_id"
                   AND m."direction" = 'inbound'
                   AND m."created_at" >= ji."window_started_at"
                   AND m."created_at" <= ${cutoff})
        OR EXISTS (SELECT 1 FROM "dm_recovery_reminder" r2
                    WHERE r2."ig_user_id" = ji."ig_user_id"
                      AND r2."keyword_id" = ji."keyword_id"
                      AND (
                        (r2."seen_at" IS NOT NULL
                          AND r2."seen_at" >= ji."window_started_at"
                          AND r2."seen_at" <= ${cutoff})
                        OR (r2."engaged_at" IS NOT NULL
                          AND r2."engaged_at" >= ji."window_started_at"
                          AND r2."engaged_at" <= ${cutoff})
                      ))
      ) AS "hasEngagementEvidence",

      -- Completion of THIS keyword, bounded by the cutoff so a rerun agrees.
      EXISTS (SELECT 1 FROM "conversations" c2
               WHERE c2."ig_user_id" = ji."ig_user_id"
                 AND c2."keyword_id" = ji."keyword_id"
                 AND c2."state" = 'completed'
                 AND c2."completed_at" <= ${cutoff}) AS "completedSameKeyword",

      -- BOTH recovery systems (QA-11). This read only the prospective table, so a
      -- historical campaign's own sends were invisible to the next selection — zero
      -- instances today only because no historical campaign has sent yet, which means
      -- the first one would have created them.
      (
        EXISTS (SELECT 1 FROM "dm_recovery_reminder" r
                 WHERE r."ig_user_id" = ji."ig_user_id"
                   AND r."status" IN ('sent', 'sending', 'send_uncertain')
                   AND COALESCE(r."sent_at", r."last_attempt_at") <= ${cutoff})
        OR EXISTS (SELECT 1 FROM "recovery_candidate" rc
                    WHERE rc."ig_user_id" = ji."ig_user_id"
                      AND rc."outcome" IN ('sent', 'send_uncertain')
                      AND COALESCE(rc."sent_at", rc."last_attempt_at") <= ${cutoff})
      ) AS "priorPublicRecovery",

      -- A newer live journey for the same request should own it instead.
      EXISTS (SELECT 1 FROM "journey_intent" ji2
               WHERE ji2."ig_user_id" = ji."ig_user_id"
                 AND ji2."keyword_id" = ji."keyword_id"
                 AND ji2."window_started_at" > ji."window_started_at"
                 AND ji2."completed_at" IS NULL) AS "supersededByNewerJourney",

      u."inferred_origin"   AS "audienceOrigin",
      u."origin_confidence" AS "audienceOriginConfidence",
      u."origin_method"     AS "audienceOriginMethod",
      u."audience_segment"  AS "audienceSegment"

    FROM "journey_intent" ji
    JOIN "conversations" c ON c."id" = ji."canonical_conversation_id"
    JOIN "keywords" k ON k."id" = ji."keyword_id"
    LEFT JOIN "ig_users" u ON u."id" = ji."ig_user_id"
    -- The trigger carrying the comment to reply to. LEFT JOIN so an intent WITHOUT one
    -- is still counted and reported as excluded, rather than silently vanishing.
    --
    -- The NEWEST comment trigger, not the oldest (QA-11).
    --
    -- Replying to someone's oldest ask is worse on two counts: an older comment is more
    -- likely to have been deleted, and the person's most recent ask is the one they
    -- actually remember. §34 asks for the newest still-available eligible source.
    --
    -- Measured after QA-16 restored alias history: 15 eligible intents now carry more
    -- than one trigger, and for all 15 the reply target changes. Before that backfill
    -- every intent had exactly one trigger, so this ordering looked like a free choice.
    --
    -- Comment triggers only. A dm trigger has no comment to reply to, and preferring a
    -- newer DM over an older comment would leave the candidate with no target at all —
    -- turning an eligible person into a silent exclusion.
    --
    -- Ordering by received_at DESC then comment_id DESC is a total order: the id
    -- tie-break keeps the
    -- choice deterministic when two triggers share a timestamp, which reproducibility
    -- (QA-14) depends on.
    LEFT JOIN LATERAL (
      SELECT
        (array_agg(se."comment_id"
          ORDER BY t."received_at" DESC, se."comment_id" DESC))[1] AS "comment_id",
        (array_agg(se."media_id"
          ORDER BY t."received_at" DESC, se."comment_id" DESC))[1] AS "media_id",
        (array_agg(t."trigger_kind"
          ORDER BY t."received_at" DESC, se."comment_id" DESC))[1] AS "trigger_kind",
        (array_agg(t."received_at"
          ORDER BY t."received_at" DESC, se."comment_id" DESC))[1] AS "received_at",
        jsonb_agg(
          jsonb_build_object(
            'commentId', se."comment_id",
            'mediaId', se."media_id",
            'receivedAt', t."received_at"
          )
          ORDER BY t."received_at" DESC, se."comment_id" DESC
        ) AS "sources"
      FROM "journey_trigger" t
      JOIN "journey_source_event" se ON se."id" = t."source_event_id"
      WHERE t."intent_id" = ji."id"
        AND t."trigger_kind" = 'comment'
        AND t."received_at" <= ${cutoff}
    ) jt ON TRUE
    -- Any trigger at all, purely so triggerKind can distinguish a DM-origin journey
    -- from one whose comment id was lost. Newest first, matching the choice above.
    LEFT JOIN LATERAL (
      SELECT t2."trigger_kind"
      FROM "journey_trigger" t2
      WHERE t2."intent_id" = ji."id" AND t2."received_at" <= ${cutoff}
      ORDER BY t2."received_at" DESC, t2."id" DESC
      LIMIT 1
    ) any_t ON TRUE
    WHERE ji."completed_at" IS NULL
      AND c."state" <> 'completed'
      AND ji."window_started_at" <= ${cutoff}
    ORDER BY
      ji."window_started_at" ASC,
      ji."ig_user_id" ASC,
      ji."keyword_id" ASC,
      ji."id" ASC
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
  dailyCap?: number;
  eligibilityPolicyVersion?: string;
  /** An exact current segment for a v4 expanded-audience campaign. */
  audienceSegment?: AudienceSegment;
  rolloutGroupId?: string;
  rolloutGroupHourlyCap?: number;
  inboundWindowHours?: number;
  completionWindowHours?: number;
  /** Internal expanded-rollout detail; ordinary selector reports keep prior shape. */
  includeExclusionIdentities?: boolean;
  persist: boolean;
  now?: Date;
  /**
   * Lets a higher-level selection coordinate several draft campaigns atomically.
   * Omit it to preserve the selector's existing one-campaign transaction.
   */
  transaction?: Prisma.TransactionClient;
}): Promise<SelectionReport> {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
    throw new Error("invalid_selection_limit");
  }
  const eligibilityPolicyVersion = input.eligibilityPolicyVersion
    ?? HISTORICAL_RECOVERY_ELIGIBILITY_POLICY_VERSION;
  const isExpandedAudienceSelection = eligibilityPolicyVersion
    === EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION;
  const hasExpandedAudienceField = input.audienceSegment !== undefined
    || input.rolloutGroupId !== undefined
    || input.rolloutGroupHourlyCap !== undefined;
  if (!isExpandedAudienceSelection && hasExpandedAudienceField) {
    throw new Error("expanded_audience_policy_version_required");
  }
  let rolloutGroupId: string | undefined;
  if (isExpandedAudienceSelection) {
    if (
      input.audienceSegment === undefined
      || input.rolloutGroupId === undefined
      || input.rolloutGroupHourlyCap === undefined
    ) {
      throw new Error("expanded_audience_metadata_required");
    }
    if (!AUDIENCE_SEGMENTS.includes(input.audienceSegment)) {
      throw new Error("invalid_audience_segment");
    }
    const normalizedRolloutGroupId = normalizeRolloutGroupId(input.rolloutGroupId);
    if (!normalizedRolloutGroupId) throw new Error("invalid_rollout_group_id");
    rolloutGroupId = normalizedRolloutGroupId;
    if (
      !Number.isInteger(input.rolloutGroupHourlyCap)
      || input.rolloutGroupHourlyCap < 1
      || input.rolloutGroupHourlyCap > 1000
    ) {
      throw new Error("invalid_rollout_group_hourly_cap");
    }
  }
  const cutoff = input.now ?? new Date();
  const rows = await loadRows(cutoff, input.transaction ?? prisma);

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
      audienceOriginConfidence: row.audienceOriginConfidence,
      audienceOriginMethod: row.audienceOriginMethod,
      audienceSegment: row.audienceSegment,
      westernOnly: input.westernOnly,
    };
    return { row, facts, decision: decideEligibility(facts) };
  });

  /**
   * Why each intent did not make the cut, keyed by intent (QA-14).
   *
   * The pipeline drops rows in stages and only ever counted them, so the record could
   * say "1,406 excluded" but never which person or on what grounds — and a predicate
   * that was quietly wrong looked exactly like a small cohort.
   *
   * First stage to drop a row wins, matching how the report's counts already read.
   */
  const exclusions = new Map<string, { reason: string; igUserId: string; keywordId: string }>();
  /** Row lookup for the later pipeline stages, which carry facts rather than rows. */
  const byIntentRow = new Map(decided.map(({ row }) => [row.intentId, row]));
  const dropped = (row: SelectionRow, reason: string) => {
    if (!exclusions.has(row.intentId)) {
      exclusions.set(row.intentId, { reason, igUserId: row.igUserId, keywordId: row.keywordId });
    }
  };
  for (const { row, decision } of decided) {
    if (decision.kind === "exclude") dropped(row, decision.reason);
  }

  // Age window, applied after eligibility so the report distinguishes "not eligible"
  // from "eligible but outside the approved age range".
  const inWindow = decided.filter(({ row, decision }) => {
    if (decision.kind !== "include") return true;
    const tooOld = input.commentFrom ? row.commentAt < input.commentFrom : false;
    const tooNew = input.commentTo ? row.commentAt > input.commentTo : false;
    if (tooOld || tooNew) {
      dropped(row, "outside_age_window");
      return false;
    }
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
  const keptByPhase = new Set(included.map((e) => e.facts.intentId));
  for (const entry of allEligible) {
    if (!keptByPhase.has(entry.facts.intentId)) {
      dropped(byIntentRow.get(entry.facts.intentId)!, "wrong_phase_for_campaign");
    }
  }

  // An expanded campaign has one exact audience segment. Other currently allowed
  // segments remain eligible in general, but must not leak into this immutable cohort.
  const matchingAudience = input.audienceSegment === undefined
    ? included
    : included.filter((entry) => entry.facts.audienceSegment === input.audienceSegment);
  if (included.length > matchingAudience.length) {
    excludedByReason.set("audience_segment_mismatch", included.length - matchingAudience.length);
  }
  const keptByAudience = new Set(matchingAudience.map((entry) => entry.facts.intentId));
  for (const entry of included) {
    if (!keptByAudience.has(entry.facts.intentId)) {
      dropped(byIntentRow.get(entry.facts.intentId)!, "audience_segment_mismatch");
    }
  }

  // One public comment per person. 43 people hold 101 eligible intents, so without
  // this the campaign would try to contact them repeatedly; their most recent
  // unanswered request is the one recovered.
  const perPerson = keepLatestPerPerson(matchingAudience);
  if (matchingAudience.length > perPerson.length) {
    excludedByReason.set("older_request_same_person", matchingAudience.length - perPerson.length);
  }
  const keptPerPerson = new Set(perPerson.map((e) => e.facts.intentId));
  for (const entry of matchingAudience) {
    if (!keptPerPerson.has(entry.facts.intentId)) {
      dropped(byIntentRow.get(entry.facts.intentId)!, "older_request_same_person");
    }
  }

  // Last line before a public send: if the dedup above ever regresses, stop rather
  // than contact anyone twice.
  assertNoDuplicates(perPerson);

  const byIntent = new Map(inWindow.map((d) => [d.facts.intentId, d]));
  const selected = typeof input.limit === "number" ? perPerson.slice(0, input.limit) : perPerson;
  if (typeof input.limit === "number" && perPerson.length > selected.length) {
    excludedByReason.set("beyond_stage_cap", perPerson.length - selected.length);
    for (const entry of perPerson.slice(selected.length)) {
      dropped(byIntentRow.get(entry.facts.intentId)!, "beyond_stage_cap");
    }
  }

  const holdoutPercent = input.holdoutPercent ?? 50;
  const dailyCap = input.dailyCap ?? 10;
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 1000) {
    throw new Error("invalid_daily_cap");
  }
  const inboundWindowHours = input.inboundWindowHours ?? DEFAULT_INBOUND_WINDOW_HOURS;
  const completionWindowHours = input.completionWindowHours
    ?? DEFAULT_COMPLETION_WINDOW_HOURS;
  for (const [name, hours] of [
    ["inbound", inboundWindowHours],
    ["completion", completionWindowHours],
  ] as const) {
    if (!Number.isInteger(hours) || hours < 24 || hours > 720) {
      throw new Error(`invalid_${name}_measurement_window`);
    }
  }

  // Arms are part of what the owner reviews. Compute and validate them before the first
  // write so an unusable small-cohort realization cannot leave an approvable draft.
  const arms = new Map(
    selected.map((entry) => [
      entry.facts.intentId,
      assignArm(entry.facts.igUserId, input.selectionVersion, holdoutPercent),
    ]),
  );
  if (selected.length > 0) {
    const split = validateArmSplit({
      treatment: [...arms.values()].filter((arm) => arm === "treatment").length,
      holdout: [...arms.values()].filter((arm) => arm === "holdout").length,
      holdoutPercent,
    });
    if (!split.ok) {
      throw new Error(
        `historical recovery selection produced an unusable arm split: ${split.reason}`,
      );
    }
  }

  const snapshotConfig: SelectionSnapshotConfiguration = {
    phase: input.phase,
    selectionVersion: input.selectionVersion,
    sourceDataCutoff: cutoff.toISOString(),
    commentFrom: input.commentFrom?.toISOString() ?? null,
    commentTo: input.commentTo?.toISOString() ?? null,
    selectionLimit: input.limit ?? null,
    westernOnly: input.westernOnly,
    holdoutPercent,
    copyVersion: input.copyVersion,
    eligibilityPolicyVersion,
    inboundWindowHours,
    completionWindowHours,
    ...(isExpandedAudienceSelection ? {
      audienceSegment: input.audienceSegment!,
      rolloutGroupId: rolloutGroupId!,
      rolloutGroupHourlyCap: input.rolloutGroupHourlyCap!,
    } : {}),
  };

  const inclusions: SelectionSnapshotInclusion[] = selected.map((entry, position) => {
    const row = byIntent.get(entry.facts.intentId)!.row;
    const eligibleSources = row.sources.filter((source) => {
      const receivedAt = new Date(source.receivedAt);
      return !(input.commentFrom && receivedAt < input.commentFrom)
        && !(input.commentTo && receivedAt > input.commentTo);
    });
    const sources = eligibleSources.map((source, sourcePosition) => ({
      position: sourcePosition,
      commentId: source.commentId,
      mediaId: source.mediaId,
      receivedAt: new Date(source.receivedAt).toISOString(),
      choiceReason: sourcePosition === 0 ? "newest_eligible_comment" : "approved_fallback",
    }));
    if (sources.length === 0 || sources[0]!.commentId !== row.commentId) {
      throw new Error(`historical recovery source manifest incomplete for ${row.intentId}`);
    }
    return {
      position,
      intentId: row.intentId,
      igUserId: row.igUserId,
      conversationId: row.conversationId,
      keywordId: row.keywordId,
      commentId: row.commentId!,
      mediaId: row.mediaId,
      commentAt: row.commentAt.toISOString(),
      keywordSnapshot: row.keywordSnapshot,
      publicReplyText: recoveryCopyFor(entry.evidence, row.keywordSnapshot),
      evidence: entry.evidence,
      audienceOrigin: row.audienceOrigin,
      audienceOriginMethod: row.audienceOriginMethod,
      audienceOriginConfidence: row.audienceOriginConfidence,
      ...(isExpandedAudienceSelection ? { audienceSegment: row.audienceSegment } : {}),
      arm: arms.get(row.intentId)!,
      sourceChoiceReason: "newest_eligible_comment",
      sources,
    };
  });
  const snapshotExclusions: SelectionSnapshotExclusion[] = [...exclusions].map(
    ([intentId, exclusion]) => ({ intentId, ...exclusion }),
  );
  const selectionFingerprint = buildSelectionFingerprint(snapshotConfig);
  const decisionHash = buildSelectionDecisionHash(
    snapshotConfig,
    inclusions,
    snapshotExclusions,
  );

  const byEvidence: Record<string, number> = {};
  for (const entry of selected) {
    byEvidence[entry.evidence] = (byEvidence[entry.evidence] ?? 0) + 1;
  }

  const originBreakdown: Record<string, number> = {};
  for (const entry of selected) {
    const row = byIntent.get(entry.facts.intentId)!.row;
    const method = row.audienceOriginMethod?.trim() || "missing";
    const origin = row.audienceOrigin?.trim() || "missing";
    const confidence = row.audienceOriginConfidence?.trim() || "missing";
    const key = `${method}/${origin}/${confidence}`;
    originBreakdown[key] = (originBreakdown[key] ?? 0) + 1;
  }

  const excludedIgUserIds = [...new Set(
    [...exclusions.values()].map((exclusion) => exclusion.igUserId),
  )].sort((left, right) => left.localeCompare(right));
  const report: SelectionReport = {
    campaignId: null,
    selectionFingerprint,
    decisionHash,
    sourceDataCutoff: cutoff,
    rawIntents: rows.length,
    eligible: selected.length,
    eligiblePeople: new Set(selected.map((e) => e.facts.igUserId)).size,
    excludedPeople: excludedIgUserIds.length,
    ...(input.includeExclusionIdentities ? { excludedIgUserIds } : {}),
    byEvidence,
    originBreakdown,
    excludedByReason: Object.fromEntries(excludedByReason),
  };

  if (!input.persist) return report;

  // Nobody qualified. That is an ANSWER, not a failure, and it is the moment the
  // exclusion breakdown matters most — so return the report rather than letting the arm
  // validator below reject an empty pool and take the reasons down with it.
  //
  // The validator still guards the case it was written for (QA-07): a cohort that HAS
  // candidates but no treatment arm is a broken experiment and must refuse. An empty
  // cohort is a different statement, and conflating the two meant an operator asking
  // "why is my cohort empty?" got a stack trace instead of the answer.
  //
  // No campaign is written, because there is nothing to review or approve.
  if (selected.length === 0) return report;

  const campaignId = randomUUID();
  const candidates = inclusions.map((inclusion) => ({ id: randomUUID(), inclusion }));

  const persistSelection = async (tx: Prisma.TransactionClient) => {
    await tx.recoveryCampaign.create({
      data: {
        id: campaignId,
        phase: input.phase,
        selectionVersion: input.selectionVersion,
        copyVersion: input.copyVersion,
        sourceDataCutoff: cutoff,
        commentFrom: input.commentFrom ?? null,
        commentTo: input.commentTo ?? null,
        selectionLimit: input.limit ?? null,
        holdoutPercent,
        dailyCap,
        candidateCount: inclusions.length,
        excludedCount: snapshotExclusions.length,
        selectionFingerprint,
        eligibilityPolicyVersion,
        westernOnly: input.westernOnly,
        inboundWindowHours,
        completionWindowHours,
        decisionHash,
        ...(isExpandedAudienceSelection ? {
          audienceSegment: input.audienceSegment!,
          rolloutGroupId: rolloutGroupId!,
          rolloutGroupHourlyCap: input.rolloutGroupHourlyCap!,
        } : {}),
      },
    });

    if (snapshotExclusions.length > 0) {
      await tx.recoverySelectionExclusion.createMany({
        data: snapshotExclusions.map((exclusion) => ({ campaignId, ...exclusion })),
      });
    }

    await tx.recoveryCandidate.createMany({
      data: candidates.map(({ id, inclusion }) => ({
        id,
        campaignId,
        campaignPhase: input.phase,
        intentId: inclusion.intentId,
        igUserId: inclusion.igUserId,
        conversationId: inclusion.conversationId,
        keywordId: inclusion.keywordId,
        commentId: inclusion.commentId,
        mediaId: inclusion.mediaId,
        commentAt: new Date(inclusion.commentAt),
        keywordSnapshot: inclusion.keywordSnapshot,
        publicReplyText: inclusion.publicReplyText,
        evidence: inclusion.evidence,
        selectionPosition: inclusion.position,
        audienceOrigin: inclusion.audienceOrigin,
        audienceOriginMethod: inclusion.audienceOriginMethod,
        audienceOriginConfidence: inclusion.audienceOriginConfidence,
        audienceSegment: byIntent.get(inclusion.intentId)!.row.audienceSegment,
        arm: inclusion.arm,
        eligibleAt: cutoff,
        sourceChoiceReason: inclusion.sourceChoiceReason,
      })),
    });
    await tx.recoveryCandidateSource.createMany({
      data: candidates.flatMap(({ id: candidateId, inclusion }) =>
        inclusion.sources.map((source) => ({
          candidateId,
          position: source.position,
          commentId: source.commentId,
          mediaId: source.mediaId,
          receivedAt: new Date(source.receivedAt),
          choiceReason: source.choiceReason,
        }))),
    });
  };
  if (input.transaction) {
    await persistSelection(input.transaction);
  } else {
    await prisma.$transaction(persistSelection, { isolationLevel: "Serializable" });
  }

  report.campaignId = campaignId;
  return report;
}
