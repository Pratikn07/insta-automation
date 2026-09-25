import type { AccountMedia } from "../meta/fetchMedia.js";
import { fetchMediaPublishedSince } from "../meta/fetchMedia.js";
import { prisma } from "../lib/prisma.js";
import { describeGraphError, logEvent } from "./eventLogger.js";
import { bindUpcomingAutomationToMedia } from "./upcomingAutomationBinding.js";
import { parseUpcomingCaptionInstruction } from "./upcomingCaptionParser.js";

type WaitingSetup = { id: string; triggerWord: string; createdAt: Date };

export type UpcomingDiscoveryTickResult = {
  status: "idle" | "ok" | "graph_error";
  scanned: number;
  bound: number;
};

function postedAt(media: AccountMedia): Date | null {
  if (!media.timestamp) return null;
  const date = new Date(media.timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eligibleSetup(
  setupsByWord: Map<string, WaitingSetup>,
  triggerWord: string,
  media: AccountMedia,
): WaitingSetup | null {
  const setup = setupsByWord.get(triggerWord);
  if (!setup) return null;
  const published = postedAt(media);
  return published && published > setup.createdAt ? setup : null;
}

async function markNeedsAttention(
  setupId: string,
  errorCode: string,
  mediaId?: string,
): Promise<void> {
  const updated = await prisma.upcomingAutomation.updateMany({
    where: { id: setupId, status: "waiting" },
    data: {
      status: "needs_attention",
      errorCode,
      lastAttemptAt: new Date(),
      ...(mediaId && { matchedMediaId: mediaId }),
    },
  });
  if (updated.count > 0) {
    await logEvent("upcoming_automation_rejected", {
      upcomingAutomationId: setupId,
      mediaId: mediaId ?? null,
      source: "worker",
      errorCode,
    });
  }
}

async function logUnmatchedMedia(media: AccountMedia, triggerWord: string): Promise<void> {
  const alreadyLogged = await prisma.eventLog.findFirst({
    where: {
      kind: "upcoming_automation_unmatched_media",
      payload: { path: ["mediaId"], equals: media.id },
    },
    select: { id: true },
  });
  if (alreadyLogged) return;

  await logEvent("upcoming_automation_unmatched_media", {
    mediaId: media.id,
    triggerWord,
    mediaTimestamp: media.timestamp,
  });
}

export async function runUpcomingAutomationDiscoveryTick(): Promise<UpcomingDiscoveryTickResult> {
  const waiting = await prisma.upcomingAutomation.findMany({
    where: { status: "waiting" },
    orderBy: { createdAt: "asc" },
    select: { id: true, triggerWord: true, createdAt: true },
  });
  if (waiting.length === 0) return { status: "idle", scanned: 0, bound: 0 };

  let media: AccountMedia[];
  try {
    media = await fetchMediaPublishedSince(waiting[0]!.createdAt);
  } catch (error) {
    await logEvent("upcoming_automation_graph_failed", {
      source: "worker",
      ...describeGraphError(error),
    });
    return { status: "graph_error", scanned: 0, bound: 0 };
  }

  const setupsByWord = new Map(waiting.map((setup) => [setup.triggerWord, setup]));
  const mediaBySetup = new Map<string, AccountMedia[]>();
  const rejected = new Set<string>();

  for (const item of media) {
    const instruction = parseUpcomingCaptionInstruction(
      item.caption,
      waiting.map((setup) => setup.triggerWord),
    );
    if (instruction.kind === "missing") continue;

    if (instruction.kind === "ambiguous") {
      for (const word of new Set(instruction.keywords)) {
        const setup = eligibleSetup(setupsByWord, word, item);
        if (!setup || rejected.has(setup.id)) continue;
        rejected.add(setup.id);
        await markNeedsAttention(setup.id, "caption_instruction_ambiguous", item.id);
      }
      continue;
    }

    const setup = eligibleSetup(setupsByWord, instruction.keyword, item);
    if (!setup) {
      await logUnmatchedMedia(item, instruction.keyword);
      continue;
    }
    const matches = mediaBySetup.get(setup.id) ?? [];
    matches.push(item);
    mediaBySetup.set(setup.id, matches);
  }

  let bound = 0;
  for (const setup of waiting) {
    if (rejected.has(setup.id)) continue;
    const matches = mediaBySetup.get(setup.id) ?? [];
    if (matches.length > 1) {
      await markNeedsAttention(setup.id, "multiple_media_matches");
      continue;
    }
    if (matches.length === 0) continue;

    try {
      const result = await bindUpcomingAutomationToMedia({
        setupId: setup.id,
        media: matches[0]!,
        source: "worker",
      });
      if (result.kind === "bound") bound += 1;
    } catch {
      await logEvent("upcoming_automation_bind_failed", {
        upcomingAutomationId: setup.id,
        mediaId: matches[0]!.id,
        source: "worker",
        errorCode: "database_error",
      });
    }
  }

  return { status: "ok", scanned: media.length, bound };
}
