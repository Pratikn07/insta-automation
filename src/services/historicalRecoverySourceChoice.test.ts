import { describe, expect, it, vi } from "vitest";
import { resolveApprovedHistoricalSource } from "./historicalRecoverySourceChoice.js";

const sources = [
  { position: 0, commentId: "newest" },
  { position: 1, commentId: "older" },
];

describe("resolveApprovedHistoricalSource", () => {
  it.each(["missing", "hidden"] as const)(
    "falls back after a definitive %s result",
    async (firstState) => {
      const read = vi.fn()
        .mockResolvedValueOnce(firstState)
        .mockResolvedValueOnce("visible");

      await expect(resolveApprovedHistoricalSource(sources, read)).resolves.toEqual({
        kind: "selected",
        commentId: "older",
        position: 1,
      });
      expect(read.mock.calls.map(([commentId]) => commentId)).toEqual(["newest", "older"]);
    },
  );

  it.each(["auth", "unknown"] as const)(
    "does not fall back after a non-definitive %s result",
    async (state) => {
      const read = vi.fn().mockResolvedValue(state);

      await expect(resolveApprovedHistoricalSource(sources, read)).resolves.toEqual({
        kind: "blocked",
        reason: state,
      });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it("reports an exhausted approved set without discovering another source", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce("missing")
      .mockResolvedValueOnce("hidden");

    await expect(resolveApprovedHistoricalSource(sources, read)).resolves.toEqual({
      kind: "blocked",
      reason: "source_set_exhausted",
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the approved source set is empty", async () => {
    const read = vi.fn();

    await expect(resolveApprovedHistoricalSource([], read)).resolves.toEqual({
      kind: "blocked",
      reason: "source_set_exhausted",
    });
    expect(read).not.toHaveBeenCalled();
  });
});
