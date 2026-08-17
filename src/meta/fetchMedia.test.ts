import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const logger = { debug: vi.fn(), warn: vi.fn() };

vi.mock("./insightsGraphClient.js", () => ({ insightsGraph: { get } }));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "ig-account" } }));
vi.mock("../lib/logger.js", () => ({ logger }));

const {
  fetchAllFeedPosts,
  fetchMediaById,
  fetchMediaPublishedSince,
  invalidateMediaCache,
} = await import("./fetchMedia.js");

beforeEach(() => {
  get.mockReset();
  logger.debug.mockReset();
  logger.warn.mockReset();
  invalidateMediaCache();
});

describe("fetchAllFeedPosts", () => {
  it("returns carousel, image, feed-video and legacy feed media while excluding Reels", async () => {
    get.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: "carousel",
            media_type: "CAROUSEL_ALBUM",
            media_product_type: "FEED",
            media_url: "https://example.com/carousel.jpg",
          },
          {
            id: "image",
            media_type: "IMAGE",
            media_product_type: "FEED",
            media_url: "https://example.com/image.jpg",
          },
          {
            id: "feed-video",
            media_type: "VIDEO",
            media_product_type: "FEED",
            thumbnail_url: "https://example.com/video.jpg",
          },
          {
            id: "legacy-image",
            media_type: "IMAGE",
            media_url: "https://example.com/legacy.jpg",
          },
          {
            id: "legacy-feed-video",
            media_type: "VIDEO",
            permalink: "https://www.instagram.com/p/legacy-feed-video/",
            thumbnail_url: "https://example.com/legacy-feed-video.jpg",
          },
          {
            id: "legacy-reel",
            media_type: "VIDEO",
            permalink: "https://www.instagram.com/reel/legacy-reel/",
            thumbnail_url: "https://example.com/legacy-reel.jpg",
          },
          {
            id: "reel",
            media_type: "VIDEO",
            media_product_type: "REELS",
            thumbnail_url: "https://example.com/reel.jpg",
          },
        ],
      },
    });

    const posts = await fetchAllFeedPosts();

    expect(posts.map((post) => post.id)).toEqual([
      "carousel",
      "image",
      "feed-video",
      "legacy-image",
      "legacy-feed-video",
    ]);
    expect(posts.map((post) => [post.id, post.mediaType, post.mediaProductType])).toEqual([
      ["carousel", "CAROUSEL_ALBUM", "FEED"],
      ["image", "IMAGE", "FEED"],
      ["feed-video", "VIDEO", "FEED"],
      ["legacy-image", "IMAGE", null],
      ["legacy-feed-video", "VIDEO", null],
    ]);
  });
});

describe("uncached media discovery", () => {
  it("reads additional pages until it reaches media older than the setup", async () => {
    get
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: "reel-1",
              media_type: "VIDEO",
              media_product_type: "REELS",
              caption: "Comment REEL",
              timestamp: "2026-08-27T17:30:00+0000",
            },
          ],
          paging: { next: "next-page", cursors: { after: "cursor-1" } },
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: "feed-1",
              media_type: "CAROUSEL_ALBUM",
              media_product_type: "FEED",
              caption: "Comment FEED",
              timestamp: "2026-08-20T17:30:00+0000",
            },
            {
              id: "old-1",
              media_type: "IMAGE",
              media_product_type: "FEED",
              timestamp: "2026-08-15T17:30:00+0000",
            },
          ],
          paging: { next: "unused", cursors: { after: "cursor-2" } },
        },
      });

    const media = await fetchMediaPublishedSince(new Date("2026-08-16T18:00:00.000Z"));

    expect(media.map((item) => [item.id, item.kind])).toEqual([
      ["reel-1", "reel"],
      ["feed-1", "carousel"],
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[1]?.params.after).toBe("cursor-1");
  });

  it("stops on the current page once an older post is observed", async () => {
    get.mockResolvedValue({
      data: {
        data: [
          { id: "new", timestamp: "2026-08-27T17:30:00+0000" },
          { id: "old", timestamp: "2026-08-15T17:30:00+0000" },
        ],
        paging: { next: "should-not-fetch", cursors: { after: "cursor" } },
      },
    });

    expect(
      (await fetchMediaPublishedSince(new Date("2026-08-16T18:00:00.000Z"))).map((m) => m.id),
    ).toEqual(["new"]);
    expect(get).toHaveBeenCalledOnce();
  });

  it("fetches one specific media object for the webhook fast path", async () => {
    get.mockResolvedValue({
      data: {
        id: "media-1",
        media_type: "VIDEO",
        media_product_type: "REELS",
        caption: "Comment HIGHCHAIR",
        permalink: "https://www.instagram.com/reel/example/",
        timestamp: "2026-08-27T17:30:00+0000",
      },
    });

    const media = await fetchMediaById("media-1");

    expect(media).toMatchObject({ id: "media-1", kind: "reel", caption: "Comment HIGHCHAIR" });
    expect(get).toHaveBeenCalledWith(
      "/media-1",
      expect.objectContaining({ params: { fields: expect.stringContaining("caption") } }),
    );
  });
});
