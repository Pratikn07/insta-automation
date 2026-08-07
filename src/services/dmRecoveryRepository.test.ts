import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const count = vi.fn();
const queryRaw = vi.fn();
const controlFindUnique = vi.fn();
const convoFindUnique = vi.fn();
const igUserFindUnique = vi.fn();
const logEvent = vi.fn();

const txClient = {
  dmRecoveryReminder: { findMany, findUnique, findFirst, updateMany, update, count },
  dmRecoveryControl: { findUnique: controlFindUnique },
  conversation: { findUnique: convoFindUnique },
  igUser: { findUnique: igUserFindUnique },
  $queryRaw: queryRaw,
};

const $transaction = vi.fn(async (fn: Function) => fn(txClient));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { findMany, findUnique, findFirst, updateMany, update, count },
    dmRecoveryControl: { findUnique: controlFindUnique },
    conversation: { findUnique: convoFindUnique },
    igUser: { findUnique: igUserFindUnique },
    $queryRaw: queryRaw,
    $transaction,
  },
}));

vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({
  env: { DM_RECOVERY_LEASE_MS: 900_000, DM_RECOVERY_HOURLY_CAP: 30, DM_RECOVERY_WESTERN_ONLY: false },
}));

const {
  listDueRecoveryIds,
  claimRecovery,
  authorizeClaimForSend,
  markRecoverySent,
  releaseOrSuppressClaim,
} = await import("./dmRecoveryRepository.js");

const NOW = new Date("2026-08-06T10:00:00Z");
const LEASE = new Date("2026-08-06T10:15:00Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    igUserId: "ig-1",
    conversationId: "convo-1",
    commentId: "comment-1",
    status: "waiting",
    cohort: "treatment",
    triggerKind: "no_confirmed_read",
    instagramGateMessageId: "mid-1",
    eligibleAt: new Date("2026-08-06T09:00:00Z"),
    createdAt: new Date("2026-08-05T23:00:00Z"),
    nextAttemptAt: null,
    acceptedAt: new Date("2026-08-05T23:00:00Z"),
    attempts: 0,
    claimExpiresAt: LEASE,
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    cancelledAt: null,
    publicReplyText: "copy",
    ...overrides,
  };
}

/** findFirst serves two different lookups; route by the shape of the where. */
function routeFindFirst(opts: { cooldown?: unknown; newer?: unknown } = {}) {
  findFirst.mockImplementation(async (args: any) =>
    args?.where?.status === "waiting" ? (opts.newer ?? null) : (opts.cooldown ?? null),
  );
}

beforeEach(() => {
  for (const fn of [
    findMany, findUnique, findFirst, updateMany, update, count,
    queryRaw, controlFindUnique, convoFindUnique, igUserFindUnique, logEvent, $transaction,
  ]) {
    fn.mockReset();
  }
  $transaction.mockImplementation(async (fn: Function) => fn(txClient));
  queryRaw.mockResolvedValue([]);
  convoFindUnique.mockResolvedValue({ state: "awaiting_done", completedAt: null });
  igUserFindUnique.mockResolvedValue({ username: "emily_r", name: "Emily Robbins" });
  controlFindUnique.mockResolvedValue({ circuitOpen: false });
  count.mockResolvedValue(0);
  updateMany.mockResolvedValue({ count: 1 });
  routeFindFirst();
});

describe("listDueRecoveryIds", () => {
  // Fetches above the batch size: front-of-queue rows are frequently suppressed
  // during the claim, and without headroom they consume the batch and delay
  // people who could actually be sent.
  it("selects only due waiting rows, oldest first, with headroom above the batch", async () => {
    findMany.mockResolvedValue([{ id: "rec-1" }]);
    await expect(listDueRecoveryIds(NOW, 5)).resolves.toEqual(["rec-1"]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "waiting",
        eligibleAt: { lte: NOW },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }],
      },
      select: { id: true },
      orderBy: [{ eligibleAt: "asc" }, { createdAt: "asc" }],
      take: 15,
    });
  });

  it("treats a reminder exactly one cooldown old as eligible again", async () => {
    findUnique.mockResolvedValue(candidate());
    await claimRecovery("rec-1", NOW, LEASE);

    const cooldownCall = findFirst.mock.calls.find(
      ([args]) => args?.where?.status !== "waiting",
    );
    const [sentClause] = cooldownCall![0].where.OR;
    expect(sentClause.sentAt).toHaveProperty("gt");
    expect(sentClause.sentAt).not.toHaveProperty("gte");
  });
});

describe("claimRecovery", () => {
  it("claims an eligible treatment row compare-and-set style", async () => {
    findUnique.mockResolvedValue(candidate());

    await claimRecovery("rec-1", NOW, LEASE);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "rec-1",
        status: "waiting",
        eligibleAt: { lte: NOW },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }],
      },
      data: { status: "sending", claimedAt: NOW, claimExpiresAt: LEASE },
    });
  });

  it("returns null when another worker won the compare-and-set", async () => {
    findUnique.mockResolvedValue(candidate());
    updateMany.mockResolvedValue({ count: 0 });

    await expect(claimRecovery("rec-1", NOW, LEASE)).resolves.toBeNull();
  });

  // The claim must run the approved policy rather than a hand-rolled subset,
  // otherwise the audited precedence in dmRecoveryPolicy is not what executes.
  it.each([
    ["read receipt", { seenAt: NOW }, "seen"],
    ["engagement", { engagedAt: NOW, firstEngagementKind: "reaction" }, "reaction"],
    ["owner cancellation", { cancelledAt: NOW }, "owner_cancelled"],
    ["no gate message id", { instagramGateMessageId: null }, "tracking_unavailable"],
  ])("suppresses a candidate with %s instead of claiming", async (_l, extra, reason) => {
    findUnique.mockResolvedValue(candidate(extra));

    await expect(claimRecovery("rec-1", NOW, LEASE)).resolves.toBeNull();

    expect(update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: expect.objectContaining({ status: "suppressed", suppressionReason: reason }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("suppresses when the conversation already completed", async () => {
    findUnique.mockResolvedValue(candidate());
    convoFindUnique.mockResolvedValue({ state: "completed", completedAt: NOW });

    await expect(claimRecovery("rec-1", NOW, LEASE)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: expect.objectContaining({ suppressionReason: "completed" }),
    });
  });

  it("suppresses when the person already had a reminder inside the cooldown", async () => {
    findUnique.mockResolvedValue(candidate());
    routeFindFirst({ cooldown: { id: "other" } });

    await expect(claimRecovery("rec-1", NOW, LEASE)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: expect.objectContaining({ suppressionReason: "person_cooldown" }),
    });
  });

  // "The most recently eligible record wins" — without this the OLDEST wins,
  // because listDueRecoveryIds orders eligibleAt ascending for fairness.
  it("suppresses a candidate superseded by a newer eligible one for the same person", async () => {
    findUnique.mockResolvedValue(candidate());
    routeFindFirst({ newer: { id: "rec-2" } });

    await expect(claimRecovery("rec-1", NOW, LEASE)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: expect.objectContaining({ suppressionReason: "newer_candidate" }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("serialises decisions for one person with a row lock", async () => {
    findUnique.mockResolvedValue(candidate());
    await claimRecovery("rec-1", NOW, LEASE);
    expect(queryRaw).toHaveBeenCalled();
  });
});

describe("authorizeClaimForSend", () => {
  function sendingRow(overrides: Record<string, unknown> = {}) {
    return candidate({ status: "sending", ...overrides });
  }

  it("authorises a healthy claim and reserves the attempt", async () => {
    findUnique.mockResolvedValue(sendingRow());

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "send_no_confirmed_read_reminder",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: { lastAttemptAt: NOW, attempts: 1 },
    });
  });

  // Circuit state and hourly capacity are process-wide, so the singleton must
  // be locked or two workers can both read spare capacity and both send.
  it("locks the control row before reading circuit state or capacity", async () => {
    findUnique.mockResolvedValue(sendingRow());

    await authorizeClaimForSend("rec-1", NOW);

    const locked = queryRaw.mock.calls.some(([strings]) =>
      String(Array.isArray(strings) ? strings.join("?") : strings)
        .toUpperCase()
        .includes("FOR UPDATE"),
    );
    expect(locked).toBe(true);
  });

  it.each([
    ["an open circuit", () => controlFindUnique.mockResolvedValue({ circuitOpen: true }), "circuit_open"],
    ["a full hourly cap", () => count.mockResolvedValue(30), "hourly_cap"],
  ])("pauses for %s without suppressing the person", async (_l, arrange, reason) => {
    findUnique.mockResolvedValue(sendingRow());
    arrange();

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "pause",
      reason,
    });
  });

  it("releases a claim whose lease already expired", async () => {
    findUnique.mockResolvedValue(
      sendingRow({ claimExpiresAt: new Date("2026-08-06T09:00:00Z") }),
    );

    const decision = await authorizeClaimForSend("rec-1", NOW);
    expect(decision.kind).toBe("release");
  });

  // Evidence, cooldown and supersession can all land during the lease window.
  it.each([
    ["read evidence", () => findUnique.mockResolvedValue(sendingRow({ seenAt: NOW })), "seen"],
    [
      "a reaction that landed during the lease",
      () =>
        findUnique.mockResolvedValue(
          sendingRow({ engagedAt: NOW, firstEngagementKind: "reaction" }),
        ),
      "reaction",
    ],
    [
      "a postback that landed during the lease",
      () =>
        findUnique.mockResolvedValue(
          sendingRow({ engagedAt: NOW, firstEngagementKind: "postback" }),
        ),
      "postback",
    ],
    [
      "a completed conversation",
      () => {
        findUnique.mockResolvedValue(sendingRow());
        convoFindUnique.mockResolvedValue({ state: "completed", completedAt: NOW });
      },
      "completed",
    ],
    [
      "a reminder inside the person cooldown",
      () => {
        findUnique.mockResolvedValue(sendingRow());
        routeFindFirst({ cooldown: { id: "other" } });
      },
      "person_cooldown",
    ],
    [
      "a newer eligible candidate",
      () => {
        findUnique.mockResolvedValue(sendingRow());
        routeFindFirst({ newer: { id: "rec-2" } });
      },
      "newer_candidate",
    ],
  ])("suppresses before sending for %s", async (_l, arrange, reason) => {
    arrange();

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "suppress",
      reason,
    });
  });

  // The gate is a policy decision, but the ORIGIN behind it is resolved here.
  // These prove the wiring, which the pure policy tests cannot see.
  describe("out-of-market audience", () => {
    it("classifies the person from their current name, not a stored column", async () => {
      findUnique.mockResolvedValue(sendingRow());
      igUserFindUnique.mockResolvedValue({ username: "priya_s", name: "Priya Sharma" });

      const decision = await authorizeClaimForSend("rec-1", NOW);

      // ig_users.inferred_origin is written only by the one-time backfill, so a
      // read of that column would return null for anyone newer than the last
      // run and silently disable the gate for exactly those people.
      expect(igUserFindUnique).toHaveBeenCalledWith({
        where: { id: "ig-1" },
        select: { username: true, name: true },
      });
      // The flag is off in the env mock, so the send still goes through — this
      // asserts the lookup, not the suppression.
      expect(decision).toEqual({ kind: "send_no_confirmed_read_reminder" });
    });

    it("does not blow up when the person was never resolved", async () => {
      findUnique.mockResolvedValue(sendingRow());
      igUserFindUnique.mockResolvedValue(null);

      await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
        kind: "send_no_confirmed_read_reminder",
      });
    });
  });
});

describe("finalizers", () => {
  it("markRecoverySent records a confirmed reply", async () => {
    const sentAt = new Date();
    await expect(markRecoverySent("rec-1", { replyId: "rep-1", sentAt })).resolves.toBe(true);
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

  // Without an id from Meta the send is unconfirmed; recording it as `sent`
  // would both claim delivery we cannot prove and start the person's cooldown.
  it.each([["an empty id", ""], ["whitespace", "   "]])(
    "markRecoverySent refuses %s",
    async (_l, replyId) => {
      await expect(
        markRecoverySent("rec-1", { replyId, sentAt: new Date() }),
      ).resolves.toBe(false);
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  // Every non-send outcome must move the row out of `sending`. A row left
  // claimed is reconciled to send_uncertain when its lease expires, which sends
  // a healthy hold to manual review for no reason.
  it.each([
    ["pause", { kind: "pause", reason: "circuit_open" }, "waiting"],
    ["release", { kind: "release", reason: "stale_claim" }, "waiting"],
    ["wait", { kind: "wait" }, "waiting"],
    ["holdout", { kind: "holdout" }, "control"],
    ["suppress", { kind: "suppress", reason: "seen" }, "suppressed"],
  ])("releaseOrSuppressClaim moves a %s decision out of sending", async (_l, decision, status) => {
    await expect(releaseOrSuppressClaim("rec-1", decision as never, NOW)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "rec-1", status: "sending" },
      data: expect.objectContaining({ status, claimedAt: null, claimExpiresAt: null }),
    });
  });
});
