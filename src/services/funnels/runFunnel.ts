// The only impure part of the funnel layer: execute a cohort query and hand the
// rows to a pure summarizer.
//
// TWO DELIBERATE CONSTRAINTS, both in service of running this from places that
// should not hold the app's credentials:
//
//   READ-ONLY. Every statement is a single SELECT with CTEs — no writes, no
//   DDL — so a SELECT-only Postgres role can run it. That is what makes it safe
//   to hand a cloud session or an MCP client a credential at all.
//
//   DATABASE_URL AND NOTHING ELSE. This module does NOT import src/lib/prisma,
//   because that pulls in config/env, which requires the whole Meta keyring
//   (META_APP_SECRET, IG_ACCESS_TOKEN, SUPABASE_SERVICE_KEY…). A funnel report
//   has no business needing those, and requiring them would mean handing over
//   six secrets to answer one analytics question. Instead it takes any client
//   satisfying FunnelDb: the CLI passes a standalone one that needs only
//   DATABASE_URL, and a future /api/funnels endpoint can pass the app's shared
//   prisma instance.

import { PrismaClient } from "@prisma/client";
import {
  COHORT_SQL,
  EVENT_LOOKBACK_MARGIN,
  GUIDE_FOLLOW_MIN_SAMPLE,
  summarizeGuideFollow,
  type GuideFollowResult,
  type GuideFollowRow,
} from "./guideFollowFunnel.js";
import {
  DROP_OFF_BREAKDOWN_SQL,
  DROP_OFF_ROWS_SQL,
  summarizeDropOff,
  type DropOffBucket,
  type DropOffCounts,
  type DropOffRow,
  type DropOffSummary,
} from "./dropOff.js";
import {
  GUIDE_JOURNEY_LEAK_SQL,
  GUIDE_JOURNEY_SQL,
  summarizeGuideJourney,
  type GuideJourneyLeak,
  type GuideJourneyLeakList,
  type GuideJourneyLeakRow,
  type GuideJourneyResult,
  type GuideJourneyRow,
} from "./guideJourneyFunnel.js";
import {
  LINK_CLICK_COHORT_SQL,
  LINK_CLICK_MIN_SAMPLE,
  summarizeLinkClick,
  type LinkClickResult,
  type LinkClickRow,
} from "./linkClickFunnel.js";

/** The minimum a caller must provide. Satisfied by PrismaClient. */
export interface FunnelDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface FunnelWindow {
  /** Inclusive lower bound on cohort ENTRY. */
  from: Date;
  /** Exclusive upper bound on cohort ENTRY. */
  to: Date;
}

/** Default window: the 30 days ending now, matching FOLLOW_RECHECK_MAX_AGE_DAYS. */
export function defaultWindow(now: Date = new Date()): FunnelWindow {
  const to = new Date(now);
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * A client for callers outside the server process. Reads DATABASE_URL from the
 * environment via the datasource block — no other configuration required.
 */
export function createStandaloneFunnelClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. A funnel report needs a Postgres connection string " +
        "and nothing else; a SELECT-only role is sufficient (see docs/funnels.md).",
    );
  }
  return new PrismaClient({ log: ["error"] });
}

export async function fetchGuideFollowRows(
  db: FunnelDb,
  window: FunnelWindow,
): Promise<GuideFollowRow[]> {
  // $queryRawUnsafe because the statement is a module constant, not built from
  // input — the three values below are bound parameters, never interpolated.
  return db.$queryRawUnsafe<GuideFollowRow[]>(
    COHORT_SQL,
    window.from.toISOString(),
    window.to.toISOString(),
    EVENT_LOOKBACK_MARGIN,
  );
}

export async function runGuideFollowFunnel(
  db: FunnelDb,
  window: FunnelWindow = defaultWindow(),
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): Promise<GuideFollowResult> {
  const rows = await fetchGuideFollowRows(db, window);
  return summarizeGuideFollow(
    rows,
    { from: window.from.toISOString(), to: window.to.toISOString() },
    minSample,
  );
}

export async function fetchGuideJourneyRows(
  db: FunnelDb,
  window: FunnelWindow,
): Promise<GuideJourneyRow[]> {
  // $queryRawUnsafe because the statement is a module constant; the values are bound.
  return db.$queryRawUnsafe<GuideJourneyRow[]>(
    GUIDE_JOURNEY_SQL,
    window.from.toISOString(),
    window.to.toISOString(),
    EVENT_LOOKBACK_MARGIN,
  );
}

export async function runGuideJourneyFunnel(
  db: FunnelDb,
  window: FunnelWindow = defaultWindow(),
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): Promise<GuideJourneyResult> {
  const rows = await fetchGuideJourneyRows(db, window);
  return summarizeGuideJourney(
    rows,
    { from: window.from.toISOString(), to: window.to.toISOString() },
    minSample,
  );
}

export async function fetchLinkClickRows(db: FunnelDb, window: FunnelWindow): Promise<LinkClickRow[]> {
  // $queryRawUnsafe because the statement is a module constant; the values are bound.
  return db.$queryRawUnsafe<LinkClickRow[]>(
    LINK_CLICK_COHORT_SQL,
    window.from.toISOString(),
    window.to.toISOString(),
  );
}

export async function runLinkClickFunnel(
  db: FunnelDb,
  window: FunnelWindow = defaultWindow(),
  minSample: number = LINK_CLICK_MIN_SAMPLE,
): Promise<LinkClickResult> {
  const rows = await fetchLinkClickRows(db, window);
  return summarizeLinkClick(rows, { from: window.from.toISOString(), to: window.to.toISOString() }, minSample);
}

/** Default page size for a drop-off list. Enough to act on, small enough to render. */
export const DROP_OFF_DEFAULT_LIMIT = 100;
export const DROP_OFF_MAX_LIMIT = 500;

export async function runDropOff(
  db: FunnelDb,
  bucket: DropOffBucket,
  window: FunnelWindow = defaultWindow(),
  limit: number = DROP_OFF_DEFAULT_LIMIT,
  minSample: number = GUIDE_FOLLOW_MIN_SAMPLE,
): Promise<DropOffSummary> {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const capped = Math.min(Math.max(limit, 1), DROP_OFF_MAX_LIMIT);

  const [counts, rows] = await Promise.all([
    db.$queryRawUnsafe<DropOffCounts[]>(
      DROP_OFF_BREAKDOWN_SQL,
      from,
      to,
      EVENT_LOOKBACK_MARGIN,
      bucket,
    ),
    db.$queryRawUnsafe<DropOffRow[]>(
      DROP_OFF_ROWS_SQL,
      from,
      to,
      EVENT_LOOKBACK_MARGIN,
      bucket,
      capped,
    ),
  ]);

  const empty: DropOffCounts = {
    total: 0,
    expired: 0,
    stillOpen: 0,
    confirmedSeen: 0,
    trackedNeverConfirmed: 0,
    noReadData: 0,
    reminderSent: 0,
    reminderSuppressed: 0,
    inControlArm: 0,
  };
  return summarizeDropOff(bucket, counts[0] ?? empty, rows, minSample);
}

/** The people behind one journey leak, newest first. Bucket counts come from the summary. */
export async function runGuideJourneyLeak(
  db: FunnelDb,
  leak: GuideJourneyLeak,
  window: FunnelWindow = defaultWindow(),
  limit: number = DROP_OFF_DEFAULT_LIMIT,
): Promise<GuideJourneyLeakList> {
  const capped = Math.min(Math.max(limit, 1), DROP_OFF_MAX_LIMIT);
  const rows = await db.$queryRawUnsafe<GuideJourneyLeakRow[]>(
    GUIDE_JOURNEY_LEAK_SQL,
    window.from.toISOString(),
    window.to.toISOString(),
    EVENT_LOOKBACK_MARGIN,
    leak,
    capped,
  );
  return { leak, rows };
}
