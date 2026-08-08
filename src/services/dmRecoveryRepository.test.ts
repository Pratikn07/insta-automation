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
// QA-04: the prospective final authorization now consults historical sends. Defaults
// to null (nobody contacted historically) so existing cases are unaffected.
const candidateFindFirst = vi.fn();
// QA-06: it also reads the canonical intent and any sibling conversation, because the
// denormalised completion stamp is best-effort and cannot be the safety authority. Both
// default to null (nothing else in the journey completed).
const intentFindUnique = vi.fn();
const convoFindFirst = vi.fn();
const logEvent = vi.fn();

const txClient = {
  dmRecoveryReminder: { findMany, findUnique, findFirst, updateMany, update, count },
  dmRecoveryControl: { findUnique: controlFindUnique },
  conversation: { findUnique: convoFindUnique, findFirst: convoFindFirst },
  journeyIntent: { findUnique: intentFindUnique },
  igUser: { findUnique: igUserFindUnique },
  recoveryCandidate: { findFirst: candidateFindFirst },
  $queryRaw: queryRaw,
};

const $transaction = vi.fn(async (fn: Function) => fn(txClient));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { findMany, findUnique, findFirst, updateMany, update, count },
    dmRecoveryControl: { findUnique: controlFindUnique },
    conversation: { findUnique: convoFindUnique, findFirst: convoFindFirst },
    journeyIntent: { findUnique: intentFindUnique },
    igUser: { findUnique: igUserFindUnique },
    recoveryCandidate: { findFirst: candidateFindFirst },
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
  resolveAudienceOrigin,
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
    queryRaw, controlFindUnique, convoFindUnique, igUserFindUnique, candidateFindFirst,
    intentFindUnique, convoFindFirst,
    logEvent, $transaction,
  ]) {
    fn.mockReset();
  }
  $transaction.mockImplementation(async (fn: Function) => fn(txClient));
  queryRaw.mockResolvedValue([]);
  convoFindUnique.mockResolvedValue({
    state: "awaiting_done", completedAt: null,
    igUserId: "ig-1", keywordId: "kw-1", canonicalIntentId: null,
  });
  // Nothing else in this person's journey completed, so each case tests its own rule.
  intentFindUnique.mockResolvedValue(null);
  convoFindFirst.mockResolvedValue(null);
  igUserFindUnique.mockResolvedValue({ username: "emily_r", name: "Emily Robbins" });
  // No historical contact by default, so each case tests the rule it was written for.
  candidateFindFirst.mockResolvedValue(null);
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

  // QA-04. The real cross-system behaviour is proven against Postgres in
  // historicalRecoveryClaimContract; these pin the wiring so a refactor cannot quietly
  // drop the historical read from the policy context.
  it("suppresses when a historical campaign already contacted this person", async () => {
    findUnique.mockResolvedValue(sendingRow());
    // No prospective contact...
    findFirst.mockResolvedValue(null);
    // ...but a historical one, which this path could not see at all before the fix.
    candidateFindFirst.mockResolvedValue({ id: "hist-1" });

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "suppress",
      reason: "person_cooldown",
    });
  });

  it("consults the historical table at all", async () => {
    findUnique.mockResolvedValue(sendingRow());
    findFirst.mockResolvedValue(null);

    await authorizeClaimForSend("rec-1", NOW);

    expect(candidateFindFirst).toHaveBeenCalled();
  });

  it("does not suppress when historical never contacted them", async () => {
    findUnique.mockResolvedValue(sendingRow());
    findFirst.mockResolvedValue(null);
    candidateFindFirst.mockResolvedValue(null);

    const decision = await authorizeClaimForSend("rec-1", NOW);

    expect(decision).not.toEqual({ kind: "suppress", reason: "person_cooldown" });
  });

  // QA-06. The row's own conversation stays open — exactly the state a swallowed
  // suppression failure leaves — while the journey itself is complete. The real-Postgres
  // proof lives in historicalRecoveryClaimContract.test.ts; these pin the two reads so a
  // future refactor cannot quietly drop one and still pass.
  it("suppresses when the canonical intent completed", async () => {
    findUnique.mockResolvedValue(sendingRow());
    convoFindUnique.mockResolvedValue({
      state: "awaiting_done", completedAt: null,
      igUserId: "ig-1", keywordId: "kw-1", canonicalIntentId: "intent-1",
    });
    intentFindUnique.mockResolvedValue({ completedAt: new Date("2026-08-06T09:30:00Z") });

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "suppress",
      reason: "completed",
    });
  });

  // No intent link: pre-Feature-3 journeys have siblings but no intent, so the sibling's
  // own completion has to be enough on its own.
  it("suppresses when a sibling conversation completed", async () => {
    findUnique.mockResolvedValue(sendingRow());
    convoFindFirst.mockResolvedValue({ completedAt: new Date("2026-08-06T09:30:00Z") });

    await expect(authorizeClaimForSend("rec-1", NOW)).resolves.toEqual({
      kind: "suppress",
      reason: "completed",
    });
  });

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
    it("reads the identity and the stored verdict in one query", async () => {
      findUnique.mockResolvedValue(sendingRow());
      igUserFindUnique.mockResolvedValue({ username: "priya_s", name: "Priya Sharma" });

      const decision = await authorizeClaimForSend("rec-1", NOW);

      expect(igUserFindUnique).toHaveBeenCalledWith({
        where: { id: "ig-1" },
        select: {
          username: true,
          name: true,
          inferredOrigin: true,
          originConfidence: true,
          originMethod: true,
        },
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

describe("resolveAudienceOrigin", () => {
  const LLM = "llm_v1";

  it("prefers a stored verdict from the current prompt over the name screen", () => {
    // The name alone yields nothing; the stored verdict is the only signal.
    expect(
      resolveAudienceOrigin({
        username: "handle123",
        name: null,
        inferredOrigin: "south_asian",
        originConfidence: "high",
        originMethod: LLM,
      }),
    ).toEqual({ origin: "south_asian", confidence: "high" });
  });

  // The fallback is the safety property. A null column means "not yet checked",
  // never "not South Asian" — reading it as a verdict would silently open the
  // gate for every user newer than the worker's last pass.
  it("falls back to the name screen when nothing is stored", () => {
    expect(
      resolveAudienceOrigin({
        username: "priya_s",
        name: "Priya Sharma",
        inferredOrigin: null,
        originConfidence: null,
        originMethod: null,
      }),
    ).toEqual({ origin: "south_asian", confidence: "high" });
  });

  it("falls back when the row is missing entirely", () => {
    expect(resolveAudienceOrigin(null)).toEqual({ origin: "unknown", confidence: "low" });
  });

  // The one-time backfill script writes these same columns with method "name".
  // Those values ARE the token screen, so trusting them would just be an
  // indirection — and a future prompt must re-earn trust through the worker.
  it.each([["name"], ["name_bio"], ["llm_v0"], [null]])(
    "ignores a verdict written by method %p",
    (method) => {
      expect(
        resolveAudienceOrigin({
          username: "handle123",
          name: null,
          inferredOrigin: "south_asian",
          originConfidence: "high",
          originMethod: method,
        }),
      ).toEqual({ origin: "unknown", confidence: "low" });
    },
  );

  it("ignores a stored origin outside the known set", () => {
    expect(
      resolveAudienceOrigin({
        username: "handle123",
        name: null,
        inferredOrigin: "martian",
        originConfidence: "high",
        originMethod: LLM,
      }),
    ).toEqual({ origin: "unknown", confidence: "low" });
  });

  // "high" is the value that withholds a public reminder, so a malformed
  // confidence column must never be read as granting it.
  it.each([["HIGH"], ["true"], [null], ["medium"]])(
    "treats a stored confidence %p as low",
    (confidence) => {
      expect(
        resolveAudienceOrigin({
          username: "handle123",
          name: null,
          inferredOrigin: "south_asian",
          originConfidence: confidence,
          originMethod: LLM,
        }),
      ).toEqual({ origin: "south_asian", confidence: "low" });
    },
  );
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
