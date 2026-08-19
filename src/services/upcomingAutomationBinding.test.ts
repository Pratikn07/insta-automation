import { beforeEach, describe, expect, it, vi } from "vitest";

const upcomingFindUnique = vi.fn();
const upcomingUpdate = vi.fn();
const keywordFindMany = vi.fn();
const keywordCreate = vi.fn();
const queryRaw = vi.fn();
const transaction = vi.fn();
const backfillKeyword = vi.fn();
const logEvent = vi.fn();
const invalidateMediaCache = vi.fn();
const resourceFindUnique = vi.fn();

const tx = {
  $queryRaw: queryRaw,
  upcomingAutomation: { findUnique: upcomingFindUnique, update: upcomingUpdate },
  keyword: { findMany: keywordFindMany, create: keywordCreate },
  // The binder checks the guide has steps before attaching anything.
  resource: { findUnique: resourceFindUnique },
};

vi.mock("../lib/prisma.js", () => ({
  prisma: { $transaction: transaction },
}));
vi.mock("./keywordBackfillService.js", () => ({ backfillKeyword }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../meta/fetchMedia.js", () => ({ invalidateMediaCache }));

const { bindUpcomingAutomationToMedia } = await import("./upcomingAutomationBinding.js");

const setup = {
  id: "11111111-1111-4111-8111-111111111111",
  triggerWord: "HIGHCHAIR",
  resourceId: "22222222-2222-4222-8222-222222222222",
  publicReply: "Sent! Check your DMs.",
  gateMessage: "Follow and reply DONE.",
  active: true,
  status: "waiting",
  createdAt: new Date("2026-08-16T18:00:00.000Z"),
  matchedMediaId: null,
  keywordId: null,
};

const media = {
  id: "media-1",
  kind: "reel" as const,
  mediaType: "VIDEO",
  mediaProductType: "REELS",
  caption: "A useful guide. Comment HIGHCHAIR!",
  thumbnailUrl: null,
  permalink: "https://www.instagram.com/reel/example/",
  timestamp: "2026-08-27T17:30:00+0000",
};

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (callback) => callback(tx));
  queryRaw.mockResolvedValue([{ id: setup.id }]);
  upcomingFindUnique.mockResolvedValue(setup);
  // A written guide by default; the empty case is asserted explicitly below.
  resourceFindUnique.mockResolvedValue({ _count: { messages: 3 } });
  keywordFindMany.mockResolvedValue([]);
  keywordCreate.mockResolvedValue({ id: "keyword-1" });
  upcomingUpdate.mockResolvedValue({});
  backfillKeyword.mockResolvedValue(0);
  logEvent.mockResolvedValue(undefined);
});

describe("bindUpcomingAutomationToMedia", () => {
  it("creates an ordinary post-scoped keyword and binds in one transaction", async () => {
    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media,
      source: "worker",
    });

    expect(result).toEqual({ kind: "bound", keywordId: "keyword-1", adopted: false });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(keywordCreate).toHaveBeenCalledWith({
      data: {
        keyword: "HIGHCHAIR",
        mediaId: "media-1",
        mediaCaption: media.caption,
        mediaPermalink: media.permalink,
        mediaPostedAt: new Date("2026-08-27T17:30:00.000Z"),
        resourceId: setup.resourceId,
        publicReply: setup.publicReply,
        gateMessage: setup.gateMessage,
        active: true,
      },
      select: { id: true },
    });
    expect(upcomingUpdate).toHaveBeenCalledWith({
      where: { id: setup.id },
      data: {
        status: "bound",
        matchedMediaId: "media-1",
        keywordId: "keyword-1",
        errorCode: null,
        lastAttemptAt: expect.any(Date),
        boundAt: expect.any(Date),
      },
    });
    expect(backfillKeyword).toHaveBeenCalledWith("keyword-1");
    expect(invalidateMediaCache).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith("upcoming_automation_bound", {
      upcomingAutomationId: setup.id,
      keywordId: "keyword-1",
      mediaId: "media-1",
      source: "worker",
      adopted: false,
    });
  });

  it("adopts an identical manually attached keyword", async () => {
    keywordFindMany.mockResolvedValue([
      {
        id: "manual-keyword",
        keyword: setup.triggerWord,
        resourceId: setup.resourceId,
        publicReply: setup.publicReply,
        gateMessage: setup.gateMessage,
        active: setup.active,
      },
    ]);

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media,
      source: "webhook",
    });

    expect(result).toEqual({ kind: "bound", keywordId: "manual-keyword", adopted: true });
    expect(keywordCreate).not.toHaveBeenCalled();
    expect(backfillKeyword).toHaveBeenCalledWith("manual-keyword");
  });

  it("fails closed when any existing media keyword has different configuration", async () => {
    keywordFindMany.mockResolvedValue([
      {
        id: "other-keyword",
        keyword: "HIGHCHAIR",
        resourceId: "different-resource",
        publicReply: setup.publicReply,
        gateMessage: setup.gateMessage,
        active: true,
      },
    ]);

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media,
      source: "worker",
    });

    expect(result).toEqual({ kind: "needs_attention", errorCode: "media_keyword_conflict" });
    expect(keywordCreate).not.toHaveBeenCalled();
    expect(backfillKeyword).not.toHaveBeenCalled();
    expect(upcomingUpdate).toHaveBeenCalledWith({
      where: { id: setup.id },
      data: {
        status: "needs_attention",
        matchedMediaId: "media-1",
        errorCode: "media_keyword_conflict",
        lastAttemptAt: expect.any(Date),
      },
    });
  });

  /**
   * A guide with no steps sends nothing, so attaching the keyword would put a live
   * trigger on a published post that answers every commenter with silence.
   *
   * The check lives here rather than at creation because this is the moment it
   * matters and the only moment the answer is still true: the setup may have been
   * created days earlier, and a guide can be emptied at any point in between.
   */
  it("refuses to attach a guide with no steps, and says so", async () => {
    resourceFindUnique.mockResolvedValue({ _count: { messages: 0 } });

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media,
      source: "worker",
    });

    expect(result).toEqual({ kind: "needs_attention", errorCode: "guide_has_no_steps" });
    expect(keywordCreate).not.toHaveBeenCalled();
    expect(backfillKeyword).not.toHaveBeenCalled();
    expect(upcomingUpdate).toHaveBeenCalledWith({
      where: { id: setup.id },
      data: {
        status: "needs_attention",
        matchedMediaId: "media-1",
        errorCode: "guide_has_no_steps",
        lastAttemptAt: expect.any(Date),
      },
    });
  });

  // Checked before the caption, because an empty guide cannot be fixed by
  // correcting the caption and reporting the caption first would mislead.
  it("reports the empty guide even when the caption is also wrong", async () => {
    resourceFindUnique.mockResolvedValue({ _count: { messages: 0 } });

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media: { ...media, caption: "No instruction at all." },
      source: "worker",
    });

    expect(result).toEqual({ kind: "needs_attention", errorCode: "guide_has_no_steps" });
  });

  it("is idempotent when another attempt already bound the row", async () => {
    upcomingFindUnique.mockResolvedValue({
      ...setup,
      status: "bound",
      keywordId: "keyword-1",
      matchedMediaId: "media-1",
    });

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media,
      source: "webhook",
    });

    expect(result).toEqual({ kind: "already_bound", keywordId: "keyword-1" });
    expect(keywordFindMany).not.toHaveBeenCalled();
    expect(keywordCreate).not.toHaveBeenCalled();
    expect(backfillKeyword).not.toHaveBeenCalled();
  });

  it("does not bind media published before the setup existed", async () => {
    const oldMedia = { ...media, timestamp: "2026-08-15T17:30:00+0000" };

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media: oldMedia,
      source: "worker",
    });

    expect(result).toEqual({ kind: "not_eligible" });
    expect(keywordFindMany).not.toHaveBeenCalled();
    expect(upcomingUpdate).not.toHaveBeenCalled();
  });

  it("requires the publication timestamp to be strictly after setup creation", async () => {
    const simultaneousMedia = { ...media, timestamp: "2026-08-16T18:00:00.000Z" };

    const result = await bindUpcomingAutomationToMedia({
      setupId: setup.id,
      media: simultaneousMedia,
      source: "worker",
    });

    expect(result).toEqual({ kind: "not_eligible" });
    expect(keywordCreate).not.toHaveBeenCalled();
  });

  it("rolls the transaction error out to the caller without starting backfill", async () => {
    upcomingUpdate.mockRejectedValue(new Error("transaction failed"));

    await expect(
      bindUpcomingAutomationToMedia({ setupId: setup.id, media, source: "worker" }),
    ).rejects.toThrow("transaction failed");

    expect(backfillKeyword).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith(
      "upcoming_automation_bound",
      expect.anything(),
    );
  });
});
