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
    const test = harness({ activeAttempt: original });

    await expect(
      test.repository.createOrLoadAttempt({
        conversationId: CONVERSATION_ID,
        resourceId: "60000000-0000-4000-8000-000000000006",
        coverVersionId: null,
        messagingWindowExpiresAt: new Date("2026-08-25T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ kind: "loaded", attempt: originalRecord });
    expect(test.tx.guideAccessAttempt.create).not.toHaveBeenCalled();
  });

  it("expires a time-closed attempt before creating a new active attempt", async () => {
    const closed = attempt({ messagingWindowExpiresAt: NOW });
    const test = harness({ activeAttempt: closed, lockedAttempt: closed });

    await expect(
      test.repository.createOrLoadAttempt({
        conversationId: CONVERSATION_ID,
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
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
        followCheckCount: { lt: 3 },
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
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(test.tx.guideActionToken.updateMany).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, status: "active" },
      data: { status: "expired" },
    });
    expect(test.tx.guideAccessAttempt.updateMany).not.toHaveBeenCalled();
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
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "consumed" });
    expect(test.tx.guideAccessAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: ATTEMPT_ID,
        state: "awaiting_request",
        followCheckCount: { lt: 3 },
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
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "state_conflict", actualState: "awaiting_request" });
  });

  it("reserves at most two automatic follow responses", async () => {
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
        followResponseCount: 2,
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
