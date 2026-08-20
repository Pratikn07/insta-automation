import { beforeEach, describe, expect, it, vi } from "vitest";

const upcomingFindMany = vi.fn();
const upcomingUpdateMany = vi.fn();
const fetchMediaById = vi.fn();
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
  },
}));
vi.mock("../meta/fetchMedia.js", () => ({ fetchMediaById }));
vi.mock("./upcomingAutomationBinding.js", () => ({ bindUpcomingAutomationToMedia }));
vi.mock("./eventLogger.js", () => ({ logEvent, describeGraphError }));
vi.mock("../config/env.js", () => ({ env: {} }));
// Binding reads this flag through the service now. Fixed true, which is what the
// previous env mock supplied — this suite has never covered the paused path, where
// a reserved word blocks the legacy reply. That gap predates this change.
vi.mock("./flagService.js", () => ({
  flags: { bool: () => true, percent: () => 0 },
}));

const { bindUpcomingAutomationFromComment } = await import(
  "./upcomingAutomationCommentBinding.js"
);

const media = {
  id: "media-1",
  kind: "reel" as const,
  mediaType: "VIDEO",
  mediaProductType: "REELS",
  caption: "Comment HIGHCHAIR",
  thumbnailUrl: null,
  permalink: "https://www.instagram.com/reel/example/",
  timestamp: "2026-08-27T17:30:00+0000",
};

beforeEach(() => {
  vi.clearAllMocks();
  upcomingFindMany.mockResolvedValue([]);
  upcomingUpdateMany.mockResolvedValue({ count: 1 });
  fetchMediaById.mockResolvedValue(media);
  bindUpcomingAutomationToMedia.mockResolvedValue({
    kind: "bound",
    keywordId: "keyword-1",
    adopted: false,
  });
  logEvent.mockResolvedValue(undefined);
});

describe("bindUpcomingAutomationFromComment", () => {
  it("does not call Meta when the comment has no pending word", async () => {
    await expect(
      bindUpcomingAutomationFromComment({
        candidates: ["HELLO"],
        mediaId: "media-1",
        commentId: "comment-1",
      }),
    ).resolves.toEqual({ kind: "none", blockLegacyFallback: false });

    expect(fetchMediaById).not.toHaveBeenCalled();
  });

  it("binds before normal comment matching when the caption contract agrees", async () => {
    upcomingFindMany.mockResolvedValue([
      { id: "setup-1", triggerWord: "HIGHCHAIR", status: "waiting" },
    ]);

    const result = await bindUpcomingAutomationFromComment({
      candidates: ["HIGHCHAIR"],
      mediaId: "media-1",
      commentId: "comment-1",
    });

    expect(fetchMediaById).toHaveBeenCalledWith("media-1");
    expect(bindUpcomingAutomationToMedia).toHaveBeenCalledWith({
      setupId: "setup-1",
      media,
      source: "webhook",
      excludeCommentId: "comment-1",
    });
    expect(result).toEqual({ kind: "bound", blockLegacyFallback: false });
  });

  it.each([
    [null, "caption_instruction_missing"],
    ["Save this for later", "caption_instruction_missing"],
    ["Comment POTTY", "caption_instruction_mismatch"],
    ["Comment HIGHCHAIR. Comment POTTY.", "caption_instruction_ambiguous"],
  ])("blocks legacy fallback when the caption is %j", async (caption, errorCode) => {
    upcomingFindMany.mockResolvedValue([
      { id: "setup-1", triggerWord: "HIGHCHAIR", status: "waiting" },
    ]);
    fetchMediaById.mockResolvedValue({ ...media, caption });

    const result = await bindUpcomingAutomationFromComment({
      candidates: ["HIGHCHAIR"],
      mediaId: "media-1",
      commentId: "comment-1",
    });

    expect(result).toEqual({ kind: "rejected", blockLegacyFallback: true });
    expect(bindUpcomingAutomationToMedia).not.toHaveBeenCalled();
    expect(upcomingUpdateMany).toHaveBeenCalledWith({
      where: { id: "setup-1", status: "waiting" },
      data: {
        status: "needs_attention",
        matchedMediaId: "media-1",
        errorCode,
        lastAttemptAt: expect.any(Date),
      },
    });
  });

  it("blocks without another Meta call when the setup already needs attention", async () => {
    upcomingFindMany.mockResolvedValue([
      { id: "setup-1", triggerWord: "HIGHCHAIR", status: "needs_attention" },
    ]);

    const result = await bindUpcomingAutomationFromComment({
      candidates: ["HIGHCHAIR"],
      mediaId: "media-1",
      commentId: "comment-1",
    });

    expect(result).toEqual({ kind: "rejected", blockLegacyFallback: true });
    expect(fetchMediaById).not.toHaveBeenCalled();
  });

  it("fails closed and preserves the waiting row when the Graph read fails", async () => {
    upcomingFindMany.mockResolvedValue([
      { id: "setup-1", triggerWord: "HIGHCHAIR", status: "waiting" },
    ]);
    fetchMediaById.mockRejectedValue(new Error("private provider detail"));

    const result = await bindUpcomingAutomationFromComment({
      candidates: ["HIGHCHAIR"],
      mediaId: "media-1",
      commentId: "comment-1",
    });

    expect(result).toEqual({ kind: "graph_error", blockLegacyFallback: true });
    expect(upcomingUpdateMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("upcoming_automation_graph_failed", {
      source: "webhook",
      mediaId: "media-1",
      commentId: "comment-1",
      ...describeGraphError.mock.results[0]?.value,
    });
  });
});
