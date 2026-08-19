import { env } from "../config/env.js";
import { flags } from "./flagService.js";
import { prisma } from "../lib/prisma.js";
import { fetchMediaById } from "../meta/fetchMedia.js";
import { describeGraphError, logEvent } from "./eventLogger.js";
import { bindUpcomingAutomationToMedia } from "./upcomingAutomationBinding.js";
import { parseUpcomingCaptionInstruction } from "./upcomingCaptionParser.js";

export type UpcomingCommentBindingResult = {
  kind: "none" | "bound" | "rejected" | "graph_error";
  blockLegacyFallback: boolean;
};

type PendingSetup = {
  id: string;
  triggerWord: string;
  status: "waiting" | "needs_attention";
};

async function rejectWaitingSetups(
  setups: PendingSetup[],
  mediaId: string,
  errorCode: string,
  commentId: string,
): Promise<void> {
  for (const setup of setups) {
    if (setup.status !== "waiting") continue;
    const updated = await prisma.upcomingAutomation.updateMany({
      where: { id: setup.id, status: "waiting" },
      data: {
        status: "needs_attention",
        matchedMediaId: mediaId,
        errorCode,
        lastAttemptAt: new Date(),
      },
    });
    if (updated.count > 0) {
      await logEvent("upcoming_automation_rejected", {
        upcomingAutomationId: setup.id,
        mediaId,
        commentId,
        source: "webhook",
        errorCode,
      });
    }
  }
}

export async function bindUpcomingAutomationFromComment(input: {
  candidates: string[];
  mediaId: string | null | undefined;
  commentId: string;
}): Promise<UpcomingCommentBindingResult> {
  const candidateWords = [...new Set(input.candidates)];
  if (candidateWords.length === 0) return { kind: "none", blockLegacyFallback: false };

  const pending = (await prisma.upcomingAutomation.findMany({
    where: {
      triggerWord: { in: candidateWords },
      status: { in: ["waiting", "needs_attention"] },
    },
    select: { id: true, triggerWord: true, status: true },
  })) as PendingSetup[];
  if (pending.length === 0) return { kind: "none", blockLegacyFallback: false };

  // The flag pauses both polling and webhook binding. Reservations still guard
  // against the legacy global fallback while paused, so a prepared post can
  // never accidentally send an older guide with the same word.
  if (!flags.bool("UPCOMING_AUTOMATIONS_ENABLED")) {
    await logEvent("upcoming_automation_binding_paused", {
      commentId: input.commentId,
      mediaId: input.mediaId ?? null,
      triggerWords: pending.map((setup) => setup.triggerWord),
    });
    return { kind: "rejected", blockLegacyFallback: true };
  }

  const waiting = pending.filter((setup) => setup.status === "waiting");
  if (waiting.length === 0 || !input.mediaId) {
    return { kind: "rejected", blockLegacyFallback: true };
  }

  let media;
  try {
    media = await fetchMediaById(input.mediaId);
  } catch (error) {
    await logEvent("upcoming_automation_graph_failed", {
      source: "webhook",
      mediaId: input.mediaId,
      commentId: input.commentId,
      ...describeGraphError(error),
    });
    return { kind: "graph_error", blockLegacyFallback: true };
  }

  const instruction = parseUpcomingCaptionInstruction(media.caption);
  if (instruction.kind !== "matched") {
    const errorCode =
      instruction.kind === "missing"
        ? "caption_instruction_missing"
        : "caption_instruction_ambiguous";
    await rejectWaitingSetups(waiting, media.id, errorCode, input.commentId);
    return { kind: "rejected", blockLegacyFallback: true };
  }

  const matchingSetup = waiting.find((setup) => setup.triggerWord === instruction.keyword);
  if (!matchingSetup) {
    await rejectWaitingSetups(
      waiting,
      media.id,
      "caption_instruction_mismatch",
      input.commentId,
    );
    return { kind: "rejected", blockLegacyFallback: true };
  }

  try {
    const result = await bindUpcomingAutomationToMedia({
      setupId: matchingSetup.id,
      media,
      source: "webhook",
      excludeCommentId: input.commentId,
    });
    if (result.kind === "bound" || result.kind === "already_bound") {
      return { kind: "bound", blockLegacyFallback: false };
    }
    return { kind: "rejected", blockLegacyFallback: true };
  } catch {
    await logEvent("upcoming_automation_bind_failed", {
      upcomingAutomationId: matchingSetup.id,
      mediaId: media.id,
      commentId: input.commentId,
      source: "webhook",
      errorCode: "database_error",
    });
    return { kind: "rejected", blockLegacyFallback: true };
  }
}
