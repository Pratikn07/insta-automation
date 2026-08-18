import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const debug = vi.fn();

vi.mock("./graphClient.js", () => ({ graph: { post } }));
vi.mock("../lib/logger.js", () => ({ logger: { debug } }));

const { sendMedia } = await import("./sendMedia.js");

describe("sendMedia logging privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({ data: { message_id: "mid-media" } });
  });

  it("sends the media URL to Graph but keeps it out of logger arguments", async () => {
    const privateUrl = "https://private.example/PRIVATE-MEDIA-URL-SENTINEL";

    await expect(
      sendMedia({ recipientIgUserId: "ig-user-1", type: "image", url: privateUrl }),
    ).resolves.toEqual({ messageId: "mid-media" });

    expect(JSON.stringify(post.mock.calls)).toContain(privateUrl);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(privateUrl);
    expect(debug).toHaveBeenCalledWith(
      { recipientIgUserId: "ig-user-1", type: "image" },
      "Sent media DM",
    );
  });
});
