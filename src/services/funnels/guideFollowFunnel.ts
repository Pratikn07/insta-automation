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
  headline: {
    fromStage: "gateSent",
    toStage: "replied",
    label: "Reply rate",
    rationale:
      "Everyone who answers the unlock DM gets the guide almost without exception, so this step is where the funnel actually loses people. The follow gate downstream converts fine and sees a fraction of the volume.",
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
        "We delivered the gate DM asking them to reply. People who were already following, or who already completed this keyword, skip this step entirely — they get the guide immediately, so a gap here is not necessarily a loss.",
      bypassable: true,
    },
    {
      key: "replied",
      label: "Replied",
      definition:
        "They answered the gate — either passing it (done_received) or hitting the follow wall (follow_required). Silence here means the DM landed and did nothing.",
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
        "Read a SECOND time ~21 days later and still following. This is the only stage that can distinguish a real follower from someone who followed to unlock a freebie and left.",
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
  doneReceived: boolean;
  /** How many times we asked them to follow. >1 means repeated asks. */
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
}

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
)
SELECT
  co.conversation_id::text                     AS "conversationId",
  c.ig_user_id                                 AS "igUserId",
  co.entered_at                                AS "enteredAt",
  co.entry_path                                AS "entryPath",
  c.state::text                                AS "state",
  (c.follow_rechecked_at IS NOT NULL)          AS "rechecked",
  u.is_follower                                AS "followsNow",
  c.follow_through_is_follower                 AS "followThrough",
  COALESCE(bool_or(ev.kind = 'dm_sent' AND ev.payload->>'kind' = 'gate'), false)
                                               AS "gateSent",
  COALESCE(bool_or(ev.kind = 'done_received'), false)
                                               AS "doneReceived",
  (COUNT(*) FILTER (WHERE ev.kind = 'follow_required'))::int
                                               AS "followRequiredCount",
  COALESCE(bool_or(ev.kind = 'sequence_completed'), false)
                                               AS "guideDelivered",
  COALESCE(bool_or(ev.kind = 'sequence_completed'
    AND (ev.payload->>'followerAtDelivery')::boolean IS FALSE), false)
                                               AS "deliveredToNonFollower",
  COALESCE(bool_or(ev.kind = 'sequence_completed'
    AND (ev.payload->>'redelivery')::boolean IS TRUE), false)
                                               AS "wasRedelivery"
FROM cohort co
JOIN conversations c ON c.id = co.conversation_id
LEFT JOIN ig_users  u ON u.id = c.ig_user_id
LEFT JOIN ev          ON ev.conversation_id = co.conversation_id
GROUP BY
  co.conversation_id, c.ig_user_id, co.entered_at, co.entry_path,
  c.state, c.follow_rechecked_at, u.is_follower, c.follow_through_is_follower
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
    homeTileCohort: {
      deliveredToNonFollower: rows.filter((r) => r.deliveredToNonFollower).length,
      ofWhichRedelivery: rows.filter((r) => r.deliveredToNonFollower && r.wasRedelivery).length,
    },
  };
}
