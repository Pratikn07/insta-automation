import { describe, expect, it, vi } from "vitest";
import { replyToComment } from "./replyToComment.js";
import { graph } from "./graphClient.js";

vi.mock("./graphClient.js", () => ({
  graph: {
    post: vi.fn(),
  },
}));

describe("replyToComment", () => {
  it("returns replyId when Meta Graph API returns an id string", async () => {
    vi.mocked(graph.post).mockResolvedValueOnce({
      data: { id: "reply_comment_123" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as any,
    });

    const result = await replyToComment("comment_123", "I sent your guide 💛");
    expect(result).toEqual({ replyId: "reply_comment_123" });
    expect(graph.post).toHaveBeenCalledWith("/comment_123/replies", {
      message: "I sent your guide 💛",
    });
  });

  it("returns null replyId when Meta Graph API returns 2xx response without an id string", async () => {
    vi.mocked(graph.post).mockResolvedValueOnce({
      data: {},
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as any,
    });

    const result = await replyToComment("comment_123", "I sent your guide 💛");
    expect(result).toEqual({ replyId: null });
  });
});
