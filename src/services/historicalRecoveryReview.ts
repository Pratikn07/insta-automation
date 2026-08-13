import { prisma } from "../lib/prisma.js";

export const HISTORICAL_REVIEWABLE_OUTCOMES = ["send_failed", "send_uncertain"] as const;

export type HistoricalCandidateReviewResult =
  | { kind: "reviewed" }
  | { kind: "already_reviewed" }
  | { kind: "not_found" }
  | { kind: "conflict"; outcome: string };

/** Acknowledge an ambiguous send and persist its audit evidence atomically. */
export async function markHistoricalCandidateReviewed(input: {
  candidateId: string;
  actor: string | null;
  now?: Date;
}): Promise<HistoricalCandidateReviewResult> {
  const reviewedAt = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const before = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      select: { outcome: true, reviewedAt: true },
    });
    if (!before) return { kind: "not_found" };
    if (before.reviewedAt !== null) return { kind: "already_reviewed" };

    const updated = await tx.recoveryCandidate.updateMany({
      where: {
        id: input.candidateId,
        outcome: { in: [...HISTORICAL_REVIEWABLE_OUTCOMES] },
        reviewedAt: null,
      },
      data: { reviewedAt },
    });
    if (updated.count === 0) {
      const current = await tx.recoveryCandidate.findUnique({
        where: { id: input.candidateId },
        select: { outcome: true, reviewedAt: true },
      });
      if (!current) return { kind: "not_found" };
      if (current.reviewedAt !== null) return { kind: "already_reviewed" };
      return { kind: "conflict", outcome: current.outcome };
    }

    await tx.eventLog.create({
      data: {
        kind: "historical_recovery_reviewed",
        payload: {
          candidateId: input.candidateId,
          actor: input.actor,
          action: "mark_reviewed",
          previousOutcome: before.outcome,
          newOutcome: before.outcome,
        },
      },
    });
    return { kind: "reviewed" };
  });
}
