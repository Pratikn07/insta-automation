import { Prisma, type UpcomingAutomation } from "@prisma/client";
import { invalidateMediaCache, type AccountMedia } from "../meta/fetchMedia.js";
import { prisma } from "../lib/prisma.js";
import { logEvent } from "./eventLogger.js";
import { backfillKeyword } from "./keywordBackfillService.js";
import { parseUpcomingCaptionInstruction } from "./upcomingCaptionParser.js";

export type UpcomingBindingSource = "worker" | "webhook";

export type UpcomingBindingResult =
  | { kind: "bound"; keywordId: string; adopted: boolean }
  | { kind: "already_bound"; keywordId: string }
  | { kind: "needs_attention"; errorCode: string }
  | { kind: "not_eligible" }
  | { kind: "resolved" };

function identicalConfiguration(
  existing: {
    keyword: string;
    resourceId: string;
    publicReply: string;
    gateMessage: string;
    active: boolean;
  },
  setup: UpcomingAutomation,
): boolean {
  return (
    existing.keyword === setup.triggerWord &&
    existing.resourceId === setup.resourceId &&
    existing.publicReply === setup.publicReply &&
    existing.gateMessage === setup.gateMessage &&
    existing.active === setup.active
  );
}

function mediaDate(timestamp: string | null): Date | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function captionError(setup: UpcomingAutomation, media: AccountMedia): string | null {
  const instruction = parseUpcomingCaptionInstruction(media.caption);
  if (instruction.kind === "missing") return "caption_instruction_missing";
  if (instruction.kind === "ambiguous") return "caption_instruction_ambiguous";
  return instruction.keyword === setup.triggerWord ? null : "caption_instruction_mismatch";
}

async function bindInTransaction(input: {
  setupId: string;
  media: AccountMedia;
  postedAt: Date | null;
}): Promise<UpcomingBindingResult> {
  return prisma.$transaction(async (tx) => {
    // The row lock is the race boundary between the minute worker and the
    // webhook fast path. Re-reading after it is acquired makes the operation
    // idempotent even when both observed the same waiting row.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "upcoming_automations" WHERE "id" = ${input.setupId}::uuid FOR UPDATE`,
    );
    const setup = await tx.upcomingAutomation.findUnique({ where: { id: input.setupId } });
    if (!setup) return { kind: "resolved" };
    if (setup.status === "bound") {
      return setup.keywordId
        ? { kind: "already_bound", keywordId: setup.keywordId }
        : { kind: "resolved" };
    }
    if (setup.status === "cancelled") return { kind: "resolved" };

    if (!input.postedAt || input.postedAt <= setup.createdAt) {
      return { kind: "not_eligible" };
    }

    const instructionError = captionError(setup, input.media);
    if (instructionError) {
      await tx.upcomingAutomation.update({
        where: { id: setup.id },
        data: {
          status: "needs_attention",
          matchedMediaId: input.media.id,
          errorCode: instructionError,
          lastAttemptAt: new Date(),
        },
      });
      return { kind: "needs_attention", errorCode: instructionError };
    }

    const existing = await tx.keyword.findMany({
      where: { mediaId: input.media.id },
      select: {
        id: true,
        keyword: true,
        resourceId: true,
        publicReply: true,
        gateMessage: true,
        active: true,
      },
    });

    if (existing.length > 0) {
      const adoptable =
        existing.length === 1 && identicalConfiguration(existing[0]!, setup)
          ? existing[0]!
          : null;
      if (!adoptable) {
        const errorCode = "media_keyword_conflict";
        await tx.upcomingAutomation.update({
          where: { id: setup.id },
          data: {
            status: "needs_attention",
            matchedMediaId: input.media.id,
            errorCode,
            lastAttemptAt: new Date(),
          },
        });
        return { kind: "needs_attention", errorCode };
      }

      const now = new Date();
      await tx.upcomingAutomation.update({
        where: { id: setup.id },
        data: {
          status: "bound",
          matchedMediaId: input.media.id,
          keywordId: adoptable.id,
          errorCode: null,
          lastAttemptAt: now,
          boundAt: now,
        },
      });
      return { kind: "bound", keywordId: adoptable.id, adopted: true };
    }

    const keyword = await tx.keyword.create({
      data: {
        keyword: setup.triggerWord,
        mediaId: input.media.id,
        mediaCaption: input.media.caption,
        mediaPermalink: input.media.permalink,
        mediaPostedAt: input.postedAt,
        resourceId: setup.resourceId,
        publicReply: setup.publicReply,
        gateMessage: setup.gateMessage,
        active: setup.active,
      },
      select: { id: true },
    });
    const now = new Date();
    await tx.upcomingAutomation.update({
      where: { id: setup.id },
      data: {
        status: "bound",
        matchedMediaId: input.media.id,
        keywordId: keyword.id,
        errorCode: null,
        lastAttemptAt: now,
        boundAt: now,
      },
    });
    return { kind: "bound", keywordId: keyword.id, adopted: false };
  });
}

export async function bindUpcomingAutomationToMedia(input: {
  setupId: string;
  media: AccountMedia;
  source: UpcomingBindingSource;
  excludeCommentId?: string;
}): Promise<UpcomingBindingResult> {
  const result = await bindInTransaction({
    setupId: input.setupId,
    media: input.media,
    postedAt: mediaDate(input.media.timestamp),
  });

  if (result.kind === "bound") {
    invalidateMediaCache();
    await logEvent("upcoming_automation_bound", {
      upcomingAutomationId: input.setupId,
      keywordId: result.keywordId,
      mediaId: input.media.id,
      source: input.source,
      adopted: result.adopted,
    });
    // The transaction is committed before recovery begins. The backfill is
    // idempotent and must never lengthen the webhook's response path.
    void (input.excludeCommentId
      ? backfillKeyword(result.keywordId, { excludeCommentIds: [input.excludeCommentId] })
      : backfillKeyword(result.keywordId));
  } else if (result.kind === "needs_attention") {
    await logEvent("upcoming_automation_rejected", {
      upcomingAutomationId: input.setupId,
      mediaId: input.media.id,
      source: input.source,
      errorCode: result.errorCode,
    });
  }

  return result;
}
