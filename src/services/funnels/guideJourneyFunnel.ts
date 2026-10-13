// The guide journey, counted per person: one trunk (asked -> got the card -> said yes) that
// forks at the follow check into "already following" and "not following yet".
//
// WHY THIS REPLACED THE SIX-STAGE VIEW ON THE FUNNELS PAGE. Counted per card, someone who
// comments on seven reels counted seven times, and their six untapped cards read as losses.
// Drawn as one list, "following (first reading)" was mostly people who followed before they
// asked, and the 21-day bar read "2%" against everyone while 67 of 69 converts were still
// following. The output the page exists for, new followers, was a sentence under another
// stage. See docs/superpowers/specs/2026-10-13-guide-journey-funnel-design.md.
//
// The per-card `guide-follow` funnel stays as it was for the CLI report and the read-only
// MCP role.

import {
  type FunnelDef,
  type FunnelHeadline,
  type FunnelStageCount,
  type GuardedRate,
  guardedRate,
  toStageCounts,
} from "./types.js";
import { FOLLOW_THROUGH_MIN_DAYS } from "../followThroughCore.js";
import { GUIDE_FOLLOW_MIN_SAMPLE, JOURNEY_SIGNALS } from "./guideFollowFunnel.js";

/** Why someone with a card never said yes. First match wins, in this order. */
export const QUIET_BUCKETS = [
  "still_has_time",
  "wrote_not_yes",
  "opened_ignored",
  "no_sign_opened",
  "cannot_tell",
] as const;
export type QuietBucket = (typeof QUIET_BUCKETS)[number];

/** Why someone shown the follow wall never got the guide. First match wins. */
export const WALL_BUCKETS = ["still_has_time", "said_followed", "never_came_back"] as const;
export type WallBucket = (typeof WALL_BUCKETS)[number];

export const GUIDE_JOURNEY_LEAKS = ["never-said-yes", "stuck-at-wall"] as const;
export type GuideJourneyLeak = (typeof GUIDE_JOURNEY_LEAKS)[number];

export const guideJourneyDef: FunnelDef = {
  key: "guide-journey",
  name: "Guide journey",
  question:
    "Of the people who ask for a guide, how many get it, and how many new followers does it bring in?",
  // Home's reply-rate tile reads this, so the label and the step stay what Home has always
  // shown: of the people who got the unlock card, how many answered it.
  headline: {
    fromStage: "reached",
    toStage: "saidYes",
    label: "Reply rate",
    rationale:
      "More people stop at the unlock card than anywhere else in the journey. Everyone who answers it reaches the follow check.",
  },
  minSample: GUIDE_FOLLOW_MIN_SAMPLE,
  stages: [
    {
      key: "asked",
      label: "Asked for a guide",
      definition:
        "Commented or DM'd a guide keyword in the window. Each person counted once, however many reels they commented on.",
    },
    {
      key: "reached",
      label: "Got the card",
      definition:
        "Instagram accepted at least one unlock card (or the old text gate). Asking by DM is its own request, so DM askers count here too.",
    },
    {
      key: "saidYes",
      label: "Said yes",
      definition:
        "Tapped 'Yes, send it', typed a yes or DONE, or asked by DM. Everyone past this point reaches the follow check.",
    },
  ],
};

/** One row per person. Shape returned by GUIDE_JOURNEY_SQL. */
export interface GuideJourneyRow {
  igUserId: string;
  username: string | null;
  lastKeyword: string | null;
  cards: number;
  lastAskedAt: Date;
  reached: boolean;
  saidYes: boolean;
  /** Not following at a follow check on any card: the growth lane. */
  hitWall: boolean;
  /** Hit the wall and got a guide delivered after their first wall. */
  followed: boolean;
  gotGuide: boolean;
  d21Read: boolean;
  d21Following: boolean;
  /** A new follower rechecked and completed at least FOLLOW_THROUGH_MIN_DAYS ago. */
  d21Due: boolean;
  quietBucket: QuietBucket | null;
  wallBucket: WallBucket | null;
}

export interface GuideJourneyResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  /** People who asked. */
  cohortSize: number;
  /** The trunk only. Home's "largest loss" walks these, so it lands on said yes. */
  stages: FunnelStageCount[];
  headline: FunnelHeadline & { rate: GuardedRate };
  /** Followed and got the guide, out of everyone shown the follow wall. */
  newFollowers: GuardedRate;
  /** Got any guide, out of everyone who asked. */
  gotGuide: GuardedRate;
  lanes: {
    alreadyFollowing: { people: number; gotGuide: GuardedRate };
    notFollowing: { people: number };
  };
  /** Each leak's people by reason, and each reason's share of that leak. */
  leaks: {
    neverSaidYes: {
      total: number;
      buckets: Record<QuietBucket, number>;
      shares: Record<QuietBucket, GuardedRate>;
    };
    stuckAtWall: {
      total: number;
      buckets: Record<WallBucket, number>;
      shares: Record<WallBucket, GuardedRate>;
    };
  };
  /** Still following at 21 days, over new followers who were read. */
  retention: { due: number; rate: GuardedRate };
}

function bucketCounts<B extends string>(
  names: readonly B[],
  values: readonly (B | null)[],
): Record<B, number> {
  const counts = Object.fromEntries(names.map((name) => [name, 0])) as Record<B, number>;
  for (const value of values) if (value !== null) counts[value] += 1;
  return counts;
}

/** A leak's counts, total and per-reason shares, all from the same bucket column. */
function leakSummary<B extends string>(
  names: readonly B[],
  values: readonly (B | null)[],
  rate: (numerator: number, denominator: number) => GuardedRate,
) {
  const buckets = bucketCounts(names, values);
  const total = values.filter((value) => value !== null).length;
  const shares = Object.fromEntries(
    names.map((name) => [name, rate(buckets[name], total)]),
  ) as Record<B, GuardedRate>;
  return { total, buckets, shares };
}

/** Pure: no database, no clock. Everything comes from `rows`. */
export function summarizeGuideJourney(
  rows: GuideJourneyRow[],
  window: { from: string; to: string },
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): GuideJourneyResult {
  const count = (predicate: (row: GuideJourneyRow) => boolean) => rows.filter(predicate).length;
  const rate = (numerator: number, denominator: number) =>
    guardedRate(numerator, denominator, minSample);

  const asked = rows.length;
  const reached = count((r) => r.reached);
  const saidYes = count((r) => r.saidYes);
  const notFollowing = count((r) => r.hitWall);
  const alreadyFollowing = rows.filter((r) => r.saidYes && !r.hitWall);
  const quiet = rows.map((r) => r.quietBucket);
  const wall = rows.map((r) => r.wallBucket);

  return {
    key: guideJourneyDef.key,
    name: guideJourneyDef.name,
    question: guideJourneyDef.question,
    window,
    cohortSize: asked,
    stages: toStageCounts(guideJourneyDef.stages, { asked, reached, saidYes }),
    headline: { ...guideJourneyDef.headline, rate: rate(saidYes, reached) },
    newFollowers: rate(count((r) => r.followed), notFollowing),
    gotGuide: rate(count((r) => r.gotGuide), asked),
    lanes: {
      alreadyFollowing: {
        people: alreadyFollowing.length,
        gotGuide: rate(alreadyFollowing.filter((r) => r.gotGuide).length, alreadyFollowing.length),
      },
      notFollowing: { people: notFollowing },
    },
    leaks: {
      neverSaidYes: leakSummary(QUIET_BUCKETS, quiet, rate),
      stuckAtWall: leakSummary(WALL_BUCKETS, wall, rate),
    },
    retention: {
      due: count((r) => r.d21Due),
      rate: rate(
        count((r) => r.followed && r.d21Following),
        count((r) => r.followed && r.d21Read),
      ),
    },
  };
}

/**
 * One row per person whose first non-link keyword_matched falls in the window. Parameters:
 *   $1 from (timestamptz, inclusive), $2 to (exclusive), $3 event lookback margin.
 *
 * Built on the card-level signals in JOURNEY_SIGNALS, so a card means the same thing here
 * as in the per-card funnel; this only adds timing and evidence, then folds cards into
 * people. Read-only, safe for a SELECT-only role.
 *
 * - reached ⊇ said yes ⊇ hit the wall, by construction, so the leaks are exact gaps.
 * - followed: hit the wall on any card, and some card's guide was delivered after the
 *   first wall. Someone stuck on one card who follows and gets another card's guide counts.
 * - Read evidence exists only for cards saved to DM history (from 2026-10-05) or tracked by
 *   a reminder; the rest are "cannot_tell", never guessed.
 */
export const GUIDE_JOURNEY_SQL = `
WITH cohort AS (
  SELECT (e.payload->>'conversationId')::uuid AS conversation_id,
         MIN(e.created_at) AS entered_at,
         COALESCE(MIN(e.payload->>'source'), 'comment') AS entry_path
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
),
ev AS (
  SELECT (payload->>'conversationId')::uuid AS conversation_id, kind, payload, created_at
  FROM event_log
  WHERE kind IN ('dm_sent', 'follow_required', 'done_received', 'sequence_completed')
    AND created_at >= $1::timestamptz - $3::interval
    AND payload->>'conversationId' IS NOT NULL
),
${JOURNEY_SIGNALS.ctes},
card AS (
  SELECT
    co.conversation_id, co.entered_at, co.entry_path, c.ig_user_id, c.keyword_id,
    ${JOURNEY_SIGNALS.gateSent} AS card_sent,
    ${JOURNEY_SIGNALS.answered} AS answered,
    ${JOURNEY_SIGNALS.followAsks} AS follow_asks,
    ${JOURNEY_SIGNALS.delivered} AS delivered,
    LEAST(MIN(ev.created_at) FILTER (WHERE ev.kind = 'follow_required'), MIN(aj.first_wall_at))
                                                   AS first_wall_at,
    MAX(ev.created_at) FILTER (WHERE ev.kind = 'sequence_completed') AS last_delivered_at,
    MAX(aj.window_end)                             AS window_end,
    MAX(aj.wall_window_end)                        AS wall_window_end,
    (COALESCE(bool_or(aj.rechecked_at_wall), false)
      OR (COUNT(*) FILTER (WHERE ev.kind = 'follow_required')) >= 2) AS said_followed,
    MIN(aj.opened_at)                              AS opened_at,
    c.follow_through_is_follower                   AS d21,
    COALESCE(c.follow_rechecked_at IS NOT NULL
      AND c.completed_at <= now() - interval '${FOLLOW_THROUGH_MIN_DAYS} days', false) AS d21_eligible
  FROM cohort co
  JOIN conversations c ON c.id = co.conversation_id
  LEFT JOIN ev ON ev.conversation_id = co.conversation_id
  ${JOURNEY_SIGNALS.join}
  GROUP BY co.conversation_id, co.entered_at, co.entry_path, c.ig_user_id, c.keyword_id,
           c.follow_through_is_follower, c.follow_rechecked_at, c.completed_at
),
person AS (
  SELECT
    ig_user_id,
    COUNT(*)::int AS cards,
    MAX(entered_at) AS last_asked_at,
    (array_agg(keyword_id ORDER BY entered_at DESC))[1] AS last_keyword_id,
    bool_or(card_sent OR entry_path = 'dm' OR answered OR follow_asks > 0) AS reached,
    bool_or(answered OR follow_asks > 0 OR entry_path = 'dm') AS said_yes,
    bool_or(follow_asks > 0) AS hit_wall,
    MIN(first_wall_at) AS first_wall_at,
    bool_or(delivered) AS got_guide,
    MAX(last_delivered_at) AS last_delivered_at,
    COALESCE(bool_or(window_end > now()), false) AS window_open,
    COALESCE(bool_or(wall_window_end > now()), false) AS wall_window_open,
    bool_or(said_followed) AS said_followed,
    MIN(opened_at) AS first_card_at,
    bool_or(d21 IS NOT NULL) AS d21_read,
    bool_or(d21 IS TRUE) AS d21_following,
    bool_or(d21_eligible) AS d21_eligible
  FROM card
  GROUP BY ig_user_id
),
quiet_people AS (
  SELECT ig_user_id, first_card_at
  FROM person
  WHERE reached AND NOT said_yes AND NOT window_open
),
-- Read and reply evidence, only for people who got a card, never said yes, and are out of
-- time. Set-based on purpose: the first version probed per person, and dm_thread is keyed
-- (ig_account_id, ig_user_id), so each probe by ig_user_id walked the whole index, while
-- the reminder probe rescanned every card. 4,423 people took 28 s on production
-- (2026-10-13) against 0.4 s for everything else. dm_message.created_at is UTC without a
-- zone, hence the conversions.
dm_evidence AS (
  SELECT qp.ig_user_id,
    bool_or(m.direction = 'inbound'
      AND m.created_at > (qp.first_card_at AT TIME ZONE 'UTC')) AS wrote,
    bool_or(m.direction = 'outbound' AND m.source = 'keyword_automation' AND m.seen_at IS NOT NULL
      AND m.created_at >= (qp.first_card_at AT TIME ZONE 'UTC') - interval '2 minutes') AS card_seen,
    bool_or(m.direction = 'outbound' AND m.source = 'keyword_automation'
      AND m.created_at >= (qp.first_card_at AT TIME ZONE 'UTC') - interval '2 minutes') AS card_logged
  FROM quiet_people qp
  JOIN dm_thread th  ON th.ig_user_id = qp.ig_user_id
  JOIN dm_message m  ON m.thread_id = th.id
  GROUP BY qp.ig_user_id
),
reminder_evidence AS (
  SELECT k.ig_user_id, bool_or(r.seen_at IS NOT NULL) AS reminder_seen
  FROM card k
  JOIN dm_recovery_reminder r ON r.conversation_id = k.conversation_id
  WHERE k.ig_user_id IN (SELECT ig_user_id FROM quiet_people)
  GROUP BY k.ig_user_id
),
quiet AS (
  SELECT qp.ig_user_id,
    COALESCE(d.wrote, false) AS wrote,
    (COALESCE(d.card_seen, false) OR COALESCE(r.reminder_seen, false)) AS seen,
    (COALESCE(d.card_logged, false) OR r.ig_user_id IS NOT NULL) AS tracked
  FROM quiet_people qp
  LEFT JOIN dm_evidence d       ON d.ig_user_id = qp.ig_user_id
  LEFT JOIN reminder_evidence r ON r.ig_user_id = qp.ig_user_id
)
SELECT
  p.ig_user_id                                  AS "igUserId",
  u.username                                    AS "username",
  k.keyword                                     AS "lastKeyword",
  p.cards                                       AS "cards",
  p.last_asked_at                               AS "lastAskedAt",
  p.reached                                     AS "reached",
  p.said_yes                                    AS "saidYes",
  p.hit_wall                                    AS "hitWall",
  COALESCE(p.hit_wall AND p.last_delivered_at > p.first_wall_at, false) AS "followed",
  p.got_guide                                   AS "gotGuide",
  p.d21_read                                    AS "d21Read",
  p.d21_following                               AS "d21Following",
  COALESCE(p.hit_wall AND p.last_delivered_at > p.first_wall_at AND p.d21_eligible, false) AS "d21Due",
  CASE
    WHEN NOT p.reached OR p.said_yes THEN NULL
    WHEN p.window_open THEN 'still_has_time'
    WHEN q.wrote THEN 'wrote_not_yes'
    WHEN q.seen THEN 'opened_ignored'
    WHEN q.tracked THEN 'no_sign_opened'
    ELSE 'cannot_tell'
  END                                           AS "quietBucket",
  CASE
    WHEN NOT p.hit_wall OR COALESCE(p.last_delivered_at > p.first_wall_at, false) THEN NULL
    WHEN p.wall_window_open THEN 'still_has_time'
    WHEN p.said_followed THEN 'said_followed'
    ELSE 'never_came_back'
  END                                           AS "wallBucket"
FROM person p
LEFT JOIN quiet q    ON q.ig_user_id = p.ig_user_id
LEFT JOIN ig_users u ON u.id = p.ig_user_id
LEFT JOIN keywords k ON k.id = p.last_keyword_id
`.trim();

export interface GuideJourneyLeakRow {
  igUserId: string;
  username: string | null;
  lastKeyword: string | null;
  cards: number;
  lastAskedAt: Date;
  bucket: QuietBucket | WallBucket;
}

export interface GuideJourneyLeakList {
  leak: GuideJourneyLeak;
  rows: GuideJourneyLeakRow[];
}

/** $4 = leak, $5 = limit. Newest first: the freshest are the ones still worth acting on. */
export const GUIDE_JOURNEY_LEAK_SQL = `
SELECT "igUserId", "username", "lastKeyword", "cards", "lastAskedAt",
  CASE WHEN $4::text = 'never-said-yes' THEN "quietBucket" ELSE "wallBucket" END AS "bucket"
FROM (${GUIDE_JOURNEY_SQL}) person
WHERE CASE WHEN $4::text = 'never-said-yes' THEN "quietBucket" IS NOT NULL
           ELSE "wallBucket" IS NOT NULL END
ORDER BY "lastAskedAt" DESC
LIMIT $5
`.trim();
