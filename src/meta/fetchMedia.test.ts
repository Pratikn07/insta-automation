import { describe, expect, it, vi } from "vitest";

vi.mock("./insightsGraphClient.js", () => ({
  insightsGraph: { get: vi.fn() },
}));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "account-1" } }));
vi.mock("../lib/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const { insightsGraph } = await import("./insightsGraphClient.js");
const { fetchAllFeedPosts } = await import("./fetchMedia.js");

describe("fetchAllFeedPosts", () => {
  it("returns carousel, image, feed-video and legacy feed media while excluding Reels", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
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
    } as never);

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
