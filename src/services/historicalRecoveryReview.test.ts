import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  transaction,
  candidateFindUnique,
  candidateUpdateMany,
  eventLogCreate,
} = vi.hoisted(() => ({
  transaction: vi.fn(),
  candidateFindUnique: vi.fn(),
  candidateUpdateMany: vi.fn(),
  eventLogCreate: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: { $transaction: transaction },
}));

const { markHistoricalCandidateReviewed } = await import("./historicalRecoveryReview.js");

const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const tx = {
  recoveryCandidate: {
    findUnique: candidateFindUnique,
    updateMany: candidateUpdateMany,
  },
  eventLog: { create: eventLogCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
  candidateFindUnique.mockResolvedValue({ outcome: "send_uncertain", reviewedAt: null });
  candidateUpdateMany.mockResolvedValue({ count: 1 });
  eventLogCreate.mockResolvedValue({ id: "event-1" });
});

describe("markHistoricalCandidateReviewed", () => {
  it("writes the acknowledgement and audit event in one transaction", async () => {
    await expect(markHistoricalCandidateReviewed({ candidateId: CANDIDATE_ID, actor: "owner@example.com" }))
      .resolves.toEqual({ kind: "reviewed" });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(candidateUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CANDIDATE_ID,
        outcome: { in: ["send_failed", "send_uncertain"] },
        reviewedAt: null,
      },
      data: { reviewedAt: expect.any(Date) },
    });
    expect(eventLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "historical_recovery_reviewed",
        payload: expect.objectContaining({ candidateId: CANDIDATE_ID, actor: "owner@example.com" }),
      }),
    });
    expect(candidateUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      eventLogCreate.mock.invocationCallOrder[0],
    );
  });

  it("rejects and rolls the acknowledgement back when the transactional audit write fails", async () => {
    let reviewedAt: Date | null = null;
    candidateFindUnique.mockImplementation(async () => ({ outcome: "send_failed", reviewedAt }));
    candidateUpdateMany.mockImplementation(async () => {
      reviewedAt = new Date("2026-08-12T12:00:00.000Z");
      return { count: 1 };
    });
    eventLogCreate.mockRejectedValueOnce(new Error("event log unavailable"));
    transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => {
      const before = reviewedAt;
      try {
        return await work(tx);
      } catch (error) {
        reviewedAt = before;
        throw error;
      }
    });

    await expect(markHistoricalCandidateReviewed({ candidateId: CANDIDATE_ID, actor: "owner@example.com" }))
      .rejects.toThrow("event log unavailable");
    expect(reviewedAt).toBeNull();
  });

  it("treats a concurrent review winner as idempotent after its conditional write loses", async () => {
    candidateFindUnique
      .mockResolvedValueOnce({ outcome: "send_failed", reviewedAt: null })
      .mockResolvedValueOnce({ outcome: "send_failed", reviewedAt: new Date("2026-08-12T12:00:00.000Z") });
    candidateUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(markHistoricalCandidateReviewed({ candidateId: CANDIDATE_ID, actor: "owner@example.com" }))
      .resolves.toEqual({ kind: "already_reviewed" });
    expect(eventLogCreate).not.toHaveBeenCalled();
  });
});
