import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const count = vi.fn();
const queryRaw = vi.fn().mockResolvedValue([]);
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { findMany, findUnique, updateMany, update, count, findFirst },
    dmRecoveryControl: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    $queryRaw: queryRaw,
    $transaction: vi.fn(async (fn: Function) =>
      fn({
        dmRecoveryReminder: { findMany, findUnique, updateMany, update, count, findFirst },
        dmRecoveryControl: { findUnique: vi.fn().mockResolvedValue({ circuitOpen: false }) },
        conversation: { findUnique: vi.fn().mockResolvedValue({ state: "awaiting_done" }) },
        $queryRaw: queryRaw,
      }),
    ),
  },
}));

vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({
  env: {
    LOG_LEVEL: "info",
    DM_RECOVERY_LEASE_MS: 900000,
    DM_RECOVERY_MAX_PER_HOUR: 20,
  },
}));

const {
  listDueRecoveryIds,
  claimRecovery,
  authorizeClaimForSend,
  markRecoverySent,
  markRecoveryRetryable,
  markRecoveryFailed,
  markRecoveryUncertain,
  releaseOrSuppressClaim,
} = await import("./dmRecoveryRepository.js");

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findFirst.mockReset();
  updateMany.mockReset();
  update.mockReset();
  count.mockReset();
  queryRaw.mockReset().mockResolvedValue([]);
  logEvent.mockReset();
});

describe("dmRecoveryRepository", () => {
  describe("listDueRecoveryIds", () => {
    it("returns due waiting recovery IDs ordered by eligibleAt ASC", async () => {
      findMany.mockResolvedValue([{ id: "rec-1" }, { id: "rec-2" }]);

      const now = new Date("2026-08-06T10:00:00Z");
      const ids = await listDueRecoveryIds(now, 5);

      expect(ids).toEqual(["rec-1", "rec-2"]);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          status: "waiting",
          eligibleAt: { lte: now },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        select: { id: true },
        orderBy: [{ eligibleAt: "asc" }, { createdAt: "asc" }],
        take: 5,
      });
    });
  });

  describe("claimRecovery", () => {
    it("claims an eligible treatment record compare-and-set style", async () => {
      const now = new Date("2026-08-06T10:00:00Z");
      const lease = new Date("2026-08-06T10:15:00Z");

      findUnique.mockResolvedValue({
        id: "rec-1",
        igUserId: "ig-1",
        conversationId: "convo-1",
        status: "waiting",
        eligibleAt: new Date("2026-08-06T09:00:00Z"),
        nextAttemptAt: null,
      });
      findMany.mockResolvedValue([]); // no recent sends
      updateMany.mockResolvedValue({ count: 1 });

      const res = await claimRecovery("rec-1", now, lease);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "rec-1",
          status: "waiting",
          eligibleAt: { lte: now },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          status: "sending",
          claimedAt: now,
          claimExpiresAt: lease,
        },
      });
    });

    it("suppresses candidate if user had a sent reminder in past 24h", async () => {
      const now = new Date("2026-08-06T10:00:00Z");
      const lease = new Date("2026-08-06T10:15:00Z");

      findUnique.mockResolvedValue({
        id: "rec-1",
        igUserId: "ig-1",
        conversationId: "convo-1",
        status: "waiting",
        eligibleAt: new Date("2026-08-06T09:00:00Z"),
        nextAttemptAt: null,
      });
      // Person had a recent send
      findFirst.mockResolvedValue({ id: "other-sent-row" });

      const res = await claimRecovery("rec-1", now, lease);

      expect(res).toBeNull();
      expect(update).toHaveBeenCalledWith({
        where: { id: "rec-1" },
        data: {
          status: "suppressed",
          suppressedAt: now,
          suppressionReason: "person_cooldown",
        },
      });
    });
  });

  describe("authorizeClaimForSend", () => {
    it("authorizes a valid sending claim when capacity and circuit check hold", async () => {
      const now = new Date("2026-08-06T10:00:00Z");
      count.mockResolvedValue(0); // hourly count ok
      findUnique.mockResolvedValue({
        id: "rec-1",
        status: "sending",
        claimExpiresAt: new Date("2026-08-06T10:15:00Z"),
        triggerKind: "no_confirmed_read",
        templateVersion: "v1",
        attempts: 0,
        conversationId: "convo-1",
      });

      const decision = await authorizeClaimForSend("rec-1", now);

      expect(decision).toEqual({
        kind: "send_no_confirmed_read_reminder",
      });
    });
  });

  describe("finalizers", () => {
    it("markRecoverySent updates sending row to sent with replyId and sentAt", async () => {
      updateMany.mockResolvedValue({ count: 1 });
      const sentAt = new Date();

      const ok = await markRecoverySent("rec-1", { replyId: "rep-1", sentAt });

      expect(ok).toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "rec-1", status: "sending" },
        data: {
          status: "sent",
          publicReplyId: "rep-1",
          sentAt,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
    });
  });
});
