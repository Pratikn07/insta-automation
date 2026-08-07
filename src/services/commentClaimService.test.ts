import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const loggerError = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { processedComment: { create } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError },
}));

const { claimComment } = await import("./commentClaimService.js");

beforeEach(() => {
  create.mockReset();
  loggerError.mockReset();
});

describe("claimComment", () => {
  it("claims a comment the first time it is seen", async () => {
    create.mockResolvedValue({});
    await expect(claimComment("comment-1", "ig-1")).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({ data: { commentId: "comment-1", igUserId: "ig-1" } });
  });

  // An insert, not a read then a write: the primary key picks the winner, so
  // two deliveries arriving together cannot both proceed.
  it("declines a comment already claimed", async () => {
    create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(claimComment("comment-1", "ig-1")).resolves.toBe(false);
    expect(loggerError).not.toHaveBeenCalled();
  });

  // A dropped comment is recoverable — keywordBackfillService reconstructs
  // pending gates from comment_received events for users with no conversation.
  // A duplicate DM is not recoverable, so an unprovable claim declines.
  it("declines when the claim itself fails, rather than risking a duplicate", async () => {
    create.mockRejectedValue(new Error("database unavailable"));

    await expect(claimComment("comment-1", "ig-1")).resolves.toBe(false);

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "comment_claim_failed" }),
      expect.any(String),
    );
  });

  it("never logs the raw error", async () => {
    create.mockRejectedValue(new Error("PROVIDER-SENTINEL"));
    await claimComment("comment-1", "ig-1");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PROVIDER-SENTINEL");
  });
});
