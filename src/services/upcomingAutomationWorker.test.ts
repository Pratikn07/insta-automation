import { beforeEach, describe, expect, it, vi } from "vitest";

const upcomingFindMany = vi.fn();
const upcomingUpdateMany = vi.fn();
const eventFindFirst = vi.fn();
const fetchMediaPublishedSince = vi.fn();
const bindUpcomingAutomationToMedia = vi.fn();
const logEvent = vi.fn();
const describeGraphError = vi.fn(() => ({
  category: "graph_transport",
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
  transportCode: "ETIMEDOUT",
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    upcomingAutomation: { findMany: upcomingFindMany, updateMany: upcomingUpdateMany },
    eventLog: { findFirst: eventFindFirst },
  },
}));
vi.mock("../meta/fetchMedia.js", () => ({ fetchMediaPublishedSince }));
vi.mock("./upcomingAutomationBinding.js", () => ({ bindUpcomingAutomationToMedia }));
vi.mock("./eventLogger.js", () => ({ logEvent, describeGraphError }));

const { runUpcomingAutomationDiscoveryTick } = await import("./upcomingAutomationWorker.js");

const waiting = (id: string, triggerWord: string, createdAt: string) => ({
  id,
  triggerWord,
  createdAt: new Date(createdAt),
});

const media = (id: string, caption: string, timestamp: string, kind: "reel" | "carousel") => ({
  id,
  caption,
  timestamp,
  kind,
  mediaType: kind === "reel" ? "VIDEO" : "CAROUSEL_ALBUM",
  mediaProductType: kind === "reel" ? "REELS" : "FEED",
  thumbnailUrl: null,
  permalink: `https://www.instagram.com/${kind === "reel" ? "reel" : "p"}/${id}/`,
});

beforeEach(() => {
  vi.clearAllMocks();
  upcomingFindMany.mockResolvedValue([]);
  upcomingUpdateMany.mockResolvedValue({ count: 1 });
  eventFindFirst.mockResolvedValue(null);
  fetchMediaPublishedSince.mockResolvedValue([]);
  bindUpcomingAutomationToMedia.mockResolvedValue({
    kind: "bound",
    keywordId: "keyword-1",
    adopted: false,
  });
  logEvent.mockResolvedValue(undefined);
});

describe("runUpcomingAutomationDiscoveryTick", () => {
  it("does not call Meta when no waiting setup exists", async () => {
    await expect(runUpcomingAutomationDiscoveryTick()).resolves.toEqual({
      status: "idle",
      scanned: 0,
      bound: 0,
    });

    expect(fetchMediaPublishedSince).not.toHaveBeenCalled();
  });

  it("catches up from the oldest setup and binds both Reels and feed posts", async () => {
    upcomingFindMany.mockResolvedValue([
      waiting("setup-reel", "REELWORD", "2026-08-16T18:00:00.000Z"),
      waiting("setup-feed", "FEEDWORD", "2026-08-17T18:00:00.000Z"),
    ]);
    fetchMediaPublishedSince.mockResolvedValue([
      media("reel-1", "Comment REELWORD", "2026-08-27T17:30:00+0000", "reel"),
      media("feed-1", "Comment ‘feedword’!", "2026-08-28T17:30:00+0000", "carousel"),
    ]);

    const result = await runUpcomingAutomationDiscoveryTick();

    expect(fetchMediaPublishedSince).toHaveBeenCalledWith(
      new Date("2026-08-16T18:00:00.000Z"),
    );
    expect(bindUpcomingAutomationToMedia).toHaveBeenCalledTimes(2);
    expect(bindUpcomingAutomationToMedia).toHaveBeenCalledWith({
      setupId: "setup-reel",
      media: expect.objectContaining({ id: "reel-1", kind: "reel" }),
      source: "worker",
    });
    expect(bindUpcomingAutomationToMedia).toHaveBeenCalledWith({
      setupId: "setup-feed",
      media: expect.objectContaining({ id: "feed-1", kind: "carousel" }),
      source: "worker",
    });
    expect(result).toEqual({ status: "ok", scanned: 2, bound: 2 });
  });

  it("never guesses when more than one newly published post matches one setup", async () => {
    upcomingFindMany.mockResolvedValue([
      waiting("setup-1", "SLEEP", "2026-08-16T18:00:00.000Z"),
    ]);
    fetchMediaPublishedSince.mockResolvedValue([
      media("media-1", "Comment SLEEP", "2026-08-27T17:30:00+0000", "reel"),
      media("media-2", "Comment SLEEP", "2026-08-28T17:30:00+0000", "reel"),
    ]);

    const result = await runUpcomingAutomationDiscoveryTick();

    expect(bindUpcomingAutomationToMedia).not.toHaveBeenCalled();
    expect(upcomingUpdateMany).toHaveBeenCalledWith({
      where: { id: "setup-1", status: "waiting" },
      data: {
        status: "needs_attention",
        errorCode: "multiple_media_matches",
        lastAttemptAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ status: "ok", scanned: 2, bound: 0 });
  });

  it("leaves waiting rows retryable when Meta is temporarily unavailable", async () => {
    upcomingFindMany.mockResolvedValue([
      waiting("setup-1", "SLEEP", "2026-08-16T18:00:00.000Z"),
    ]);
    fetchMediaPublishedSince.mockRejectedValue(new Error("private provider detail"));

    const result = await runUpcomingAutomationDiscoveryTick();

    expect(result).toEqual({ status: "graph_error", scanned: 0, bound: 0 });
    expect(upcomingUpdateMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("upcoming_automation_graph_failed", {
      source: "worker",
      ...describeGraphError.mock.results[0]?.value,
    });
  });

  it("records a caption keyword with no setup only once", async () => {
    upcomingFindMany.mockResolvedValue([
      waiting("setup-1", "SLEEP", "2026-08-16T18:00:00.000Z"),
    ]);
    fetchMediaPublishedSince.mockResolvedValue([
      media("media-1", "Comment POTTY", "2026-08-27T17:30:00+0000", "reel"),
    ]);

    await runUpcomingAutomationDiscoveryTick();

    expect(eventFindFirst).toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("upcoming_automation_unmatched_media", {
      mediaId: "media-1",
      triggerWord: "POTTY",
      mediaTimestamp: "2026-08-27T17:30:00+0000",
    });
  });
});
