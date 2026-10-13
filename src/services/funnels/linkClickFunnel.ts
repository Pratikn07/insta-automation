// src/services/funnels/linkClickFunnel.ts
import {
  type FunnelDef,
  type FunnelHeadline,
  type FunnelStageCount,
  type GuardedRate,
  guardedRate,
  toStageCounts,
} from "./types.js";

export const LINK_CLICK_MIN_SAMPLE = 5;

export const linkClickDef: FunnelDef = {
  key: "link-click",
  name: "Comment → link click",
  question: "Of the people who ask for a link guide, how many open the page, and which reels send the most?",
  headline: {
    fromStage: "linkSent",
    toStage: "clicked",
    label: "Click rate",
    rationale:
      "A link guide has no follow step, so the only loss after the message is a parent who never taps the button. This is the number the link pilot is judged on.",
  },
  minSample: LINK_CLICK_MIN_SAMPLE,
  stages: [
    {
      key: "entered",
      label: "Asked for a link guide",
      definition:
        "Commented or messaged a keyword whose guide is set to Link. Counted once per conversation on its first keyword_matched inside the window.",
    },
    {
      key: "linkSent",
      label: "Got the link",
      definition:
        "Meta accepted the link message, on the first try or a retry. A parent whose settings block messages, or whose send kept failing, does not count.",
    },
    {
      key: "clicked",
      label: "Opened the page",
      definition:
        "Tapped the button at least once from a real browser. Link-preview bots and HEAD requests are recorded but never count here.",
    },
    {
      key: "followingMeasured",
      label: "Following (first reading)",
      definition:
        "Of the parents who opened the page, measured as following when the recheck worker read them about 3 days later. Nobody was asked to follow first.",
      coverageOnly: true,
    },
  ],
};

/** One row per conversation in the cohort. Shape returned by LINK_CLICK_COHORT_SQL. */
export interface LinkClickRow {
  conversationId: string;
  mediaId: string | null;
  linkSent: boolean;
  clicked: boolean;
  rechecked: boolean;
  followsNow: boolean | null;
}

/**
 * Parameters: $1 from (timestamptz, inclusive), $2 to (exclusive). Read-only.
 * Reads event_log, conversations, ig_users, guide_link_send and guide_link_click.
 */
export const LINK_CLICK_COHORT_SQL = `
WITH cohort AS (
  SELECT
    (e.payload->>'conversationId')::uuid AS conversation_id,
    MIN(e.payload->>'mediaId')           AS media_id
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND e.payload->>'deliveryMode' = 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
)
SELECT
  co.conversation_id::text AS "conversationId",
  co.media_id              AS "mediaId",
  EXISTS (
    SELECT 1 FROM guide_link_send s
    WHERE s.conversation_id = co.conversation_id AND s.status = 'sent'
  )                        AS "linkSent",
  EXISTS (
    SELECT 1 FROM guide_link_send s
    JOIN guide_link_click k ON k.send_id = s.id
    WHERE s.conversation_id = co.conversation_id AND k.is_bot = false
  )                        AS "clicked",
  (c.follow_rechecked_at IS NOT NULL) AS "rechecked",
  u.is_follower            AS "followsNow"
FROM cohort co
JOIN conversations c ON c.id = co.conversation_id
LEFT JOIN ig_users u ON u.id = c.ig_user_id
ORDER BY co.conversation_id
`.trim();

export interface LinkClickReelBreakdown {
  mediaId: string | null;
  entered: number;
  linkSent: number;
  clicked: number;
  clickRate: GuardedRate;
}

export interface LinkClickResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  cohortSize: number;
  stages: FunnelStageCount[];
  headline: FunnelHeadline & { rate: GuardedRate };
  /** Following at the ~3-day recheck, among clickers the worker has read. */
  followedAnyway: GuardedRate;
  byReel: LinkClickReelBreakdown[];
}

/** Pure summarizer. No database, no clock: everything comes from `rows`. */
export function summarizeLinkClick(
  rows: LinkClickRow[],
  window: { from: string; to: string },
  minSample: number = LINK_CLICK_MIN_SAMPLE,
): LinkClickResult {
  const counts: Record<string, number> = {
    entered: rows.length,
    linkSent: rows.filter((r) => r.linkSent).length,
    clicked: rows.filter((r) => r.clicked).length,
    followingMeasured: rows.filter((r) => r.clicked && r.rechecked && r.followsNow === true).length,
  };
  const recheckedClickers = rows.filter((r) => r.clicked && r.rechecked).length;

  const reels = new Map<string | null, { entered: number; linkSent: number; clicked: number }>();
  for (const r of rows) {
    const reel = reels.get(r.mediaId) ?? { entered: 0, linkSent: 0, clicked: 0 };
    reel.entered += 1;
    if (r.linkSent) reel.linkSent += 1;
    if (r.clicked) reel.clicked += 1;
    reels.set(r.mediaId, reel);
  }
  const byReel = [...reels.entries()]
    .map(([mediaId, reel]) => ({
      mediaId,
      ...reel,
      clickRate: guardedRate(reel.clicked, reel.linkSent, minSample),
    }))
    .sort((a, b) => b.clicked - a.clicked || b.entered - a.entered || String(a.mediaId).localeCompare(String(b.mediaId)));

  return {
    key: linkClickDef.key,
    name: linkClickDef.name,
    question: linkClickDef.question,
    window,
    cohortSize: rows.length,
    stages: toStageCounts(linkClickDef.stages, counts),
    headline: { ...linkClickDef.headline, rate: guardedRate(counts.clicked!, counts.linkSent!, minSample) },
    followedAnyway: guardedRate(counts.followingMeasured!, recheckedClickers, minSample),
    byReel,
  };
}
