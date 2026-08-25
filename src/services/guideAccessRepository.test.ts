import type {
  GuideAccessAttempt,
  GuideActionToken,
  GuideAccessAttemptState,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  createGuideAccessRepository,
  type GuideAccessDatabase,
} from "./guideAccessRepository.js";
import {
  GUIDE_ACCESS_MAX_FOLLOW_CHECKS,
  GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
} from "./guideAccessPolicy.js";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000002";
const RESOURCE_ID = "30000000-0000-4000-8000-000000000003";
const COVER_ID = "40000000-0000-4000-8000-000000000004";
const TOKEN_ID = "50000000-0000-4000-8000-000000000005";
const SENDER_ID = "instagram-sender-1";
const NOW = new Date("2026-08-23T12:00:00.000Z");
const WINDOW_EXPIRES_AT = new Date("2026-08-24T12:00:00.000Z");
const TOKEN_EXPIRES_AT = new Date("2026-08-23T12:10:00.000Z");

function attempt(
  overrides: Partial<GuideAccessAttempt> = {},
): GuideAccessAttempt & { senderId: string } {
  return {
    id: ATTEMPT_ID,
    conversationId: CONVERSATION_ID,
    resourceId: RESOURCE_ID,
    coverVersionId: COVER_ID,
    state: "awaiting_request",
    lastFollowResult: "unknown",
    lastFollowCheckedAt: null,
    followCheckCount: 0,
    followResponseCount: 0,
    coverExposure: "not_shown",
    coverProviderMessageId: null,
    messagingWindowExpiresAt: WINDOW_EXPIRES_AT,
    createdAt: NOW,
    updatedAt: NOW,
    senderId: SENDER_ID,
    ...overrides,
  };
}

function token(overrides: Partial<GuideActionToken> = {}): GuideActionToken {
  return {
    id: TOKEN_ID,
    attemptId: ATTEMPT_ID,
    action: "request_guide",
    status: "active",
    expiresAt: TOKEN_EXPIRES_AT,
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

type QueryResult = unknown[];

function queryName(strings: TemplateStringsArray): string {
  const sql = strings.join("?").replace(/\s+/g, " ").trim();
  if (sql.includes('FROM "conversations"') && sql.includes("FOR UPDATE")) return "conversation";
  if (sql.includes('FROM "guide_access_attempt"') && sql.includes("FOR UPDATE")) return "attempt";
  if (sql.includes('FROM "guide_action_token"') && sql.includes("FOR UPDATE")) return "token";
  throw new Error(`unexpected query: ${sql}`);
}

function harness(input: {
  activeAttempt?: GuideAccessAttempt | null;
  lockedAttempt?: ReturnType<typeof attempt> | null;
  lockedToken?: GuideActionToken | null;
  tokenIdentity?: { attemptId: string } | null;
  activeToken?: GuideActionToken | null;
  attemptUpdateCount?: number;
  tokenUpdateCount?: number;
  publishedCover?: { id: string; resourceId: string; dmStoragePath: string | null } | null;
  coverById?: { id: string; resourceId: string; dmStoragePath: string | null } | null;
} = {}) {
  const locks: string[] = [];
  const createdAttempt = attempt();
  const createdToken = token();
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray): Promise<QueryResult> => {
      const name = queryName(strings);
      locks.push(name);
      if (name === "conversation") return [{ id: CONVERSATION_ID }];
      if (name === "attempt") return input.lockedAttempt === null ? [] : [input.lockedAttempt ?? attempt()];
      return input.lockedToken === null
        ? []
        : [input.lockedToken ?? input.activeToken ?? token()];
    }),
    guideAccessAttempt: {
      findFirst: vi.fn(async () => input.activeAttempt ?? null),
      create: vi.fn(async () => createdAttempt),
      updateMany: vi.fn(async () => ({ count: input.attemptUpdateCount ?? 1 })),
    },
    resourceCoverVersion: {
      // The two reads are now distinguished by METHOD, not by inspecting the where
      // clause: `findFirst` is the published lookup on create, `findUnique` is the
      // by-id resolve on replay. No heuristic to get wrong.
      findFirst: vi.fn(async () => input.publishedCover ?? null),
      findUnique: vi.fn(async () => input.coverById ?? null),
    },
    eventLog: { create: vi.fn(async () => ({ id: "event-1" })) },
    guideActionToken: {
      findUnique: vi.fn(async () => input.tokenIdentity ?? { attemptId: ATTEMPT_ID }),
      findFirst: vi.fn(async () => input.activeToken ?? null),
      create: vi.fn(async (request?: { data?: Partial<GuideActionToken> }) => ({
        ...createdToken,
        ...request?.data,
      })),
      updateMany: vi.fn(async () => ({ count: input.tokenUpdateCount ?? 1 })),
    },
  };
  const database = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
  } as never as GuideAccessDatabase;

  return {
    repository: createGuideAccessRepository({ database, idFactory: () => ATTEMPT_ID }),
    tx,
    locks,
  };
}

describe("guide access repository", () => {
  it("returns the original active attempt snapshot on create replay", async () => {
    const original = attempt({
      resourceId: RESOURCE_ID,
      coverVersionId: COVER_ID,
      messagingWindowExpiresAt: WINDOW_EXPIRES_AT,
    });
    const { senderId: _, ...originalRecord } = original;
    const test = harness({
      activeAttempt: original,
      coverById: {
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        dmStoragePath: "guide-covers/original/dm.png",
      },
    });

    await expect(
      test.repository.createOrLoadAttempt({
        conversationId: CONVERSATION_ID,
        resourceId: "60000000-0000-4000-8000-000000000006",
        messagingWindowExpiresAt: new Date("2026-08-25T12:00:00.000Z"),
        now: NOW,
      }),
    ).resolves.toEqual({
      kind: "loaded",
      attempt: originalRecord,
      // Resolved from the loaded attempt's own snapshot id, not from the `resourceId`
      // passed in above — which is a DIFFERENT guide here. That divergence is a hazard,
      // not a feature: a consumer that took the guide from the argument and the cover
      // from here would pair one guide's cover with another's messages. The snapshot
      // therefore carries its own `resourceId` so the mismatch is visible.
      cover: {
        versionId: COVER_ID,
        resourceId: RESOURCE_ID,
        dmStoragePath: "guide-covers/original/dm.png",
      },
    });
    expect(test.tx.guideAccessAttempt.create).not.toHaveBeenCalled();
  });

  it("expires a time-closed attempt before creating a new active attempt", async () => {
    const closed = attempt({ messagingWindowExpiresAt: NOW });
    const test = harness({ activeAttempt: closed, lockedAttempt: closed });

    await expect(
      test.repository.createOrLoadAttempt({
        conversationId: CONVERSATION_ID,
        resourceId: RESOURCE_ID,
        messagingWindowExpiresAt: WINDOW_EXPIRES_AT,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "created" });
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "awaiting_request",
        messagingWindowExpiresAt: { lte: NOW },
      },
      data: { state: "expired" },
    });
    expect(test.tx.guideAccessAttempt.create).toHaveBeenCalledOnce();
  });

  it("returns the same active token on issue replay", async () => {
    const existing = token();
    const test = harness({ activeToken: existing });

    await expect(
      test.repository.issueToken({
        attemptId: ATTEMPT_ID,
        action: "request_guide",
        now: NOW,
        expiresAt: TOKEN_EXPIRES_AT,
      }),
    ).resolves.toEqual({ kind: "replayed", token: existing });
    expect(test.tx.guideActionToken.create).not.toHaveBeenCalled();
  });

  it("replaces every prior active follow token while the attempt is checking", async () => {
    const checking = attempt({ state: "checking_follow", followCheckCount: 1 });
    const oldToken = token({ action: "check_follow" });
    const test = harness({ lockedAttempt: checking, activeToken: oldToken });

    await expect(
      test.repository.replaceToken({
        attemptId: ATTEMPT_ID,
        action: "check_follow",
        expectedState: "checking_follow",
        now: NOW,
        expiresAt: TOKEN_EXPIRES_AT,
      }),
    ).resolves.toMatchObject({ kind: "issued" });

    expect(test.locks[0]).toBe("attempt");
    expect(test.tx.guideActionToken.updateMany).toHaveBeenCalledWith({
      where: { attemptId: ATTEMPT_ID, action: "check_follow", status: "active" },
      data: { status: "cancelled" },
    });
    expect(test.tx.guideActionToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attemptId: ATTEMPT_ID,
        action: "check_follow",
        expiresAt: TOKEN_EXPIRES_AT,
      }),
    });
  });

  it("claims a direct inbound UUID atomically with the checking transition", async () => {
    const test = harness({ lockedToken: null });

    await expect(
      test.repository.claimDirectInbound({
        attemptId: ATTEMPT_ID,
        inboundMessageId: TOKEN_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      kind: "consumed",
      attempt: { state: "checking_follow", followCheckCount: 1 },
    });

    expect(test.locks).toEqual(["attempt", "token"]);
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "awaiting_request",
        followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
        messagingWindowExpiresAt: { gt: NOW },
      },
      data: {
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: { increment: 1 },
      },
    });
    expect(test.tx.guideActionToken.create).toHaveBeenCalledWith({
      data: {
        id: TOKEN_ID,
        attemptId: ATTEMPT_ID,
        action: "request_guide",
        status: "consumed",
        expiresAt: WINDOW_EXPIRES_AT,
        consumedAt: NOW,
      },
    });
  });

  it("returns replay for an already-claimed direct inbound before inspecting attempt state", async () => {
    const test = harness({
      lockedAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      lockedToken: token({ status: "consumed", consumedAt: NOW }),
    });

    await expect(
      test.repository.claimDirectInbound({
        attemptId: ATTEMPT_ID,
        inboundMessageId: TOKEN_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "already_consumed" });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("rejects token consumption by a sender other than the conversation sender", async () => {
    const test = harness();

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: "different-sender",
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "wrong_sender" });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
    expect(test.tx.guideActionToken.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a token action that does not match the requested action", async () => {
    const test = harness();

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "check_follow",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "wrong_action" });
  });

  it("rejects a token whose action is incompatible with the attempt state", async () => {
    const test = harness({ lockedAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }) });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "state_conflict", actualState: "awaiting_follow" });
  });

  it("expires rather than consumes a token at its exact expiry boundary", async () => {
    const test = harness({ lockedToken: token({ expiresAt: NOW }) });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(test.tx.guideActionToken.updateMany).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, status: "active" },
      data: { status: "expired" },
    });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("accepts an in-window provider action when webhook processing is delayed", async () => {
    const eventAt = new Date(WINDOW_EXPIRES_AT.getTime() - 1);
    const processingAt = new Date(WINDOW_EXPIRES_AT.getTime() + 60_000);
    const test = harness({
      lockedAttempt: attempt({ messagingWindowExpiresAt: WINDOW_EXPIRES_AT }),
      lockedToken: token({ expiresAt: WINDOW_EXPIRES_AT }),
    });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt,
        now: processingAt,
      }),
    ).resolves.toMatchObject({ kind: "consumed" });
    expect(test.tx.guideActionToken.updateMany).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, status: "active" },
      data: { status: "consumed", consumedAt: processingAt },
    });
  });

  it("expires the attempt and token together when the messaging window closes", async () => {
    const test = harness({
      lockedAttempt: attempt({ messagingWindowExpiresAt: NOW }),
    });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "awaiting_request",
        messagingWindowExpiresAt: { lte: NOW },
      },
      data: { state: "expired" },
    });
    expect(test.tx.guideActionToken.updateMany).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, status: "active" },
      data: { status: "expired" },
    });
  });

  it("includes the open messaging window in the atomic consume transition fence", async () => {
    const test = harness();

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "consumed" });
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "awaiting_request",
        followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
        messagingWindowExpiresAt: { gt: NOW },
      },
      data: {
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: { increment: 1 },
      },
    });
  });

  it("reports an incompatible terminal state before considering window expiry", async () => {
    const test = harness({
      lockedAttempt: attempt({
        state: "delivered",
        lastFollowResult: "follower",
        messagingWindowExpiresAt: NOW,
      }),
    });

    await expect(
      test.repository.issueToken({
        attemptId: ATTEMPT_ID,
        action: "request_guide",
        now: NOW,
        expiresAt: TOKEN_EXPIRES_AT,
      }),
    ).resolves.toEqual({ kind: "state_conflict", actualState: "delivered" });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("locks the attempt before the token when consuming", async () => {
    const test = harness();

    await test.repository.consumeToken({
      tokenId: TOKEN_ID,
      action: "request_guide",
      senderId: SENDER_ID,
      eventAt: NOW,
      now: NOW,
    });

    expect(test.locks).toEqual(["attempt", "token"]);
  });

  it("returns already_consumed on a replay without advancing the attempt again", async () => {
    const test = harness({ lockedToken: token({ status: "consumed", consumedAt: NOW }) });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "already_consumed" });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("returns a typed conflict when the final token fence loses", async () => {
    const test = harness({ tokenUpdateCount: 0 });

    await expect(
      test.repository.consumeToken({
        tokenId: TOKEN_ID,
        action: "request_guide",
        senderId: SENDER_ID,
        eventAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "state_conflict", actualState: "awaiting_request" });
  });

  it("reserves automatic follow responses up to the limit and no further", async () => {
    const first = harness({
      lockedAttempt: attempt({
        state: "awaiting_follow",
        lastFollowResult: "non_follower",
        followResponseCount: 1,
      }),
    });
    const capped = harness({
      lockedAttempt: attempt({
        state: "awaiting_follow",
        lastFollowResult: "non_follower",
        followResponseCount: GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
      }),
    });

    // The response BEFORE the cap must still be reservable. Without this the cap is only
    // pinned from above, and lowering it would go unnoticed — which matters because the
    // last reservable response is the closing message, the one thing that keeps a parent
    // who cannot be seen following from being answered with nothing at all.
    const last = harness({
      lockedAttempt: attempt({
        state: "awaiting_follow",
        lastFollowResult: "non_follower",
        followResponseCount: GUIDE_ACCESS_MAX_FOLLOW_RESPONSES - 1,
      }),
    });

    await expect(
      first.repository.reserveFollowResponse({
        attemptId: ATTEMPT_ID,
        expectedState: "awaiting_follow",
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "reserved", responseNumber: 2 });
    await expect(
      last.repository.reserveFollowResponse({
        attemptId: ATTEMPT_ID,
        expectedState: "awaiting_follow",
        now: NOW,
      }),
    ).resolves.toEqual({
      kind: "reserved",
      responseNumber: GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
    });
    await expect(
      capped.repository.reserveFollowResponse({
        attemptId: ATTEMPT_ID,
        expectedState: "awaiting_follow",
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "limit_reached" });
    expect(capped.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["beginChecking", "awaiting_request", { now: NOW }],
    ["markAwaitingFollow", "checking_follow", { checkedAt: NOW, now: NOW }],
    ["markDelivering", "checking_follow", { checkedAt: NOW, now: NOW }],
    ["reserveFollowResponse", "awaiting_follow", { now: NOW }],
  ] as const)(
    "returns typed expiry when %s reaches the exact messaging-window boundary",
    async (method, state, time) => {
      const lastFollowResult = state === "awaiting_follow" ? "non_follower" : "unknown";
      const test = harness({
        lockedAttempt: attempt({
          state,
          lastFollowResult,
          messagingWindowExpiresAt: NOW,
        }),
      });

      const result = await (
        test.repository[method] as (input: Record<string, unknown>) => Promise<unknown>
      )({ attemptId: ATTEMPT_ID, expectedState: state, ...time });

      expect(result).toMatchObject({ kind: "expired", attempt: { state: "expired" } });
      expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
        where: {
          id: ATTEMPT_ID,
          state,
          messagingWindowExpiresAt: { lte: NOW },
        },
        data: { state: "expired" },
      });
    },
  );

  it("fails closed when a stale expected state loses the state-version fence", async () => {
    const test = harness({
      lockedAttempt: attempt({ state: "delivering", lastFollowResult: "follower" }),
    });

    await expect(
      test.repository.markAwaitingFollow({
        attemptId: ATTEMPT_ID,
        expectedState: "checking_follow",
        checkedAt: NOW,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "state_conflict", actualState: "delivering" });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["beginChecking", "awaiting_request", "checking_follow"],
    ["markAwaitingFollow", "checking_follow", "awaiting_follow"],
    ["markDelivering", "checking_follow", "delivering"],
    ["markDelivered", "delivering", "delivered"],
    ["markNeedsReview", "checking_follow", "needs_review"],
    ["markExpired", "awaiting_request", "expired"],
  ] as const)("exposes the fenced %s transition", async (method, from, to) => {
    const lastFollowResult =
      from === "delivering" ? "follower" : from === "awaiting_follow" ? "non_follower" : "unknown";
    const test = harness({ lockedAttempt: attempt({ state: from, lastFollowResult }) });
    const common = { attemptId: ATTEMPT_ID, expectedState: from };
    const inputs = {
      beginChecking: { ...common, now: NOW },
      markAwaitingFollow: { ...common, checkedAt: NOW, now: NOW },
      markDelivering: { ...common, checkedAt: NOW, now: NOW },
      markDelivered: common,
      markNeedsReview: { ...common, checkedAt: NOW },
      markExpired: { ...common, now: NOW },
    };

    const result = await (test.repository[method] as (input: never) => Promise<unknown>)(
      inputs[method] as never,
    );

    expect(result).toMatchObject({ kind: "transitioned", attempt: { state: to } });
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledOnce();
  });
});

// Fix round 2. The retryable-review fence had no repository-level test — the
// service suite proved it only through a hand-written fake. These drive the real
// predicate.
describe("retryable review fence in claimDirectInbound", () => {
  it("admits a review that never obtained a definitive follow answer", async () => {
    const test = harness({
      lockedToken: null,
      lockedAttempt: attempt({ state: "needs_review", lastFollowResult: "unknown" }),
    });

    await expect(
      test.repository.claimDirectInbound({
        attemptId: ATTEMPT_ID,
        inboundMessageId: TOKEN_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "consumed" });

    // The discriminator must be pinned in the predicate, so a concurrent writer
    // that supplies a definitive answer cannot have its terminal review reopened.
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "needs_review",
        lastFollowResult: "unknown",
        followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
        messagingWindowExpiresAt: { gt: NOW },
      },
      data: {
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: { increment: 1 },
      },
    });
  });

  it.each([
    { lastFollowResult: "non_follower" as const },
    { lastFollowResult: "follower" as const },
  ])(
    "refuses a review that already holds a $lastFollowResult answer",
    async ({ lastFollowResult }) => {
      const test = harness({
        lockedToken: null,
        lockedAttempt: attempt({ state: "needs_review", lastFollowResult }),
      });

      await expect(
        test.repository.claimDirectInbound({
          attemptId: ATTEMPT_ID,
          inboundMessageId: TOKEN_ID,
          now: NOW,
        }),
      ).resolves.toEqual({ kind: "state_conflict", actualState: "needs_review" });

      expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
    },
  );

  it("still bounds an admitted review by the follow-check limit", async () => {
    const test = harness({
      lockedToken: null,
      lockedAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        followCheckCount: GUIDE_ACCESS_MAX_FOLLOW_CHECKS,
      }),
    });

    await expect(
      test.repository.claimDirectInbound({
        attemptId: ATTEMPT_ID,
        inboundMessageId: TOKEN_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "check_limit_reached" });

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("expires an admitted review whose messaging window already closed", async () => {
    const test = harness({
      lockedToken: null,
      lockedAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        messagingWindowExpiresAt: new Date(NOW.getTime() - 1),
      }),
    });

    await expect(
      test.repository.claimDirectInbound({
        attemptId: ATTEMPT_ID,
        inboundMessageId: TOKEN_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "expired" });
  });
});

// Parent-delivery Task 2. The published-cover lookup moves INSIDE the attempt
// transaction, so the caller can no longer hand in a `coverVersionId` and no later
// publication can rewrite an attempt already in flight.
describe("cover snapshot on attempt creation", () => {
  const DM_PATH = "guide-covers/sleep/dm-abc123.png";

  function createInput() {
    return {
      conversationId: CONVERSATION_ID,
      resourceId: RESOURCE_ID,
      messagingWindowExpiresAt: WINDOW_EXPIRES_AT,
      now: NOW,
    };
  }

  it("stores the published cover and returns its immutable DM path", async () => {
    const test = harness({
      activeAttempt: null,
      lockedAttempt: null,
      publishedCover: { id: COVER_ID, resourceId: RESOURCE_ID, dmStoragePath: DM_PATH },
    });

    const result = await test.repository.createOrLoadAttempt(createInput());

    expect(result.kind).toBe("created");
    expect(result.cover).toEqual({
      versionId: COVER_ID,
      resourceId: RESOURCE_ID,
      dmStoragePath: DM_PATH,
    });
    expect(test.tx.guideAccessAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coverVersionId: COVER_ID }),
      }),
    );
  });

  it("stores null when the guide has no published cover", async () => {
    const test = harness({
      activeAttempt: null,
      lockedAttempt: null,
      publishedCover: null,
    });

    const result = await test.repository.createOrLoadAttempt(createInput());

    expect(result.cover).toBeNull();
    expect(test.tx.guideAccessAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coverVersionId: null }),
      }),
    );
  });

  it("selects only a published, render-ready row with a stored DM path", async () => {
    const test = harness({
      activeAttempt: null,
      lockedAttempt: null,
      publishedCover: { id: COVER_ID, resourceId: RESOURCE_ID, dmStoragePath: DM_PATH },
    });

    await test.repository.createOrLoadAttempt(createInput());

    // The predicate is the contract here: a draft, a published-but-unrendered row, or a
    // published row with no stored path must all be excluded by the query itself rather
    // than filtered afterwards.
    expect(test.tx.resourceCoverVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          resourceId: RESOURCE_ID,
          status: "published",
          renderStatus: "ready",
          contentHash: { not: null },
          dmStoragePath: { not: null },
        }),
      }),
    );
  });

  it("performs no published lookup on replay and resolves the original snapshot", async () => {
    const original = attempt({ resourceId: RESOURCE_ID, coverVersionId: COVER_ID });
    const test = harness({
      activeAttempt: original,
      lockedAttempt: original,
      // A newer cover has since been published. It must not win.
      publishedCover: {
        id: "99999999-9999-4999-8999-999999999999",
        resourceId: RESOURCE_ID,
        dmStoragePath: "new.png",
      },
      coverById: { id: COVER_ID, resourceId: RESOURCE_ID, dmStoragePath: DM_PATH },
    });

    const result = await test.repository.createOrLoadAttempt(createInput());

    expect(result.kind).toBe("loaded");
    expect(result.attempt.coverVersionId).toBe(COVER_ID);
    expect(result.cover).toEqual({
      versionId: COVER_ID,
      resourceId: RESOURCE_ID,
      dmStoragePath: DM_PATH,
    });
    // Resolved by id only. A fresh published lookup would let a later publication
    // silently change what an in-flight attempt will send.
    expect(test.tx.resourceCoverVersion.findFirst).not.toHaveBeenCalled();
    expect(test.tx.resourceCoverVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(test.tx.resourceCoverVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COVER_ID } }),
    );
    expect(test.tx.guideAccessAttempt.create).not.toHaveBeenCalled();
  });

  it("returns a null cover on replay when the original attempt had none", async () => {
    const original = attempt({ resourceId: RESOURCE_ID, coverVersionId: null });
    const test = harness({
      activeAttempt: original,
      lockedAttempt: original,
      publishedCover: { id: COVER_ID, resourceId: RESOURCE_ID, dmStoragePath: DM_PATH },
    });

    const result = await test.repository.createOrLoadAttempt(createInput());

    expect(result.cover).toBeNull();
    // No id to resolve, and no published lookup allowed.
    expect(test.tx.resourceCoverVersion.findFirst).not.toHaveBeenCalled();
    expect(test.tx.resourceCoverVersion.findUnique).not.toHaveBeenCalled();
  });

  it("treats a snapshot whose row lost its DM path as no cover", async () => {
    const original = attempt({ resourceId: RESOURCE_ID, coverVersionId: COVER_ID });
    const test = harness({
      activeAttempt: original,
      lockedAttempt: original,
      coverById: { id: COVER_ID, resourceId: RESOURCE_ID, dmStoragePath: null },
    });

    const result = await test.repository.createOrLoadAttempt(createInput());

    // The attempt keeps its snapshot id for evidence, but nothing sendable resolves.
    expect(result.attempt.coverVersionId).toBe(COVER_ID);
    expect(result.cover).toBeNull();
  });
});

// Parent-delivery Task 5, review round 1. A delivery's completion callback identifies its
// attempt only by conversation. Nothing stops a *stale* callback from arriving after its
// own attempt was force-expired and a newer one took its place, so the settle needs a
// handle on the attempt it actually belongs to.
describe("settleAttemptForConversation", () => {
  it("settles a delivering attempt whose window matches the delivery's", async () => {
    const test = harness({
      activeAttempt: attempt({ state: "delivering", lastFollowResult: "follower" }),
    });

    await expect(
      test.repository.settleAttemptForConversation({
        conversationId: CONVERSATION_ID,
        outcome: "delivered",
        expectedWindowExpiresAt: WINDOW_EXPIRES_AT,
      }),
    ).resolves.toBe("settled");

    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID, state: "delivering" },
      data: { state: "delivered" },
    });
  });

  it("refuses to settle an attempt from a different messaging window", async () => {
    // The interleaving: every unit of delivery D1 goes out, D1's window lapses, the parent
    // messages again, attempt A is force-expired, attempt B is created and reaches
    // `delivering`. D1's late completion must not close B — B's guide is still in flight.
    const newerWindow = new Date(WINDOW_EXPIRES_AT.getTime() + 24 * 60 * 60 * 1000);
    const test = harness({
      activeAttempt: attempt({
        id: "10000000-0000-4000-8000-00000000000b",
        state: "delivering",
        lastFollowResult: "follower",
        messagingWindowExpiresAt: newerWindow,
      }),
    });

    await expect(
      test.repository.settleAttemptForConversation({
        conversationId: CONVERSATION_ID,
        outcome: "delivered",
        expectedWindowExpiresAt: WINDOW_EXPIRES_AT,
      }),
    ).resolves.toBe("window_mismatch");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("reports no attempt for a delivery that never went through the strict gate", async () => {
    const test = harness({ activeAttempt: null });

    await expect(
      test.repository.settleAttemptForConversation({
        conversationId: CONVERSATION_ID,
        outcome: "delivered",
        expectedWindowExpiresAt: WINDOW_EXPIRES_AT,
      }),
    ).resolves.toBe("not_found");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("leaves an attempt the action service already resolved alone", async () => {
    const test = harness({
      activeAttempt: attempt({ state: "needs_review", lastFollowResult: "follower" }),
    });

    await expect(
      test.repository.settleAttemptForConversation({
        conversationId: CONVERSATION_ID,
        outcome: "delivered",
        expectedWindowExpiresAt: WINDOW_EXPIRES_AT,
      }),
    ).resolves.toBe("already_settled");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });
});

// Review round 2, Important. Every fault in this design routes to `needs_review`, and
// nothing could clear one: `markExpired` had no production caller, no route read
// `guide_access_attempt`, and the only escape was the parent messaging again AFTER their
// 24h window lapsed. A parent who gave up stayed blocked, invisibly.
describe("releaseAttemptForConversation", () => {
  it("expires a stuck attempt so the parent can start over", async () => {
    const test = harness({
      activeAttempt: attempt({ state: "needs_review", lastFollowResult: "non_follower" }),
      lockedAttempt: attempt({ state: "needs_review", lastFollowResult: "non_follower" }),
    });

    await expect(
      test.repository.releaseAttemptForConversation({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("released");

    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID, state: "needs_review" },
      data: { state: "expired" },
    });
    // Audited in the same transaction, and carrying no sender id, copy, or URL.
    expect(test.tx.eventLog.create).toHaveBeenCalledWith({
      data: {
        kind: "guide_access_owner_action",
        payload: {
          actor: "owner@example.com",
          action: "release_attempt",
          conversationId: CONVERSATION_ID,
          attemptId: ATTEMPT_ID,
          releasedFrom: "needs_review",
          at: NOW.toISOString(),
        },
      },
    });
  });

  it("refuses to release an attempt that already had a delivery, not just one mid-flight", async () => {
    // `delivering` alone is not the hazard. `handleFollower` moves an attempt
    // `delivering -> needs_review` when the durable delivery fails to start, and the delivery
    // row survives with an uncertain unit the owner-review retry can still fire. Releasing
    // that attempt frees the conversation, so the parent's next message opens a new attempt
    // and `deliverGuideForTrigger` — which dedupes only on (triggerKind, triggerId) — builds
    // a SECOND full guide. `lastFollowResult: "follower"` is exactly "this attempt reached
    // delivering", so it is the handle. The remedy is cancelling the delivery, which releases
    // its own attempt correctly.
    const test = harness({
      activeAttempt: attempt({ state: "needs_review", lastFollowResult: "follower" }),
      lockedAttempt: attempt({ state: "needs_review", lastFollowResult: "follower" }),
    });

    await expect(
      test.repository.releaseAttemptForConversation({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("delivering");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("still releases a review that never got as far as a delivery", async () => {
    const test = harness({
      activeAttempt: attempt({ state: "needs_review", lastFollowResult: "non_follower" }),
      lockedAttempt: attempt({ state: "needs_review", lastFollowResult: "non_follower" }),
    });

    await expect(
      test.repository.releaseAttemptForConversation({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("released");
  });

  it("refuses to release an attempt that is mid-delivery", async () => {
    const test = harness({
      activeAttempt: attempt({ state: "delivering", lastFollowResult: "follower" }),
      lockedAttempt: attempt({ state: "delivering", lastFollowResult: "follower" }),
    });

    // Expiring a `delivering` attempt is precisely the duplicate-guide hazard the cancel
    // path had: it leaves nothing active, so the parent's next message opens a new attempt
    // and sends a second guide while the first is still in flight. A stuck delivery is
    // resolved through the delivery review, which releases its own attempt correctly.
    await expect(
      test.repository.releaseAttemptForConversation({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("delivering");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("reports nothing to release when no attempt is active", async () => {
    const test = harness({ activeAttempt: null });

    await expect(
      test.repository.releaseAttemptForConversation({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("not_found");

    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
  });
});

// Review round 3, Important. `markNeedsReview` gained a `followResult` write, and that ONE
// line is what stops a parent being sent the follow gate twice. Deleting it passed the whole
// 3367-test suite: the action-service harness re-implements the write in its own fake, so
// those tests prove the CALL and are blind to the write. This file had the same gap for the
// retryable-review fence one method over, and said so at the time.
describe("markNeedsReview persists the follow answer it is given", () => {
  it("writes the definite answer so the review stops being re-enterable", async () => {
    const test = harness({
      lockedAttempt: attempt({ state: "checking_follow", lastFollowResult: "unknown" }),
    });

    const result = await test.repository.markNeedsReview({
      attemptId: ATTEMPT_ID,
      expectedState: "checking_follow",
      checkedAt: NOW,
      followResult: "non_follower",
    });

    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID, state: "checking_follow" },
      data: {
        state: "needs_review",
        lastFollowCheckedAt: NOW,
        lastFollowResult: "non_follower",
      },
    });
    // And returned, so a caller reasoning about the attempt sees the same fact the row holds.
    expect(result).toMatchObject({
      kind: "transitioned",
      attempt: expect.objectContaining({ lastFollowResult: "non_follower" }),
    });
  });

  it("leaves the answer alone when it was never found out", async () => {
    const test = harness({
      lockedAttempt: attempt({ state: "checking_follow", lastFollowResult: "unknown" }),
    });

    await test.repository.markNeedsReview({
      attemptId: ATTEMPT_ID,
      expectedState: "checking_follow",
      checkedAt: NOW,
    });

    // `unknown` is the whole basis of `isRetryableReview`. Defaulting it to anything else
    // here would permanently wedge every parent whose live follow check was unavailable.
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID, state: "checking_follow" },
      data: { state: "needs_review", lastFollowCheckedAt: NOW },
    });
  });
});
