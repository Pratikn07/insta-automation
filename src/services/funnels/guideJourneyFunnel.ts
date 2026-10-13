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
import { GUIDE_FOLLOW_MIN_SAMPLE } from "./guideFollowFunnel.js";

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
  leaks: {
    neverSaidYes: { total: number; buckets: Record<QuietBucket, number> };
    stuckAtWall: { total: number; buckets: Record<WallBucket, number> };
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
      neverSaidYes: {
        total: quiet.filter((b) => b !== null).length,
        buckets: bucketCounts(QUIET_BUCKETS, quiet),
      },
      stuckAtWall: {
        total: wall.filter((b) => b !== null).length,
        buckets: bucketCounts(WALL_BUCKETS, wall),
      },
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
