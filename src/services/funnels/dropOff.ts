// Who fell out, and what we know about why.
//
// A funnel that only reports percentages tells you a step is bad and stops.
// This is the half that makes the page an operations tool: the people sitting
// in the biggest leak, with the evidence needed to act on them.
//
// WHAT THE FIRST RUN SHOWED. Of 1,727 conversations that got the unlock DM and
// never answered, only 64 have a confirmed read receipt. That is not "1,663
// people ignored us" — for 1,107 of them no read data exists at all. But among
// the 620 we DO track, 556 were never confirmed read. The evidence points at
// the DM not being seen rather than the copy being unpersuasive, which are
// opposite fixes. Hence the breakdown below separates "confirmed seen",
// "tracked but never confirmed" and "no read data" instead of collapsing them
// into a single misleading "unseen" number.

import { guardedRate, type GuardedRate } from "./types.js";

/** Which leak to inspect. */
export type DropOffBucket = "no-reply" | "stuck-at-wall";

export const DROP_OFF_BUCKETS: Record<DropOffBucket, { label: string; definition: string }> = {
  "no-reply": {
    label: "Got the DM, never answered",
    definition:
      "The unlock DM was delivered and they never replied — no DONE, and they never hit the follow wall. The funnel's largest loss by an order of magnitude.",
  },
  "stuck-at-wall": {
    label: "Asked to follow, never did",
    definition:
      "They replied, were told to follow first, and never came back with the guide delivered. Small in volume; these are the closest to converting.",
  },
};

/** Shared cohort CTEs. $1 from, $2 to, $3 event lookback margin. */
const COHORT_CTES = `
WITH cohort AS (
  SELECT (e.payload->>'conversationId')::uuid AS conversation_id,
         MIN(e.created_at) AS entered_at
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
),
ev AS (
  SELECT (payload->>'conversationId')::uuid AS conversation_id, kind, payload
  FROM event_log
  WHERE kind IN ('dm_sent', 'follow_required', 'done_received', 'sequence_completed')
    AND created_at >= $1::timestamptz - $3::interval
    AND payload->>'conversationId' IS NOT NULL
),
rec AS (
  -- Most recent reminder per conversation. Read evidence (seen_at) only exists
  -- where the recovery system tracked the gate at all, which is why absence is
  -- reported as "no read data" rather than counted as unseen.
  SELECT DISTINCT ON (conversation_id)
    conversation_id, status::text AS rec_status, cohort::text AS rec_arm,
    seen_at, suppression_reason
  FROM dm_recovery_reminder
  ORDER BY conversation_id, eligible_at DESC
),
agg AS (
  SELECT co.conversation_id, co.entered_at,
    COALESCE(bool_or(ev.kind = 'dm_sent' AND ev.payload->>'kind' = 'gate'), false) AS gate_sent,
    COALESCE(bool_or(ev.kind = 'done_received'), false) AS done_received,
    (COUNT(*) FILTER (WHERE ev.kind = 'follow_required'))::int AS wall_asks,
    COALESCE(bool_or(ev.kind = 'sequence_completed'), false) AS delivered
  FROM cohort co
  LEFT JOIN ev ON ev.conversation_id = co.conversation_id
  GROUP BY co.conversation_id, co.entered_at
)`;

/** $4 = bucket. Parameterized, so the bucket never reaches SQL as text. */
const BUCKET_FILTER = `
  WHERE CASE WHEN $4 = 'stuck-at-wall'
             THEN (a.wall_asks > 0 AND NOT a.delivered)
             ELSE (a.gate_sent AND NOT a.done_received AND a.wall_asks = 0 AND NOT a.delivered)
        END`;

export const DROP_OFF_BREAKDOWN_SQL = `${COHORT_CTES}
SELECT
  count(*)::int                                                       AS "total",
  count(*) FILTER (WHERE c.state::text = 'expired')::int              AS "expired",
  count(*) FILTER (WHERE c.state::text = 'awaiting_done')::int        AS "stillOpen",
  count(*) FILTER (WHERE rec.seen_at IS NOT NULL)::int                AS "confirmedSeen",
  count(*) FILTER (WHERE rec.conversation_id IS NOT NULL
                     AND rec.seen_at IS NULL)::int                    AS "trackedNeverConfirmed",
  count(*) FILTER (WHERE rec.conversation_id IS NULL)::int            AS "noReadData",
  count(*) FILTER (WHERE rec.rec_status = 'sent')::int                AS "reminderSent",
  count(*) FILTER (WHERE rec.rec_status = 'suppressed')::int          AS "reminderSuppressed",
  count(*) FILTER (WHERE rec.rec_arm = 'control')::int                AS "inControlArm"
FROM agg a
JOIN conversations c ON c.id = a.conversation_id
LEFT JOIN rec ON rec.conversation_id = a.conversation_id
${BUCKET_FILTER}`.trim();

/** $5 = limit. Newest first: the freshest drop-offs are the actionable ones. */
export const DROP_OFF_ROWS_SQL = `${COHORT_CTES}
SELECT
  a.conversation_id::text  AS "conversationId",
  c.ig_user_id             AS "igUserId",
  u.username               AS "username",
  a.entered_at             AS "enteredAt",
  c.state::text            AS "state",
  k.keyword                AS "keyword",
  a.wall_asks              AS "wallAsks",
  rec.rec_status           AS "recoveryStatus",
  rec.rec_arm              AS "recoveryArm",
  rec.seen_at              AS "seenAt",
  rec.suppression_reason   AS "suppressionReason"
FROM agg a
JOIN conversations c ON c.id = a.conversation_id
JOIN keywords k      ON k.id = c.keyword_id
LEFT JOIN ig_users u ON u.id = c.ig_user_id
LEFT JOIN rec        ON rec.conversation_id = a.conversation_id
${BUCKET_FILTER}
ORDER BY a.entered_at DESC
LIMIT $5`.trim();

/** Raw shape of DROP_OFF_BREAKDOWN_SQL. */
export interface DropOffCounts {
  total: number;
  expired: number;
  stillOpen: number;
  confirmedSeen: number;
  trackedNeverConfirmed: number;
  noReadData: number;
  reminderSent: number;
  reminderSuppressed: number;
  inControlArm: number;
}

export interface DropOffRow {
  conversationId: string;
  igUserId: string;
  username: string | null;
  enteredAt: Date;
  state: string;
  keyword: string;
  wallAsks: number;
  recoveryStatus: string | null;
  recoveryArm: string | null;
  seenAt: Date | null;
  suppressionReason: string | null;
}

export interface DropOffSummary {
  bucket: DropOffBucket;
  label: string;
  definition: string;
  total: number;
  byState: { expired: number; stillOpen: number };
  /**
   * Read evidence, deliberately three-way. Collapsing "no read data" into
   * "unseen" would turn an unknown into an accusation and point the fix at DM
   * copy when the evidence points at deliverability.
   */
  readEvidence: {
    confirmedSeen: number;
    trackedNeverConfirmed: number;
    noReadData: number;
    /** Of the ones we can actually judge, how many were confirmed read. */
    confirmedSeenOfTracked: GuardedRate;
  };
  recovery: {
    reminderSent: number;
    reminderSuppressed: number;
    inControlArm: number;
    noReminder: number;
  };
  rows: DropOffRow[];
}

export function summarizeDropOff(
  bucket: DropOffBucket,
  counts: DropOffCounts,
  rows: DropOffRow[],
  minSample: number,
): DropOffSummary {
  const tracked = counts.confirmedSeen + counts.trackedNeverConfirmed;
  return {
    bucket,
    label: DROP_OFF_BUCKETS[bucket].label,
    definition: DROP_OFF_BUCKETS[bucket].definition,
    total: counts.total,
    byState: { expired: counts.expired, stillOpen: counts.stillOpen },
    readEvidence: {
      confirmedSeen: counts.confirmedSeen,
      trackedNeverConfirmed: counts.trackedNeverConfirmed,
      noReadData: counts.noReadData,
      confirmedSeenOfTracked: guardedRate(counts.confirmedSeen, tracked, minSample),
    },
    recovery: {
      reminderSent: counts.reminderSent,
      reminderSuppressed: counts.reminderSuppressed,
      inControlArm: counts.inControlArm,
      noReminder: counts.noReadData,
    },
    rows,
  };
}
