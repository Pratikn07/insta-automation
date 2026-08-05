import type { PrismaClient } from "@prisma/client";
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
  beginRun(now: Date): Promise<{ startedAt: Date }>;
  upsertPost(input: FeedPostUpsert): Promise<void>;
  setBaselineIfMissing(mediaId: string, follows: number, capturedAt: Date): Promise<void>;
  writeSnapshot(input: FeedFollowSnapshotWrite): Promise<void>;
  finishRun(summary: FeedFollowCollectionResult): Promise<void>;
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
      return client.feedFollowCollectorState.upsert({
        where: { scope: FEED_SCOPE },
        create: {
          scope: FEED_SCOPE,
          startedAt: now,
          lastAttemptAt: now,
          lastStatus: "running",
        },
        update: {
          lastAttemptAt: now,
          lastStatus: "running",
          lastError: null,
        },
        select: { startedAt: true },
      });
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
        await client.feedFollowDailySnapshot.upsert({
          where: { mediaId_day: { mediaId: input.mediaId, day: input.day } },
          create: input,
          update: {
            capturedAt: input.capturedAt,
            follows: input.follows,
            status: input.status,
          },
        });
        return;
      }

      // An insert-ignore is deliberately asymmetric with the successful
      // upsert: a later failure on the same UTC day can never erase good data.
      await client.feedFollowDailySnapshot.createMany({ data: [input], skipDuplicates: true });
    },

    async finishRun(summary) {
      const lastError = summary.errors[0]?.details
        ? errorMessage(summary.errors[0].details)
        : null;
      await client.feedFollowCollectorState.update({
        where: { scope: FEED_SCOPE },
        data: {
          lastCompletedAt: summary.completedAt,
          lastStatus: summary.status,
          eligibleCount: summary.eligibleCount,
          writtenCount: summary.writtenCount,
          unavailableCount: summary.unavailableCount,
          failedCount: summary.failedCount,
          lastError,
        },
      });
    },
  };
}

/** Collect one latest cumulative follows reading per FEED post for the UTC day. */
export async function collectFeedFollowSnapshot(
  deps: FeedFollowCollectorDependencies,
  now = new Date(),
): Promise<FeedFollowCollectionResult> {
  const { startedAt } = await deps.repository.beginRun(now);
  let posts: AccountMedia[];
  const errors: FeedFollowCollectionResult["errors"] = [];

  try {
    posts = await deps.listPosts();
  } catch (error) {
    errors.push({ mediaId: null, details: deps.describeError(error) });
    const failed: FeedFollowCollectionResult = {
      status: "failed",
      startedAt,
      completedAt: new Date(),
      eligibleCount: 0,
      writtenCount: 0,
      unavailableCount: 0,
      failedCount: 1,
      abortedForAuthentication: deps.isAuthenticationError(error),
      errors,
    };
    await deps.repository.finishRun(failed);
    await deps.recordEvent(failed);
    return failed;
  }

  let writtenCount = 0;
  let unavailableCount = 0;
  let failedCount = 0;
  let abortedForAuthentication = false;
  const day = utcDay(now);

  for (let index = 0; index < posts.length; index++) {
    const media = posts[index]!;
    const postedAt = asDate(media.timestamp);
    const wasPublishedAfterTrackingStarted = postedAt !== null && postedAt >= startedAt;

    try {
      await deps.repository.upsertPost({
        mediaId: media.id,
        mediaType: media.mediaType,
        mediaProductType: media.mediaProductType,
        caption: media.caption,
        permalink: media.permalink,
        thumbnailUrl: media.thumbnailUrl,
        postedAt,
        seenAt: now,
        initialBaseline: wasPublishedAfterTrackingStarted ? 0 : null,
        initialBaselineCapturedAt: wasPublishedAfterTrackingStarted ? postedAt : null,
      });

      const metric = await deps.fetchFollowCount(media.id);
      if (metric.status === "ok") {
        if (!wasPublishedAfterTrackingStarted) {
          await deps.repository.setBaselineIfMissing(media.id, metric.follows, now);
        }
        await deps.repository.writeSnapshot({
          mediaId: media.id,
          day,
          capturedAt: now,
          follows: metric.follows,
          status: "ok",
        });
        writtenCount++;
      } else {
        await deps.repository.writeSnapshot({
          mediaId: media.id,
          day,
          capturedAt: now,
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
          capturedAt: now,
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
    completedAt: new Date(),
    eligibleCount: posts.length,
    writtenCount,
    unavailableCount,
    failedCount,
    abortedForAuthentication,
    errors,
  };
  await deps.repository.finishRun(result);
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
  (error) => logger.error({ error }, "feedFollowSnapshotWorker tick failed"),
);
