import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { AccountMedia } from "../meta/fetchMedia.js";
import { fetchAllFeedPosts } from "../meta/fetchMedia.js";
import {
  fetchFeedFollowCount,
  isGraphAuthenticationError,
  type FeedFollowMetricResult,
} from "../meta/mediaFollowFetcher.js";
import { describeGraphError, logEvent } from "./eventLogger.js";

const FEED_SCOPE = "feed";
const PER_POST_GAP_MS = 1_500;
const COLLECTOR_LEASE_MS = 3 * 60 * 60 * 1000;

export type FeedFollowSnapshotStatus = "ok" | "unavailable" | "failed";
export type FeedFollowRunStatus = "success" | "partial" | "failed";

export interface FeedFollowSnapshotWrite {
  mediaId: string;
  day: Date;
  capturedAt: Date;
  follows: number | null;
  status: FeedFollowSnapshotStatus;
}

interface FeedPostUpsert {
  mediaId: string;
  mediaType: string | null;
  mediaProductType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: Date | null;
  seenAt: Date;
  initialBaseline: number | null;
  initialBaselineCapturedAt: Date | null;
}

export interface FeedFollowRepository {
  beginRun(now: Date): Promise<{ startedAt: Date; runId: string } | null>;
  renewLease(runId: string, now: Date): Promise<boolean>;
  upsertPost(input: FeedPostUpsert): Promise<void>;
  setBaselineIfMissing(mediaId: string, follows: number, capturedAt: Date): Promise<void>;
  writeSnapshot(input: FeedFollowSnapshotWrite): Promise<void>;
  finishRun(runId: string, summary: FeedFollowCollectionResult): Promise<void>;
}

export interface FeedFollowCollectionResult {
  status: FeedFollowRunStatus;
  startedAt: Date;
  completedAt: Date;
  eligibleCount: number;
  writtenCount: number;
  unavailableCount: number;
  failedCount: number;
  abortedForAuthentication: boolean;
  errors: Array<{ mediaId: string | null; details: Record<string, unknown> }>;
}

export interface FeedFollowCollectorDependencies {
  repository: FeedFollowRepository;
  listPosts(): Promise<AccountMedia[]>;
  fetchFollowCount(mediaId: string): Promise<FeedFollowMetricResult>;
  isAuthenticationError(error: unknown): boolean;
  pause(ms: number): Promise<void>;
  recordEvent(result: FeedFollowCollectionResult): Promise<void>;
  describeError(error: unknown): Record<string, unknown>;
  clock?: () => Date;
}

export function toFeedFollowEvent(result: FeedFollowCollectionResult): object {
  return {
    ...result,
    startedAt: result.startedAt.toISOString(),
    completedAt: result.completedAt.toISOString(),
  };
}

function asDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function errorMessage(details: Record<string, unknown>): string {
  const message = details.message;
  return typeof message === "string" ? message : JSON.stringify(details);
}

export function createPrismaFeedFollowRepository(client: PrismaClient): FeedFollowRepository {
  return {
    async beginRun(now) {
      const runId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + COLLECTOR_LEASE_MS);
      await client.feedFollowCollectorState.createMany({
        data: [{ scope: FEED_SCOPE, startedAt: now }],
        skipDuplicates: true,
      });
      const acquired = await client.feedFollowCollectorState.updateMany({
        where: {
          scope: FEED_SCOPE,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          leaseOwner: runId,
          leaseExpiresAt,
          lastAttemptAt: now,
          lastStatus: "running",
          lastError: null,
        },
      });
      if (acquired.count === 0) return null;
      const state = await client.feedFollowCollectorState.findUnique({
        where: { scope: FEED_SCOPE },
        select: { startedAt: true },
      });
      if (!state) throw new Error("feed_follow_collector_state_missing_after_lease");
      return { startedAt: state.startedAt, runId };
    },

    async renewLease(runId, now) {
      const renewed = await client.feedFollowCollectorState.updateMany({
        where: {
          scope: FEED_SCOPE,
          leaseOwner: runId,
          leaseExpiresAt: { gt: now },
        },
        data: {
          leaseExpiresAt: new Date(now.getTime() + COLLECTOR_LEASE_MS),
        },
      });
      return renewed.count === 1;
    },

    async upsertPost(input) {
      const metadata = {
        mediaType: input.mediaType,
        mediaProductType: input.mediaProductType,
        caption: input.caption,
        permalink: input.permalink,
        thumbnailUrl: input.thumbnailUrl,
        postedAt: input.postedAt,
        lastSeenAt: input.seenAt,
      };
      await client.feedPostMeta.upsert({
        where: { mediaId: input.mediaId },
        create: {
          mediaId: input.mediaId,
          ...metadata,
          firstSeenAt: input.seenAt,
          baselineFollows: input.initialBaseline,
          baselineCapturedAt: input.initialBaselineCapturedAt,
        },
        update: metadata,
      });
    },

    async setBaselineIfMissing(mediaId, follows, capturedAt) {
      await client.feedPostMeta.updateMany({
        where: { mediaId, baselineFollows: null },
        data: { baselineFollows: follows, baselineCapturedAt: capturedAt },
      });
    },

    async writeSnapshot(input) {
      if (input.status === "ok") {
        if (input.follows === null) throw new Error("ok_feed_follow_snapshot_requires_count");
        await client.$executeRaw`
          INSERT INTO "feed_follow_daily_snapshot"
            ("media_id", "day", "captured_at", "follows", "status")
          VALUES
            (${input.mediaId}, ${input.day}, ${input.capturedAt}, ${input.follows}, 'ok')
          ON CONFLICT ("media_id", "day") DO UPDATE SET
            "captured_at" = EXCLUDED."captured_at",
            "follows" = EXCLUDED."follows",
            "status" = EXCLUDED."status"
          WHERE "feed_follow_daily_snapshot"."status" <> 'ok'
            OR "feed_follow_daily_snapshot"."captured_at" <= EXCLUDED."captured_at"
        `;
        return;
      }

      // A newer unsuccessful attempt replaces an older unsuccessful attempt,
      // but can never erase a successful reading from the same UTC day.
      await client.$executeRaw`
        INSERT INTO "feed_follow_daily_snapshot"
          ("media_id", "day", "captured_at", "follows", "status")
        VALUES
          (${input.mediaId}, ${input.day}, ${input.capturedAt}, NULL, ${input.status})
        ON CONFLICT ("media_id", "day") DO UPDATE SET
          "captured_at" = EXCLUDED."captured_at",
          "follows" = NULL,
          "status" = EXCLUDED."status"
        WHERE "feed_follow_daily_snapshot"."status" <> 'ok'
          AND "feed_follow_daily_snapshot"."captured_at" <= EXCLUDED."captured_at"
      `;
    },

    async finishRun(runId, summary) {
      const lastError = summary.errors[0]?.details
        ? errorMessage(summary.errors[0].details)
        : null;
      await client.feedFollowCollectorState.updateMany({
        where: { scope: FEED_SCOPE, leaseOwner: runId },
        data: {
          lastCompletedAt: summary.completedAt,
          lastStatus: summary.status,
          eligibleCount: summary.eligibleCount,
          writtenCount: summary.writtenCount,
          unavailableCount: summary.unavailableCount,
          failedCount: summary.failedCount,
          lastError,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    },
  };
}

/** Collect one latest cumulative follows reading per FEED post for the UTC day. */
export async function collectFeedFollowSnapshot(
  deps: FeedFollowCollectorDependencies,
  now = new Date(),
): Promise<FeedFollowCollectionResult | null> {
  const lease = await deps.repository.beginRun(now);
  if (!lease) return null;
  const { startedAt, runId } = lease;
  const clock = deps.clock ?? (() => new Date());
  let posts: AccountMedia[];
  const errors: FeedFollowCollectionResult["errors"] = [];

  try {
    posts = await deps.listPosts();
  } catch (error) {
    errors.push({ mediaId: null, details: deps.describeError(error) });
    const failed: FeedFollowCollectionResult = {
      status: "failed",
      startedAt,
      completedAt: clock(),
      eligibleCount: 0,
      writtenCount: 0,
      unavailableCount: 0,
      failedCount: 1,
      abortedForAuthentication: deps.isAuthenticationError(error),
      errors,
    };
    await deps.repository.finishRun(runId, failed);
    await deps.recordEvent(failed);
    return failed;
  }

  let writtenCount = 0;
  let unavailableCount = 0;
  let failedCount = 0;
  let abortedForAuthentication = false;
  for (let index = 0; index < posts.length; index++) {
    const media = posts[index]!;
    const postedAt = asDate(media.timestamp);
    const wasPublishedAfterTrackingStarted = postedAt !== null && postedAt >= startedAt;
    let metric: FeedFollowMetricResult | null = null;
    let metricError: unknown;
    let metricFailed = false;

    try {
      metric = await deps.fetchFollowCount(media.id);
    } catch (error) {
      metricError = error;
      metricFailed = true;
    }
    const capturedAt = clock();
    const day = utcDay(capturedAt);

    // Fence every persistence group with an ownership check. A collector that
    // stalled beyond its lease must stop before an active successor's data can
    // be touched, even if its Graph request eventually returned.
    if (!(await deps.repository.renewLease(runId, capturedAt))) {
      throw new Error("feed_follow_collector_lease_lost");
    }

    try {
      await deps.repository.upsertPost({
        mediaId: media.id,
        mediaType: media.mediaType,
        mediaProductType: media.mediaProductType,
        caption: media.caption,
        permalink: media.permalink,
        thumbnailUrl: media.thumbnailUrl,
        postedAt,
        seenAt: capturedAt,
        initialBaseline: wasPublishedAfterTrackingStarted ? 0 : null,
        initialBaselineCapturedAt: wasPublishedAfterTrackingStarted ? postedAt : null,
      });

      if (metricFailed) throw metricError;
      if (!metric) throw new Error("feed_follow_metric_missing_without_error");
      if (metric.status === "ok") {
        if (!wasPublishedAfterTrackingStarted) {
          await deps.repository.setBaselineIfMissing(media.id, metric.follows, capturedAt);
        }
        await deps.repository.writeSnapshot({
          mediaId: media.id,
          day,
          capturedAt,
          follows: metric.follows,
          status: "ok",
        });
        writtenCount++;
      } else {
        await deps.repository.writeSnapshot({
          mediaId: media.id,
          day,
          capturedAt,
          follows: null,
          status: "unavailable",
        });
        unavailableCount++;
      }
    } catch (error) {
      failedCount++;
      errors.push({ mediaId: media.id, details: deps.describeError(error) });
      try {
        await deps.repository.writeSnapshot({
          mediaId: media.id,
          day,
          capturedAt,
          follows: null,
          status: "failed",
        });
      } catch {
        // Metadata/DB failures can make the FK unavailable. The run summary is
        // still the authoritative failure signal, so do not mask the root error.
      }
      if (deps.isAuthenticationError(error)) {
        abortedForAuthentication = true;
        break;
      }
    }

    if (index < posts.length - 1) await deps.pause(PER_POST_GAP_MS);
  }

  const status: FeedFollowRunStatus = abortedForAuthentication
    ? "failed"
    : unavailableCount > 0 || failedCount > 0
      ? "partial"
      : "success";
  const result: FeedFollowCollectionResult = {
    status,
    startedAt,
    completedAt: clock(),
    eligibleCount: posts.length,
    writtenCount,
    unavailableCount,
    failedCount,
    abortedForAuthentication,
    errors,
  };
  await deps.repository.finishRun(runId, result);
  await deps.recordEvent(result);
  return result;
}

/** Wrap any collector in a non-throwing, in-process overlap guard. */
export function createFeedFollowSnapshotRunner(
  run: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
}

const runtimeRepository = createPrismaFeedFollowRepository(prisma);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const runFeedFollowSnapshotTick = createFeedFollowSnapshotRunner(
  async () => {
    const result = await collectFeedFollowSnapshot({
      repository: runtimeRepository,
      listPosts: fetchAllFeedPosts,
      fetchFollowCount: fetchFeedFollowCount,
      isAuthenticationError: isGraphAuthenticationError,
      pause: sleep,
      recordEvent: (summary) => logEvent("feed_follow_snapshot", toFeedFollowEvent(summary)),
      describeError: describeGraphError,
    });
    if (!result) {
      logger.debug("Feed follow snapshot skipped; another process holds the lease");
      return;
    }
    const context = {
      status: result.status,
      eligible: result.eligibleCount,
      written: result.writtenCount,
      unavailable: result.unavailableCount,
      failed: result.failedCount,
    };
    if (result.status === "success") logger.info(context, "Feed follow snapshot complete");
    else logger.warn(context, "Feed follow snapshot incomplete");
  },
  (error) => logger.error(describeGraphError(error), "feedFollowSnapshotWorker tick failed"),
);
