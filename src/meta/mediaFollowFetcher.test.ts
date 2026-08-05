import { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";

vi.mock("./insightsGraphClient.js", () => ({
  insightsGraph: { get: vi.fn() },
}));

const { insightsGraph } = await import("./insightsGraphClient.js");
const { fetchFeedFollowCount, isGraphAuthenticationError } = await import("./mediaFollowFetcher.js");

function graphError(code: number): AxiosError {
  return new AxiosError(
    "Graph request failed",
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    { status: 400, data: { error: { code } } } as never,
  );
}

describe("fetchFeedFollowCount", () => {
  it("parses the standard lifetime values response", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
      data: { data: [{ name: "follows", values: [{ value: 12 }] }] },
    } as never);

    await expect(fetchFeedFollowCount("post-1")).resolves.toEqual({ status: "ok", follows: 12 });
  });

  it("parses the total_value response and preserves a real zero", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
      data: { data: [{ name: "follows", total_value: { value: 0 } }] },
    } as never);

    await expect(fetchFeedFollowCount("post-2")).resolves.toEqual({ status: "ok", follows: 0 });
  });

  it("returns unavailable rather than zero when Meta omits the metric value", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
      data: { data: [{ name: "follows", values: [] }] },
    } as never);

    await expect(fetchFeedFollowCount("post-3")).resolves.toEqual({
      status: "unavailable",
      follows: null,
    });
  });

  it("rejects a negative counter as unavailable", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
      data: { data: [{ name: "follows", values: [{ value: -1 }] }] },
    } as never);

    await expect(fetchFeedFollowCount("post-4")).resolves.toEqual({
      status: "unavailable",
      follows: null,
    });
  });

  it("propagates Graph failures so the collector can classify them", async () => {
    const error = graphError(100);
    vi.mocked(insightsGraph.get).mockRejectedValueOnce(error);

    await expect(fetchFeedFollowCount("post-5")).rejects.toBe(error);
  });

  it("recognizes Meta account authentication errors", () => {
    expect(isGraphAuthenticationError(graphError(190))).toBe(true);
    expect(isGraphAuthenticationError(graphError(102))).toBe(true);
    expect(isGraphAuthenticationError(graphError(100))).toBe(false);
    expect(isGraphAuthenticationError(new Error("network down"))).toBe(false);
  });
});
