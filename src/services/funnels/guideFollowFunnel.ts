// The guide → follow funnel: where do people fall out between commenting a
// keyword and becoming a durable follower?
//
// WHY THIS EXISTS. The Home "Guide → Follow Yield" tile reports converted ÷
// rechecked over people who received a guide while NOT following
// (statsService.getFollowConversion). Since the hard follow gate landed in
// messageHandler, a confirmed non-follower can no longer reach the normal
// delivery path at all — messageHandler returns early and sends FOLLOW_GATE.
// So the only deliveries that can still carry followerAtDelivery=false are
// REDELIVERIES to people who already had the guide. The tile is measuring a
// residue, and the transition that actually decides growth — did someone who
// hit the follow wall come back and follow? — is not measured anywhere.
//
// This funnel measures it. Two rules it will not bend on:
//
//   COHORT, NOT EVENT COUNTS. Stages are computed over a fixed set of
//   conversations that ENTERED in the window, then followed forward however
//   long they took. Counting `follow_required` events and `done_received`
//   events in the same window would be wrong twice over: markGated re-arms on
//   every reply so one stubborn non-follower emits several follow_required
//   events, and their eventual completion often lands outside the window.
//
//   DISTINCT ON CONVERSATION. Every stage is a boolean per conversation, never
//   a row count. "How many asks before they gave up" is a separate metric, not
//   an accidental inflation of the denominator.

import { FOLLOW_THROUGH_MIN_DAYS } from "../followThroughCore.js";
import {
  type FunnelDef,
  type FunnelHeadline,
  type GuardedRate,
  type FunnelStageCount,
  guardedRate,
  toStageCounts,
} from "./types.js";

/**
 * Below this many conversations in a denominator, report counts and suppress
 * the rate. Matches MIN_RETENTION_SAMPLE in followThroughCore — the same
 * reasoning applies: at n=3 a single outcome reads as 33%.
 */
export const GUIDE_FOLLOW_MIN_SAMPLE = 5;

/**
 * How far BEFORE the cohort window to look for a conversation's own events.
 *
 * Downstream events cannot precede entry for a fresh conversation, but a
 * REUSED one (journeyDisposition = reused_active) can carry a gate sent during
 * an earlier journey. Without a margin those conversations would look like they
 * never got a gate. 90 days is generous enough to cover any live journey and
 * still lets Postgres use the (kind, created_at) index instead of scanning all
 * of event_log.
 */
export const EVENT_LOOKBACK_MARGIN = "90 days";

export const guideFollowDef: FunnelDef = {
  key: "guide-follow",
  name: "Guide → follow",
  question:
    "Of the people who ask for a guide, how many end up following — and where do the rest fall out?",
  // Measured, not assumed. Over the first real 30-day run: 1,771 people
  // received the unlock DM and never answered, against 68 stuck at the follow
  // wall — a 26x difference. The follow gate converts at ~75%, which is in line
  // with published follow-gate numbers and is not where the losses are.
  //
  // Re-measured on the V2 card gate (cohort 2026-09-13..10-13): 11,552 got the
  // opening card, 5,773 answered it, 2,762 hit the follow wall and 1,170 cleared
  // it. The wall now loses real people (~1,600), but the unanswered card still
  // loses more than three times as many, so the headline stays here.
  headline: {
    fromStage: "gateSent",
    toStage: "replied",
    label: "Reply rate",
    rationale:
      "More people stop at the unlock DM than anywhere else in the funnel, so this step moves the total most. The follow wall downstream loses people too, but fewer of them.",
  },
  minSample: GUIDE_FOLLOW_MIN_SAMPLE,
  stages: [
    {
      key: "entered",
      label: "Asked for a guide",
      definition:
        "Commented a keyword, or DM'd one. Counted once per conversation on its first keyword_matched inside the window; everything downstream follows THESE conversations forward, however long they take.",
    },
    {
      key: "gateSent",
      label: "Got the unlock DM",
      definition:
        "We delivered the DM asking them to answer: the opening card on a comment, or the old text gate. People who DM'd the keyword skip this step — their DM was the request — so a gap here is not necessarily a loss.",
      bypassable: true,
    },
    {
      key: "replied",
      label: "Replied",
      definition:
        "They answered: tapped the card, typed a reply, sent DONE, or were bounced by the follow wall. Silence here means the DM landed and did nothing.",
    },
    {
      key: "guideDelivered",
      label: "Got the guide",
      definition:
        "The guide sequence completed. Includes redeliveries to people who had already received it, and people who never saw the gate at all because they were already following — which is why there is no step conversion from the previous stage here.",
      bypassable: true,
    },
    {
      key: "followingMeasured",
      label: "Following (first reading)",
      definition:
        "Measured as following when the recheck worker read them ~3 days after delivery. A lower bound: someone who follows on day 10 is not counted, and anyone the worker has not reached yet is missing entirely.",
      // The shortfall mixes "did not follow" with "not yet read", and nothing
      // in the data separates them. Reporting it as loss would overstate.
      coverageOnly: true,
    },
    {
      key: "followingD21",
      label: "Still following (21 days)",
      definition:
        "Read a SECOND time ~21 days later and still following. Only people who had to follow to unlock the guide get this reading. This is the only stage that can distinguish a real follower from someone who followed to unlock a freebie and left.",
      // Almost entirely worker backlog: 5 of 1,400 eligible measured so far.
      coverageOnly: true,
    },
  ],
};

/** One row per conversation in the cohort. Shape returned by COHORT_SQL. */
export interface GuideFollowRow {
  conversationId: string;
  igUserId: string;
  enteredAt: Date;
  /** 'comment' | 'dm' — derived, see COHORT_SQL. */
  entryPath: string;
  state: string;
  gateSent: boolean;
  /** Answered the gate: DONE on the V1 path, a tap or typed reply on the V2 card. */
  doneReceived: boolean;
  /**
   * How many times we asked them to follow. >1 means repeated asks. V1
   * follow_required events plus V2 check_follow tokens (one per gate or re-ask).
   */
  followRequiredCount: number;
  guideDelivered: boolean;
  /** A delivery carrying followerAtDelivery=false — post-gate, only redeliveries. */
  deliveredToNonFollower: boolean;
  wasRedelivery: boolean;
  rechecked: boolean;
  /** Current stored follow flag (ig_users.is_follower). Null = never readable. */
  followsNow: boolean | null;
  /** Second reading ~21 days out. Null = not yet measured. */
  followThrough: boolean | null;
  /**
   * The follow-through worker owes (or already took) this conversation its 21-day
   * reading: it had to follow to get the guide, was rechecked, and completed at least
   * FOLLOW_THROUGH_MIN_DAYS ago. Mirrors FOLLOW_THROUGH_DUE_SQL, which picks the work.
   */
  followThroughDue: boolean;
}

/**
 * The V2 guide journey, at most one row per conversation, as a CTE named
 * `access_journey`. Shared by this funnel and the drop-off lists so the two cannot
 * disagree about who got the DM. Expects a `cohort` CTE and the $1/$3 parameters.
 *
 * WHY. Since the card gate went to every guide (2026-08-24) a journey is recorded in
 * guide_access_attempt and guide_action_token, and nothing writes the V1 events this
 * funnel was built on (dm_sent kind=gate, done_received, follow_required). Read alone,
 * those events showed 11,590 people asking for a guide and 1 getting the unlock DM.
 * Both readers stay: a V1 journey inside the lookback still counts.
 *
 * - A comment-path attempt is the unlock DM. It is created in the same step that sends
 *   the opening card, and 10 of 11,566 openings failed over 2026-09-13..10-13. A DM
 *   entry also opens an attempt but gets no card, so `gateSent` scopes it to comments.
 * - `replied`: a tap or a typed reply, both of which consume the request_guide token.
 *   follow_check_count also counts, because an owner reset cancels tokens.
 * - `follow_asks`: one check_follow token is issued per gate or re-ask.
 */
const ACCESS_JOURNEY_CTE = `
access_journey AS (
  SELECT
    a.conversation_id,
    COALESCE(bool_or(a.follow_check_count > 0
      OR (t.action = 'request_guide' AND t.status = 'consumed')), false) AS replied,
    (COUNT(DISTINCT t.id) FILTER (WHERE t.action = 'check_follow'))::int AS follow_asks
  FROM guide_access_attempt a
  LEFT JOIN guide_action_token t ON t.attempt_id = a.id
  WHERE a.created_at >= $1::timestamptz - $3::interval
    AND a.conversation_id IN (SELECT conversation_id FROM cohort)
  GROUP BY a.conversation_id
)`;

/**
 * Per-conversation signals over V1 events and the V2 journey, for queries that group
 * by conversation with aliases `co` (cohort, with entry_path), `ev` (events) and `aj`
 * (access_journey). `aj` has at most one row per conversation, so wrapping it in an
 * aggregate is exact and keeps it out of each caller's GROUP BY.
 */
export const JOURNEY_SIGNALS = {
  ctes: ACCESS_JOURNEY_CTE,
  join: "LEFT JOIN access_journey aj ON aj.conversation_id = co.conversation_id",
  gateSent: `(COALESCE(bool_or(ev.kind = 'dm_sent' AND ev.payload->>'kind' = 'gate'), false)
    OR (co.entry_path = 'comment' AND COALESCE(bool_or(aj.conversation_id IS NOT NULL), false)))`,
  answered: `(COALESCE(bool_or(ev.kind = 'done_received'), false)
    OR COALESCE(bool_or(aj.replied), false))`,
  followAsks: `((COUNT(*) FILTER (WHERE ev.kind = 'follow_required'))::int
    + COALESCE(MAX(aj.follow_asks), 0))`,
  delivered: `COALESCE(bool_or(ev.kind = 'sequence_completed'), false)`,
} as const;

/**
 * The cohort query. Parameters, in order:
 *   $1 from (timestamptz, inclusive)
 *   $2 to   (timestamptz, exclusive)
 *   $3 event lookback margin (interval, e.g. '90 days')
 *
 * Read-only: a single SELECT with CTEs, safe for a SELECT-only role and safe to
 * paste into the Supabase SQL editor or hand to an MCP client verbatim.
 */
export const COHORT_SQL = `
WITH cohort AS (
  SELECT
    (e.payload->>'conversationId')::uuid            AS conversation_id,
    MIN(e.created_at)                               AS entered_at,
    -- commentHandler's keyword_matched carries no 'source'; messageHandler
    -- stamps 'dm'. Absence therefore means the comment path.
    COALESCE(MIN(e.payload->>'source'), 'comment')  AS entry_path
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
),
ev AS (
  SELECT
    (payload->>'conversationId')::uuid AS conversation_id,
    kind,
    payload
  FROM event_log
  WHERE kind IN ('dm_sent', 'follow_required', 'done_received', 'sequence_completed')
    AND created_at >= $1::timestamptz - $3::interval
    AND payload->>'conversationId' IS NOT NULL
),
${JOURNEY_SIGNALS.ctes}
SELECT
  co.conversation_id::text                     AS "conversationId",
  c.ig_user_id                                 AS "igUserId",
  co.entered_at                                AS "enteredAt",
  co.entry_path                                AS "entryPath",
  c.state::text                                AS "state",
  (c.follow_rechecked_at IS NOT NULL)          AS "rechecked",
  u.is_follower                                AS "followsNow",
  c.follow_through_is_follower                 AS "followThrough",
  ${JOURNEY_SIGNALS.gateSent}                  AS "gateSent",
  ${JOURNEY_SIGNALS.answered}                  AS "doneReceived",
  ${JOURNEY_SIGNALS.followAsks}                AS "followRequiredCount",
  ${JOURNEY_SIGNALS.delivered}                 AS "guideDelivered",
  COALESCE(bool_or(ev.kind = 'sequence_completed'
    AND (ev.payload->>'followerAtDelivery')::boolean IS FALSE), false)
                                               AS "deliveredToNonFollower",
  COALESCE(bool_or(ev.kind = 'sequence_completed'
    AND (ev.payload->>'redelivery')::boolean IS TRUE), false)
                                               AS "wasRedelivery",
  -- Same pool FOLLOW_THROUGH_DUE_SQL hands the worker, plus the ones it already read.
  COALESCE(
    c.follow_rechecked_at IS NOT NULL
    AND c.completed_at <= now() - interval '${FOLLOW_THROUGH_MIN_DAYS} days'
    AND (c.follow_through_at IS NOT NULL OR u.is_follower IS TRUE)
    AND (
      COALESCE(bool_or(ev.kind = 'sequence_completed'
        AND (ev.payload->>'followerAtDelivery')::boolean IS FALSE), false)
      OR ${JOURNEY_SIGNALS.followAsks} > 0
    ),
    false)                                     AS "followThroughDue"
FROM cohort co
JOIN conversations c ON c.id = co.conversation_id
LEFT JOIN ig_users  u ON u.id = c.ig_user_id
LEFT JOIN ev          ON ev.conversation_id = co.conversation_id
${JOURNEY_SIGNALS.join}
GROUP BY
  co.conversation_id, c.ig_user_id, co.entered_at, co.entry_path,
  c.state, c.follow_rechecked_at, u.is_follower, c.follow_through_is_follower,
  c.completed_at, c.follow_through_at
ORDER BY co.entered_at
`.trim();

export interface EntryPathBreakdown {
  entryPath: string;
  entered: number;
  guideDelivered: number;
  deliveryRate: GuardedRate;
}

export interface GuideFollowResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  cohortSize: number;
  stages: FunnelStageCount[];
  /** The funnel's primary metric, per `def.headline`. */
  headline: FunnelHeadline & { rate: GuardedRate };
  /**
   * THE number this funnel exists for: of the people who hit the follow wall,
   * how many followed and went on to get the guide. This is the true
   * follow-gate conversion — the one comparable to published follow-gate
   * benchmarks, and the one the Home tile does not measure.
   */
  followGateConversion: GuardedRate;
  /** Hit the wall and never got the guide. The actionable list. */
  stuckAtWall: number;
  /** Among wall-hitters, how many asks they received. Sorted by asks. */
  askDistribution: { asks: number; conversations: number; cleared: number }[];
  /**
   * Never saw the wall — already following at entry, or already completed this
   * keyword. Separated because blending them makes every stage rate meaningless.
   */
  expressLane: number;
  byEntryPath: EntryPathBreakdown[];
  /** Durability of the converts, matching the Home tile's second reading. */
  retention: GuardedRate;
  /**
   * Conversations owed a 21-day reading (measured or not). The denominator for
   * "how far has the worker got", which `retention.denominator` is the numerator of.
   * Not the following count: people already following never get the reading.
   */
  followThroughDue: number;
  /**
   * Deliveries carrying followerAtDelivery=false — what the Home tile counts.
   * Reported here to make the redelivery composition visible.
   */
  homeTileCohort: { deliveredToNonFollower: number; ofWhichRedelivery: number };
}

/**
 * Pure summarizer. No database, no clock — everything comes from `rows`.
 */
export function summarizeGuideFollow(
  rows: GuideFollowRow[],
  window: { from: string; to: string },
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): GuideFollowResult {
  const hitWall = rows.filter((r) => r.followRequiredCount > 0);
  const clearedWall = hitWall.filter((r) => r.guideDelivered);

  const counts: Record<string, number> = {
    entered: rows.length,
    gateSent: rows.filter((r) => r.gateSent).length,
    // Any answer to the gate: passing it, or being bounced by the follow wall.
    replied: rows.filter((r) => r.doneReceived || r.followRequiredCount > 0).length,
    guideDelivered: rows.filter((r) => r.guideDelivered).length,
    // Scoped to delivered: someone who never got the guide cannot be a
    // guide-attributed follow, and counting them would understate the step.
    followingMeasured: rows.filter((r) => r.guideDelivered && r.rechecked && r.followsNow === true)
      .length,
    followingD21: rows.filter((r) => r.followThrough === true).length,
  };

  // Ask distribution across wall-hitters — "how many times did we ask before
  // they gave up" is its own finding, and the reason stages must stay distinct.
  const askBuckets = new Map<number, { conversations: number; cleared: number }>();
  for (const r of hitWall) {
    const bucket = askBuckets.get(r.followRequiredCount) ?? { conversations: 0, cleared: 0 };
    bucket.conversations += 1;
    if (r.guideDelivered) bucket.cleared += 1;
    askBuckets.set(r.followRequiredCount, bucket);
  }
  const askDistribution = [...askBuckets.entries()]
    .map(([asks, b]) => ({ asks, ...b }))
    .sort((a, b) => a.asks - b.asks);

  const paths = [...new Set(rows.map((r) => r.entryPath))].sort();
  const byEntryPath: EntryPathBreakdown[] = paths.map((entryPath) => {
    const inPath = rows.filter((r) => r.entryPath === entryPath);
    const delivered = inPath.filter((r) => r.guideDelivered).length;
    return {
      entryPath,
      entered: inPath.length,
      guideDelivered: delivered,
      deliveryRate: guardedRate(delivered, inPath.length, minSample),
    };
  });

  const measuredD21 = rows.filter((r) => r.followThrough !== null);

  return {
    key: guideFollowDef.key,
    name: guideFollowDef.name,
    question: guideFollowDef.question,
    window,
    cohortSize: rows.length,
    stages: toStageCounts(guideFollowDef.stages, counts),
    headline: {
      ...guideFollowDef.headline,
      rate: guardedRate(
        counts[guideFollowDef.headline.toStage] ?? 0,
        counts[guideFollowDef.headline.fromStage] ?? 0,
        minSample,
      ),
    },
    followGateConversion: guardedRate(clearedWall.length, hitWall.length, minSample),
    stuckAtWall: hitWall.length - clearedWall.length,
    askDistribution,
    expressLane: rows.filter((r) => r.guideDelivered && r.followRequiredCount === 0).length,
    byEntryPath,
    retention: guardedRate(
      measuredD21.filter((r) => r.followThrough === true).length,
      measuredD21.length,
      minSample,
    ),
    followThroughDue: rows.filter((r) => r.followThroughDue).length,
    homeTileCohort: {
      deliveredToNonFollower: rows.filter((r) => r.deliveredToNonFollower).length,
      ofWhichRedelivery: rows.filter((r) => r.deliveredToNonFollower && r.wasRedelivery).length,
    },
  };
}
