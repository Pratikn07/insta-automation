import type { GuideAccessAttempt, GuideActionToken } from "@prisma/client";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  guideAccessCopy,
  guideAccessOpening,
  guideAccessOpeningText,
} from "./guideAccessCopy.js";
import { createGuideAccessActionService } from "./guideAccessActionService.js";
import type { GuideActionCapabilities } from "../meta/sendGuideAction.js";

const TEXT_ONLY: GuideActionCapabilities = {
  privateQuickReply: false,
  dmGenericGate: false,
  dmQuickReply: false,
};
const RICH: GuideActionCapabilities = {
  privateQuickReply: true,
  dmGenericGate: true,
  dmQuickReply: true,
};
const COMMENT_ID = "comment-4001";
// Mirrors MAX_FOLLOW_CHECKS in guideAccessRepository.ts.
const MAX_FOLLOW_CHECKS = 3;

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000002";
const RESOURCE_ID = "30000000-0000-4000-8000-000000000003";
const REQUEST_TOKEN_ID = "40000000-0000-4000-8000-000000000004";
const FOLLOW_TOKEN_1 = "50000000-0000-4000-8000-000000000005";
const FOLLOW_TOKEN_2 = "60000000-0000-4000-8000-000000000006";
const FOLLOW_TOKEN_3 = "70000000-0000-4000-8000-000000000007";
const INBOUND_ID = "80000000-0000-4000-8000-000000000008";
const DIRECT_INBOUND_ID = "90000000-0000-4000-8000-000000000009";
const THREAD_ID = "a0000000-0000-4000-8000-00000000000a";
const SENDER_ID = "instagram-parent-1";
const NOW = new Date("2026-08-23T12:00:00.000Z");
const EVENT_AT = new Date("2026-08-23T11:59:58.000Z");
const WINDOW_END = new Date("2026-08-24T11:59:58.000Z");

function attempt(overrides: Partial<GuideAccessAttempt> = {}): GuideAccessAttempt {
  return {
    id: ATTEMPT_ID,
    conversationId: CONVERSATION_ID,
    resourceId: RESOURCE_ID,
    coverVersionId: null,
    state: "awaiting_request",
    lastFollowResult: "unknown",
    lastFollowCheckedAt: null,
    followCheckCount: 0,
    followResponseCount: 0,
    coverExposure: "not_shown",
    coverProviderMessageId: null,
    messagingWindowExpiresAt: WINDOW_END,
    createdAt: new Date("2026-06-23T12:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

function actionToken(id: string, action: "request_guide" | "check_follow"): GuideActionToken {
  return {
    id,
    attemptId: ATTEMPT_ID,
    action,
    status: "active",
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    consumedAt: null,
    createdAt: NOW,
  };
}

type FreshResult =
  | { source: "meta_live"; isFollower: boolean; checkedAt: Date }
  | {
      source: "unavailable";
      isFollower: null;
      checkedAt: Date;
      errorCode: "fresh_follow_read_failed";
    };

function live(isFollower: boolean): FreshResult {
  return { source: "meta_live", isFollower, checkedAt: NOW };
}

const unavailable: FreshResult = {
  source: "unavailable",
  isFollower: null,
  checkedAt: NOW,
  errorCode: "fresh_follow_read_failed",
};

function createHarness(input: {
  initialAttempt?: GuideAccessAttempt;
  consumeResults?: Array<
    | { kind: "consumed"; attempt: GuideAccessAttempt }
    | { kind: "already_consumed" }
    | { kind: "expired" }
    | { kind: "wrong_sender" }
    | { kind: "check_limit_reached" }
    | { kind: "state_conflict"; actualState: GuideAccessAttempt["state"] }
  >;
  freshResults?: FreshResult[];
  deliveryResults?: Array<
    | "completed"
    | "preflight_failed"
    | "needs_review"
    | "retry_scheduled"
    | "already_processing"
  >;
  startDelivery?: () => Promise<
    | "completed"
    | "preflight_failed"
    | "needs_review"
    | "retry_scheduled"
    | "already_processing"
  >;
  sendGate?: () => Promise<{ messageId: string | null }>;
  sendText?: (input: { recipientId: string; text: string }) => Promise<{ messageId: string | null }>;
  sendFollowLag?: (input: {
    recipientId: string;
    actionToken: string;
  }) => Promise<{ messageId: string | null }>;
  loadGuideName?: (resourceId: string) => Promise<string>;
  loadThreadId?: (inboundMessageId: string) => Promise<string | null>;
  repositoryFailures?: Partial<Record<
    | "consumeToken"
    | "claimDirectInbound"
    | "markAwaitingFollow"
    | "markDelivered"
    | "markDelivering"
    | "markNeedsReview"
    | "replaceToken"
    | "reserveFollowResponse",
    Error[]
  >>;
  repositoryAmbiguities?: Partial<Record<
    | "consumeToken"
    | "claimDirectInbound"
    | "markAwaitingFollow"
    | "markDelivered"
    | "markDelivering"
    | "markNeedsReview"
    | "replaceToken"
    | "reserveFollowResponse",
    Error[]
  >>;
  markNeedsReviewResults?: Array<
    | { kind: "attempt_not_found" }
    | { kind: "state_conflict"; actualState: GuideAccessAttempt["state"] }
  >;
  sendInitialPrivateReply?: (input: {
    commentId: string;
    guideName: string;
    actionToken: string;
    capabilities: GuideActionCapabilities;
  }) => Promise<{ messageId: string | null }>;
  richCapabilities?: GuideActionCapabilities;
  coverSnapshot?: { versionId: string; resourceId: string; dmStoragePath: string } | null;
  exposureAlready?: "accepted" | "uncertain" | "failed";
  sendCover?: () => Promise<{ messageId: string | null }>;
  coverDecision?: "include" | "omit";
  issueTokenResults?: Array<
    | { kind: "attempt_not_found" }
    | { kind: "attempt_expired" }
    | { kind: "state_conflict"; actualState: GuideAccessAttempt["state"] }
  >;
}) {
  let current = input.initialAttempt ?? attempt();
  let nextToken = 0;
  let requestTokenIssued = false;
  let coverClaimed = false;
  const followTokens = [FOLLOW_TOKEN_1, FOLLOW_TOKEN_2, FOLLOW_TOKEN_3];
  const consumed = new Set<string>();
  const directClaims = new Set<string>();
  const cancelledTokens = new Set<string>();
  let activeFollowToken: string | null = null;
  const tokenAttempt = new Map<string, string>([
    [REQUEST_TOKEN_ID, ATTEMPT_ID],
    ...followTokens.map((id) => [id, ATTEMPT_ID] as const),
  ]);
  const order: string[] = [];
  function fail(stage: keyof NonNullable<typeof input.repositoryFailures>): void {
    const error = input.repositoryFailures?.[stage]?.shift();
    if (error) throw error;
  }
  function loseAcknowledgement(
    stage: keyof NonNullable<typeof input.repositoryAmbiguities>,
  ): void {
    const error = input.repositoryAmbiguities?.[stage]?.shift();
    if (error) throw error;
  }

  const repository = {
    createOrLoadAttempt: vi.fn(async () => {
      const kind = current.state === "awaiting_request" ? "created" : "loaded";
      return { kind, attempt: { ...current } } as const;
    }),
    consumeToken: vi.fn(async (request: { tokenId: string; action: string }) => {
      order.push(`consume:${request.action}`);
      fail("consumeToken");
      const forced = input.consumeResults?.shift();
      if (forced) {
        if (forced.kind === "consumed") current = { ...forced.attempt };
        return forced;
      }
      if (cancelledTokens.has(request.tokenId)) return { kind: "expired" } as const;
      if (consumed.has(request.tokenId)) return { kind: "already_consumed" } as const;
      if (request.action === "check_follow" && current.state !== "awaiting_follow") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      consumed.add(request.tokenId);
      current = {
        ...current,
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: current.followCheckCount + 1,
      };
      loseAcknowledgement("consumeToken");
      return { kind: "consumed", attempt: { ...current } } as const;
    }),
    claimDirectInbound: vi.fn(async (request: { inboundMessageId: string }) => {
      order.push("claim:direct_inbound");
      fail("claimDirectInbound");
      if (directClaims.has(request.inboundMessageId)) {
        return { kind: "already_consumed" } as const;
      }
      directClaims.add(request.inboundMessageId);
      tokenAttempt.set(request.inboundMessageId, ATTEMPT_ID);
      // Mirrors the repository fence: an inconclusive review is retryable.
      const retryableReview =
        current.state === "needs_review" && current.lastFollowResult === "unknown";
      if (
        current.state !== "awaiting_request" &&
        current.state !== "awaiting_follow" &&
        !retryableReview
      ) {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      // The real fence also bounds the window and the check count. Without these
      // the retry-bound test would prove only that the service handles a stubbed
      // return value rather than that the bound actually fires.
      if (current.messagingWindowExpiresAt <= NOW) return { kind: "expired" } as const;
      if (current.followCheckCount >= MAX_FOLLOW_CHECKS) {
        return { kind: "check_limit_reached" } as const;
      }
      current = {
        ...current,
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: current.followCheckCount + 1,
      };
      loseAcknowledgement("claimDirectInbound");
      return { kind: "consumed", attempt: { ...current } } as const;
    }),
    beginChecking: vi.fn(async (request: { expectedState: GuideAccessAttempt["state"] }) => {
      order.push(`begin:${request.expectedState}`);
      if (current.state !== request.expectedState) {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: current.followCheckCount + 1,
      };
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markAwaitingFollow: vi.fn(async () => {
      order.push("mark:awaiting_follow");
      fail("markAwaitingFollow");
      if (current.state !== "checking_follow") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "awaiting_follow",
        lastFollowResult: "non_follower",
        lastFollowCheckedAt: NOW,
      };
      loseAcknowledgement("markAwaitingFollow");
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markDelivering: vi.fn(async () => {
      order.push("mark:delivering");
      fail("markDelivering");
      if (current.state !== "checking_follow") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "delivering",
        lastFollowResult: "follower",
        lastFollowCheckedAt: NOW,
      };
      loseAcknowledgement("markDelivering");
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markNeedsReview: vi.fn(async (request: {
      expectedState: GuideAccessAttempt["state"];
      followResult?: GuideAccessAttempt["lastFollowResult"];
    }) => {
      order.push("mark:needs_review");
      fail("markNeedsReview");
      const forced = input.markNeedsReviewResults?.shift();
      if (forced) return forced;
      if (current.state !== request.expectedState) {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "needs_review",
        ...(request.followResult ? { lastFollowResult: request.followResult } : {}),
      };
      loseAcknowledgement("markNeedsReview");
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    issueToken: vi.fn(async (request: { action: "request_guide" | "check_follow" }) => {
      order.push(`issue:${request.action}`);
      const forced = input.issueTokenResults?.shift();
      if (forced) return forced;
      if (request.action === "request_guide") {
        // A journey issues one opening token. A repeat comment must observe the
        // existing token rather than mint a second private reply.
        const kind = requestTokenIssued ? "replayed" : "issued";
        requestTokenIssued = true;
        return {
          kind,
          token: actionToken(REQUEST_TOKEN_ID, "request_guide"),
        } as const;
      }
      const id = followTokens[nextToken++]!;
      return { kind: "issued", token: actionToken(id, "check_follow") } as const;
    }),
    replaceToken: vi.fn(async () => {
      order.push("replace:check_follow");
      fail("replaceToken");
      if (activeFollowToken) cancelledTokens.add(activeFollowToken);
      const id = followTokens[nextToken++]!;
      activeFollowToken = id;
      loseAcknowledgement("replaceToken");
      return { kind: "issued", token: actionToken(id, "check_follow") } as const;
    }),
    reserveFollowResponse: vi.fn(async () => {
      order.push("reserve:follow_response");
      fail("reserveFollowResponse");
      if (current.followResponseCount >= 2) return { kind: "limit_reached" } as const;
      const responseNumber = (current.followResponseCount + 1) as 1 | 2;
      current = { ...current, followResponseCount: responseNumber };
      loseAcknowledgement("reserveFollowResponse");
      return { kind: "reserved", responseNumber } as const;
    }),
    markDelivered: vi.fn(async () => {
      order.push("mark:delivered");
      fail("markDelivered");
      if (current.state !== "delivering") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = { ...current, state: "delivered" };
      loseAcknowledgement("markDelivered");
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markExpired: vi.fn(),
    claimCoverExposure: vi.fn(async () => {
      order.push("claim:cover_exposure");
      if (input.exposureAlready) {
        return { kind: "already_claimed", exposure: input.exposureAlready } as const;
      }
      if (coverClaimed) {
        return { kind: "already_claimed", exposure: "uncertain" } as const;
      }
      coverClaimed = true;
      current = { ...current, coverExposure: "uncertain" };
      return { kind: "claimed" } as const;
    }),
    settleCoverExposure: vi.fn(async (request: {
      exposure: "accepted" | "failed";
      providerMessageId: string | null;
    }) => {
      order.push(`settle:cover_${request.exposure}`);
      current = {
        ...current,
        coverExposure: request.exposure,
        coverProviderMessageId: request.providerMessageId,
      };
    }),
    findCoverSnapshot: vi.fn(async () => input.coverSnapshot ?? null),
  };

  const resolveFresh = vi.fn(async () => {
    order.push("external:verify");
    return input.freshResults?.shift() ?? live(true);
  });
  const startGuideDelivery = vi.fn(async () => {
    order.push("external:delivery");
    if (input.startDelivery) return input.startDelivery();
    return input.deliveryResults?.shift() ?? "completed";
  });
  const sendFollowerGate = vi.fn(async () => {
    order.push("external:gate");
    return input.sendGate ? input.sendGate() : { messageId: "gate-mid" };
  });
  const sendText = vi.fn(async (message: { recipientId: string; text: string }) => {
    order.push("external:unavailable");
    return input.sendText ? input.sendText(message) : { messageId: "text-mid" };
  });
  const sendFollowLag = vi.fn(async (message: {
    recipientId: string;
    actionToken: string;
  }) => {
    order.push("external:lag");
    return input.sendFollowLag
      ? input.sendFollowLag(message)
      : { messageId: "lag-mid" };
  });
  const sendInitialPrivateReply = vi.fn(async (message: {
    commentId: string;
    guideName: string;
    actionToken: string;
    capabilities: GuideActionCapabilities;
  }) => {
    order.push("external:opening");
    return input.sendInitialPrivateReply
      ? input.sendInitialPrivateReply(message)
      : { messageId: "opening-mid" };
  });
  const richCapabilities = vi.fn(() => input.richCapabilities ?? TEXT_ONLY);
  const sendCover = vi.fn(async () => {
    order.push("external:cover");
    return input.sendCover ? input.sendCover() : { messageId: "cover-mid" };
  });
  const coverMediaUrl = vi.fn((path: string) => `https://cdn.example.test/${path}`);
  const recordCoverMetric = vi.fn(async () => undefined);
  const coverDecision = vi.fn(() => input.coverDecision ?? ("include" as "include" | "omit"));
  const recordFreshCheck = vi.fn(async () => undefined);
  const recordRecheck = vi.fn(async () => undefined);
  const recordGateShown = vi.fn(async () => undefined);
  const loadGuideName = vi.fn(
    input.loadGuideName ?? (async () => "toddler sleep guide"),
  );
  const loadThreadId = vi.fn(input.loadThreadId ?? (async () => THREAD_ID));
  const logger = { error: vi.fn() };
  const findAttemptIdByToken = vi.fn(
    async (tokenId: string) => tokenAttempt.get(tokenId) ?? null,
  );

  const service = createGuideAccessActionService({
    repository: repository as never,
    resolveFollowStatusFresh: resolveFresh,
    startGuideDelivery,
    sendFollowerGate,
    sendText,
    sendFollowLag,
    sendInitialPrivateReply,
    richCapabilities,
    sendCover,
    coverMediaUrl,
    coverDecision,
    recordCoverMetric,
    recordFreshCheck,
    recordRecheck,
    recordGateShown,
    loadGuideName,
    loadThreadId,
    findAttemptIdByToken,
    logger,
    now: () => NOW,
    actionTokenTtlMs: 10 * 60_000,
  });

  return {
    service,
    repository,
    resolveFresh,
    startGuideDelivery,
    sendFollowerGate,
    sendText,
    sendFollowLag,
    sendInitialPrivateReply,
    richCapabilities,
    sendCover,
    coverMediaUrl,
    coverDecision,
    recordCoverMetric,
    recordFreshCheck,
    recordRecheck,
    recordGateShown,
    loadGuideName,
    loadThreadId,
    cancelledTokens,
    logger,
    order,
    attempt: () => current,
  };
}

async function request(test: ReturnType<typeof createHarness>, senderId = SENDER_ID) {
  return test.service.requestGuideFromAction(
    REQUEST_TOKEN_ID,
    senderId,
    INBOUND_ID,
    EVENT_AT,
  );
}

async function check(test: ReturnType<typeof createHarness>, tokenId: string) {
  return test.service.checkFollowFromAction(tokenId, SENDER_ID, INBOUND_ID, EVENT_AT);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("strict live authorization matrix", () => {
  it.each([
    {
      name: "cached true/fresh false",
      fresh: live(false),
      want: "follow_not_confirmed",
      deliveryCalls: 0,
      gateCalls: 1,
    },
    {
      name: "cached true/live unavailable",
      fresh: unavailable,
      want: "follow_check_unavailable",
      deliveryCalls: 0,
      gateCalls: 0,
    },
    {
      name: "cached false/fresh true",
      fresh: live(true),
      want: "guide_delivery_started",
      deliveryCalls: 1,
      gateCalls: 0,
    },
    {
      name: "live result with a missing follower flag",
      fresh: { source: "meta_live", checkedAt: NOW } as never,
      want: "follow_check_unavailable",
      deliveryCalls: 0,
      gateCalls: 0,
    },
  ])("authorizes only exact live true: $name", async (row) => {
    const test = createHarness({ freshResults: [row.fresh] });

    await expect(request(test)).resolves.toBe(row.want);
    expect(test.startGuideDelivery).toHaveBeenCalledTimes(row.deliveryCalls);
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(row.gateCalls);
  });

  it("lets a two-month follower with no prior automation enter through a fresh direct-DM request", async () => {
    const test = createHarness({ freshResults: [live(true)] });

    await expect(
      test.service.startDirectDmGuideRequest(
        {
          id: CONVERSATION_ID,
          igUserId: SENDER_ID,
          resourceId: RESOURCE_ID,
          guideName: "toddler sleep guide",
          createdAt: new Date("2026-06-23T12:00:00.000Z"),
        },
        {
          id: DIRECT_INBOUND_ID,
          threadId: THREAD_ID,
          eventAt: EVENT_AT,
          messagingWindowExpiresAt: WINDOW_END,
        },
      ),
    ).resolves.toBe("guide_delivery_started");

    expect(test.resolveFresh).toHaveBeenCalledWith(SENDER_ID);
    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerKind: "inbound_reply",
        triggerId: DIRECT_INBOUND_ID,
        followerAtTrigger: true,
      }),
    );
    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "fresh false",
      fresh: live(false),
      want: "follow_not_confirmed",
      expectedText: null,
      gateCalls: 1,
    },
    {
      name: "live unavailable",
      fresh: unavailable,
      want: "follow_check_unavailable",
      expectedText: guideAccessCopy.unavailable,
      gateCalls: 0,
    },
  ])("applies the same strict gate to a direct DM without sending an opening: $name", async (row) => {
    const test = createHarness({ freshResults: [row.fresh] });

    await expect(
      test.service.startDirectDmGuideRequest(
        {
          id: CONVERSATION_ID,
          igUserId: SENDER_ID,
          resourceId: RESOURCE_ID,
          guideName: "toddler sleep guide",
        },
        {
          id: DIRECT_INBOUND_ID,
          threadId: THREAD_ID,
          eventAt: EVENT_AT,
          messagingWindowExpiresAt: WINDOW_END,
        },
      ),
    ).resolves.toBe(row.want);

    expect(test.sendFollowerGate).toHaveBeenCalledTimes(row.gateCalls);
    if (row.expectedText) {
      expect(test.sendText).toHaveBeenCalledWith({
        recipientId: SENDER_ID,
        text: row.expectedText,
      });
    } else {
      expect(test.sendText).not.toHaveBeenCalled();
    }
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });
});

describe("request and follow action orchestration", () => {
  it("fences awaiting-follow, rotates a check token, and sends the approved gate for fresh false", async () => {
    const test = createHarness({ freshResults: [live(false)] });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.repository.replaceToken).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      action: "check_follow",
      expectedState: "checking_follow",
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(test.sendFollowerGate).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      guideName: "toddler sleep guide",
      actionToken: FOLLOW_TOKEN_1,
    });
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.order).toEqual([
      "consume:request_guide",
      "external:verify",
      "replace:check_follow",
      "external:gate",
      "mark:awaiting_follow",
    ]);
  });

  it("withholds on unavailable, sends only neutral wording, and moves the attempt to review first", async () => {
    const test = createHarness({ freshResults: [unavailable] });

    await expect(request(test)).resolves.toBe("follow_check_unavailable");

    expect(test.sendText).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      text: guideAccessCopy.unavailable,
    });
    expect(test.repository.replaceToken).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.attempt().state).toBe("needs_review");
    expect(test.order).toEqual([
      "consume:request_guide",
      "external:verify",
      "mark:needs_review",
      "external:unavailable",
    ]);
  });

  it("sends a gentle lag response for a false recheck, then starts delivery with token UUID identity on fresh true", async () => {
    const test = createHarness({ freshResults: [live(false), live(false), live(true)] });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_2)).resolves.toBe("guide_delivery_started");

    expect(test.sendFollowLag).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      actionToken: FOLLOW_TOKEN_2,
    });
    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerKind: "follow_recovery",
        triggerId: FOLLOW_TOKEN_2,
        followerAtTrigger: true,
      }),
    );
  });

  it("uses inbound-reply identity for a successful request action", async () => {
    const test = createHarness({ freshResults: [live(true)] });

    await expect(request(test)).resolves.toBe("guide_delivery_started");

    expect(test.startGuideDelivery).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      resourceId: RESOURCE_ID,
      igUserId: SENDER_ID,
      threadId: THREAD_ID,
      triggerKind: "inbound_reply",
      triggerId: INBOUND_ID,
      triggeredAt: EVENT_AT,
      sendWindowExpiresAt: WINDOW_END,
      followerAtTrigger: true,
    });
    expect(test.order).toEqual([
      "consume:request_guide",
      "external:verify",
      "mark:delivering",
      "external:delivery",
      "mark:delivered",
    ]);
  });

  it("looks up the delivery thread by inbound-message UUID while preserving follow-token trigger identity", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      freshResults: [live(true)],
    });

    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("guide_delivery_started");

    expect(test.loadThreadId).toHaveBeenCalledWith(INBOUND_ID);
    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        triggerKind: "follow_recovery",
        triggerId: FOLLOW_TOKEN_1,
      }),
    );
  });

  it("caps lag responses and moves an over-limit action to review without a Graph read or send", async () => {
    const capped = attempt({
      state: "awaiting_follow",
      lastFollowResult: "non_follower",
      followCheckCount: 3,
      followResponseCount: 2,
    });
    const test = createHarness({
      initialAttempt: capped,
      consumeResults: [{ kind: "check_limit_reached" }],
    });

    await expect(check(test, FOLLOW_TOKEN_3)).resolves.toBe("access_attempt_needs_review");

    expect(test.repository.markNeedsReview).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "awaiting_follow",
      checkedAt: NOW,
    });
    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
  });

  it("sends at most two gentle lag responses, then marks review and sends nothing", async () => {
    const test = createHarness({
      freshResults: [live(false), live(false), live(false), live(false)],
    });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_2)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_3)).resolves.toBe(
      "access_attempt_needs_review",
    );

    expect(test.sendFollowLag).toHaveBeenCalledTimes(2);
    expect(test.sendFollowLag).toHaveBeenNthCalledWith(1, {
      recipientId: SENDER_ID,
      actionToken: FOLLOW_TOKEN_2,
    });
    expect(test.sendFollowLag).toHaveBeenNthCalledWith(2, {
      recipientId: SENDER_ID,
      actionToken: FOLLOW_TOKEN_3,
    });
    expect(test.attempt().state).toBe("needs_review");
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("uses the bounded lag path when a direct DM rechecks an active follow wait", async () => {
    const test = createHarness({ freshResults: [live(false), live(false)] });
    const directConversation = {
      id: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      guideName: "toddler sleep guide",
    };
    const directInbound = {
      id: DIRECT_INBOUND_ID,
      threadId: THREAD_ID,
      eventAt: EVENT_AT,
      messagingWindowExpiresAt: WINDOW_END,
    };

    await expect(
      test.service.startDirectDmGuideRequest(directConversation, directInbound),
    ).resolves.toBe("follow_not_confirmed");
    await expect(
      test.service.startDirectDmGuideRequest(
        directConversation,
        { ...directInbound, id: INBOUND_ID },
      ),
    ).resolves.toBe("follow_not_confirmed");

    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.sendFollowLag).toHaveBeenCalledOnce();
    expect(test.sendFollowLag).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      actionToken: FOLLOW_TOKEN_2,
    });
  });

  it("does not spend a lag allowance or repeat external work for the same direct inbound UUID", async () => {
    const test = createHarness({ freshResults: [live(false)] });
    const conversation = {
      id: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      guideName: "toddler sleep guide",
    };
    const inbound = {
      id: DIRECT_INBOUND_ID,
      threadId: THREAD_ID,
      eventAt: EVENT_AT,
      messagingWindowExpiresAt: WINDOW_END,
    };

    await expect(
      test.service.startDirectDmGuideRequest(conversation, inbound),
    ).resolves.toBe("follow_not_confirmed");
    await expect(
      test.service.startDirectDmGuideRequest(conversation, inbound),
    ).resolves.toBe("action_replayed");

    expect(test.resolveFresh).toHaveBeenCalledOnce();
    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.sendFollowLag).not.toHaveBeenCalled();
    expect(test.attempt().followResponseCount).toBe(0);
    expect(test.repository.createOrLoadAttempt).toHaveBeenCalledOnce();
    expect(test.repository.claimDirectInbound).toHaveBeenCalledOnce();
  });

  it("does not create a new attempt when a completed direct inbound UUID replays", async () => {
    const test = createHarness({ freshResults: [live(true)] });
    const conversation = {
      id: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      guideName: "toddler sleep guide",
    };
    const inbound = {
      id: DIRECT_INBOUND_ID,
      threadId: THREAD_ID,
      eventAt: EVENT_AT,
      messagingWindowExpiresAt: WINDOW_END,
    };

    await expect(
      test.service.startDirectDmGuideRequest(conversation, inbound),
    ).resolves.toBe("guide_delivery_started");
    await expect(
      test.service.startDirectDmGuideRequest(conversation, inbound),
    ).resolves.toBe("action_replayed");

    expect(test.repository.createOrLoadAttempt).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
  });

  it("rotates the follow token and prevents the previous token from being spent", async () => {
    const test = createHarness({ freshResults: [live(false), live(false)] });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("follow_not_confirmed");
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("action_expired");

    expect(test.cancelledTokens).toContain(FOLLOW_TOKEN_1);
    expect(test.resolveFresh).toHaveBeenCalledTimes(2);
    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.sendFollowLag).toHaveBeenCalledOnce();
  });
});

describe("stable duplicate and invalid-action outcomes", () => {
  it("starts delivery exactly once when Meta replays a successful action", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      consumeResults: [
        { kind: "consumed", attempt: attempt({ state: "checking_follow", followCheckCount: 1 }) },
        { kind: "already_consumed" },
      ],
    });

    await expect(request(test)).resolves.toBe("guide_delivery_started");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.resolveFresh).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
  });

  it.each([
    ["expired token", { kind: "expired" } as const],
    ["wrong sender", { kind: "wrong_sender" } as const],
  ])("fails closed for %s before a live read", async (_name, result) => {
    const test = createHarness({ consumeResults: [result] });

    await expect(request(test, _name === "wrong sender" ? "attacker" : SENDER_ID)).resolves.toBe(
      "action_expired",
    );
    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("returns a stable already-started outcome without calling delivery again when the attempt is delivering", async () => {
    const test = createHarness({
      consumeResults: [{ kind: "state_conflict", actualState: "delivering" }],
    });

    await expect(request(test)).resolves.toBe("guide_delivery_already_started");
    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("maps a durable starter's existing trigger to the stable already-started outcome", async () => {
    const test = createHarness({ freshResults: [live(true)], deliveryResults: ["already_processing"] });

    await expect(request(test)).resolves.toBe("guide_delivery_already_started");
    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
  });

  it("marks the access attempt delivered when durable delivery completes synchronously", async () => {
    const test = createHarness({ freshResults: [live(true)], deliveryResults: ["completed"] });

    await expect(request(test)).resolves.toBe("guide_delivery_started");

    expect(test.repository.markDelivered).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "delivering",
    });
    expect(test.attempt().state).toBe("delivered");
  });

  it.each(["retry_scheduled", "already_processing"] as const)(
    "preserves delivering for a genuinely pending durable outcome: %s",
    async (deliveryResult) => {
      const test = createHarness({
        freshResults: [live(true)],
        deliveryResults: [deliveryResult],
      });

      await request(test);

      expect(test.repository.markDelivered).not.toHaveBeenCalled();
      expect(test.attempt().state).toBe("delivering");
    },
  );
});

describe("provider error boundary", () => {
  it("moves the awaiting-follow attempt to review when guide context cannot be loaded", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      loadGuideName: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
  });

  it("moves an uncertain gate send to review and never automatically repeats it", async () => {
    const ambiguous = new AxiosError("private payload", "ETIMEDOUT");
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: vi.fn().mockRejectedValue(ambiguous),
      consumeResults: [
        { kind: "consumed", attempt: attempt({ state: "checking_follow", followCheckCount: 1 }) },
        { kind: "already_consumed" },
      ],
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.repository.markNeedsReview).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "checking_follow",
      // The check answered; only the send was uncertain. Recording that is what keeps the
      // review terminal — see "an uncertain gate send is never repeated", which covers the
      // path this test does not: a fresh inbound rather than a replayed token.
      followResult: "non_follower",
    });
    expect(test.attempt()).toMatchObject({
      state: "needs_review",
      lastFollowResult: "non_follower",
    });
  });

  it("treats a receipt without a provider id as uncertain and never starts the guide", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: vi.fn().mockResolvedValue({ messageId: null }),
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    expect(test.attempt().state).toBe("needs_review");
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("leaves a definitely rejected gate in the retryable awaiting-follow plan", async () => {
    const rejected = new AxiosError(
      "private payload",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 400,
        statusText: "Bad Request",
        headers: {},
        config: { headers: {} } as never,
        data: { error: { code: 100, fbtrace_id: "safe_trace_1" } },
      },
    );
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: vi.fn().mockRejectedValue(rejected),
    });

    await expect(request(test)).resolves.toBe("action_consumed");
    expect(test.attempt().state).toBe("awaiting_follow");
    expect(test.repository.markNeedsReview).not.toHaveBeenCalled();
  });
});

describe("post-consumption checkpoint failures", () => {
  it("fences a rolled-back direct-inbound claim from the attempt's original state", async () => {
    const test = createHarness({
      repositoryFailures: {
        claimDirectInbound: [new Error("private repository detail")],
      },
    });

    await expect(
      test.service.startDirectDmGuideRequest(
        {
          id: CONVERSATION_ID,
          igUserId: SENDER_ID,
          resourceId: RESOURCE_ID,
          guideName: "toddler sleep guide",
        },
        {
          id: DIRECT_INBOUND_ID,
          threadId: THREAD_ID,
          eventAt: EVENT_AT,
          messagingWindowExpiresAt: WINDOW_END,
        },
      ),
    ).resolves.toBe("access_attempt_needs_review");

    expect(test.repository.markNeedsReview).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "awaiting_request",
    });
    expect(test.attempt().state).toBe("needs_review");
    expect(test.resolveFresh).not.toHaveBeenCalled();
  });

  it("contains token-rotation failure, records review, and never sends on replay", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      repositoryFailures: { replaceToken: [new Error("private repository detail")] },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.resolveFresh).toHaveBeenCalledOnce();
  });

  it("contains response-reservation failure and does not send a lag on replay", async () => {
    const test = createHarness({
      freshResults: [live(false), live(false)],
      repositoryFailures: {
        reserveFollowResponse: [new Error("private repository detail")],
      },
    });
    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe(
      "access_attempt_needs_review",
    );
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("action_replayed");

    expect(test.sendFollowLag).not.toHaveBeenCalled();
    expect(test.attempt().state).toBe("needs_review");
  });

  it("contains the post-send awaiting-follow checkpoint failure and never repeats the send", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      repositoryFailures: {
        markAwaitingFollow: [new Error("private repository detail")],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.attempt().state).toBe("needs_review");
  });

  it("contains delivering-claim failure before durable delivery and never starts on replay", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      repositoryFailures: { markDelivering: [new Error("private repository detail")] },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.attempt().state).toBe("needs_review");
  });

  it("contains unavailable-review checkpoint failure and sends nothing without a durable fence", async () => {
    const test = createHarness({
      freshResults: [unavailable],
      repositoryFailures: {
        markNeedsReview: [
          new Error("private repository detail one"),
          new Error("private repository detail two"),
        ],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.attempt().state).toBe("checking_follow");
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "guide_access_review_checkpoint_failed",
        attemptId: ATTEMPT_ID,
      }),
      expect.any(String),
    );
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain("private repository detail");
  });

  it("contains a failed uncertainty checkpoint with a non-spendable token and no repeated external work", async () => {
    const ambiguous = new AxiosError("private payload", "ETIMEDOUT");
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: vi.fn().mockRejectedValue(ambiguous),
      repositoryFailures: {
        markNeedsReview: [
          new Error("private repository detail one"),
          new Error("private repository detail two"),
        ],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe("action_replayed");

    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.resolveFresh).toHaveBeenCalledOnce();
    expect(test.attempt().state).toBe("checking_follow");
    expect(test.logger.error).toHaveBeenCalled();
  });

  it("contains starter failure plus review-checkpoint failure and never calls delivery twice", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      startDelivery: vi.fn().mockRejectedValue(new Error("private starter detail")),
      repositoryFailures: {
        markNeedsReview: [
          new Error("private repository detail one"),
          new Error("private repository detail two"),
        ],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
    expect(test.attempt().state).toBe("delivering");
    expect(test.logger.error).toHaveBeenCalled();
  });

  it("contains a completed-delivery checkpoint failure by moving the attempt to review", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      deliveryResults: ["completed"],
      repositoryFailures: { markDelivered: [new Error("private repository detail")] },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
    expect(test.attempt().state).toBe("needs_review");
  });
});

describe("ambiguous repository acknowledgements", () => {
  it.each([
    { name: "request", action: "request" as const, initial: attempt() },
    {
      name: "follow recheck",
      action: "check" as const,
      initial: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
    },
  ])(
    "reconciles a committed $name consume to review without authorizing",
    async ({ action, initial }) => {
      const test = createHarness({
        initialAttempt: initial,
        repositoryAmbiguities: {
          consumeToken: [new Error("private lost acknowledgement")],
        },
      });

      const first =
        action === "request" ? request(test) : check(test, FOLLOW_TOKEN_1);
      await expect(first).resolves.toBe("access_attempt_needs_review");
      await expect(
        action === "request" ? request(test) : check(test, FOLLOW_TOKEN_1),
      ).resolves.toBe("action_replayed");

      expect(test.attempt().state).toBe("needs_review");
      expect(test.resolveFresh).not.toHaveBeenCalled();
      expect(test.sendFollowerGate).not.toHaveBeenCalled();
      expect(test.sendFollowLag).not.toHaveBeenCalled();
      expect(test.startGuideDelivery).not.toHaveBeenCalled();
      const operatorEvidence = JSON.stringify(test.logger.error.mock.calls);
      expect(operatorEvidence).not.toContain("private lost acknowledgement");
      expect(operatorEvidence).not.toContain(
        action === "request" ? REQUEST_TOKEN_ID : FOLLOW_TOKEN_1,
      );
    },
  );

  it.each([
    { name: "initial request", initial: attempt() },
    {
      name: "follow recheck",
      initial: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
    },
  ])(
    "reconciles a committed direct-inbound claim for an $name without external work",
    async ({ initial }) => {
      const test = createHarness({
        initialAttempt: initial,
        repositoryAmbiguities: {
          claimDirectInbound: [new Error("private lost acknowledgement")],
        },
      });
      const conversation = {
        id: CONVERSATION_ID,
        igUserId: SENDER_ID,
        resourceId: RESOURCE_ID,
        guideName: "toddler sleep guide",
      };
      const inbound = {
        id: DIRECT_INBOUND_ID,
        threadId: THREAD_ID,
        eventAt: EVENT_AT,
        messagingWindowExpiresAt: WINDOW_END,
      };

      await expect(
        test.service.startDirectDmGuideRequest(conversation, inbound),
      ).resolves.toBe("access_attempt_needs_review");
      await expect(
        test.service.startDirectDmGuideRequest(conversation, inbound),
      ).resolves.toBe("action_replayed");

      expect(test.attempt().state).toBe("needs_review");
      expect(test.resolveFresh).not.toHaveBeenCalled();
      expect(test.sendFollowerGate).not.toHaveBeenCalled();
      expect(test.sendFollowLag).not.toHaveBeenCalled();
      expect(test.startGuideDelivery).not.toHaveBeenCalled();
    },
  );

  it("reconciles a committed awaiting-follow transition after one gate send", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      repositoryAmbiguities: {
        markAwaitingFollow: [new Error("private lost acknowledgement")],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendFollowerGate).toHaveBeenCalledOnce();
    expect(test.resolveFresh).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("reconciles a committed delivering claim without starting durable delivery", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      repositoryAmbiguities: {
        markDelivering: [new Error("private lost acknowledgement")],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    await expect(request(test)).resolves.toBe("action_replayed");

    expect(test.attempt().state).toBe("needs_review");
    expect(test.resolveFresh).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("safely recognizes delivered when completion commits before acknowledgement loss", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      deliveryResults: ["completed"],
      repositoryAmbiguities: {
        markDelivered: [new Error("private lost acknowledgement")],
      },
    });

    await expect(request(test)).resolves.toBe("guide_delivery_already_started");

    expect(test.attempt().state).toBe("delivered");
    expect(test.startGuideDelivery).toHaveBeenCalledOnce();
    expect(test.repository.markNeedsReview).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "delivering",
      checkedAt: NOW,
    });
  });

  it("contains a committed token replacement acknowledgement loss in review", async () => {
    const test = createHarness({
      freshResults: [live(false), live(false)],
      repositoryAmbiguities: {
        replaceToken: [new Error("private lost acknowledgement")],
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("contains a committed response reservation acknowledgement loss in review", async () => {
    const test = createHarness({ freshResults: [live(false), live(false)] });
    await expect(request(test)).resolves.toBe("follow_not_confirmed");
    test.repository.reserveFollowResponse.mockImplementationOnce(async () => {
      const current = test.attempt();
      Object.assign(current, { followResponseCount: current.followResponseCount + 1 });
      throw new Error("private lost acknowledgement");
    });

    await expect(check(test, FOLLOW_TOKEN_1)).resolves.toBe(
      "access_attempt_needs_review",
    );

    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendFollowLag).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("recognizes needs-review when its checkpoint commits before acknowledgement loss", async () => {
    const test = createHarness({
      freshResults: [unavailable],
      repositoryAmbiguities: {
        markNeedsReview: [new Error("private lost acknowledgement")],
      },
    });

    await expect(request(test)).resolves.toBe("follow_check_unavailable");

    expect(test.attempt().state).toBe("needs_review");
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("emits allowlisted evidence when neither ambiguous state can be checkpointed", async () => {
    const test = createHarness({
      freshResults: [live(true)],
      repositoryAmbiguities: {
        markDelivering: [new Error("private transition acknowledgement")],
      },
      markNeedsReviewResults: [
        { kind: "state_conflict", actualState: "delivering" },
        { kind: "state_conflict", actualState: "awaiting_follow" },
      ],
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith(
      {
        errorCode: "guide_access_review_checkpoint_failed",
        stage: "delivering_claim_failed",
        attemptId: ATTEMPT_ID,
      },
      "Guide access review checkpoint failed",
    );
    const operatorEvidence = JSON.stringify(test.logger.error.mock.calls);
    expect(operatorEvidence).not.toContain("private transition acknowledgement");
    expect(operatorEvidence).not.toContain(REQUEST_TOKEN_ID);
    expect(operatorEvidence).not.toContain(INBOUND_ID);
  });
});

// Task 7: the comment path opens the journey and never authorizes. The fresh
// check belongs to the parent's later action, so nothing here may read follow
// state, and Meta's one-private-reply-per-comment rule is the hard constraint.
describe("comment guide request", () => {
  function comment(
    test: ReturnType<typeof createHarness>,
    overrides: { commentId?: string; windowExpiresAt?: Date } = {},
  ) {
    return commentFull(test, overrides).then((result) => result.outcome);
  }

  function commentFull(
    test: ReturnType<typeof createHarness>,
    overrides: { commentId?: string; windowExpiresAt?: Date } = {},
  ) {
    return test.service.startCommentGuideRequest({
      conversationId: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      commentId: overrides.commentId ?? COMMENT_ID,
      observedAt: EVENT_AT,
      ...(overrides.windowExpiresAt
        ? { messagingWindowExpiresAt: overrides.windowExpiresAt }
        : {}),
    });
  }

  it("issues one request_guide token and sends exactly one opening", async () => {
    const test = createHarness({});

    await expect(comment(test)).resolves.toBe("guide_opening_sent");

    expect(test.repository.issueToken).toHaveBeenCalledTimes(1);
    expect(test.repository.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: ATTEMPT_ID, action: "request_guide" }),
    );
    expect(test.sendInitialPrivateReply).toHaveBeenCalledTimes(1);
    expect(test.sendInitialPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: COMMENT_ID,
        guideName: "toddler sleep guide",
        actionToken: REQUEST_TOKEN_ID,
      }),
    );
    expect(test.order).toEqual([
      "issue:request_guide",
      "external:opening",
    ]);
  });

  it("never reads follow state while opening the journey", async () => {
    const test = createHarness({});

    await comment(test);

    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.sendFollowLag).not.toHaveBeenCalled();
  });

  it("opening copy is identical for a cached follower and a cached non-follower", async () => {
    const asFollower = createHarness({ initialAttempt: attempt({ lastFollowResult: "follower" }) });
    const asNonFollower = createHarness({
      initialAttempt: attempt({ lastFollowResult: "non_follower" }),
    });

    await comment(asFollower);
    await comment(asNonFollower);

    expect(asFollower.sendInitialPrivateReply.mock.calls[0]?.[0]?.guideName).toBe(
      asNonFollower.sendInitialPrivateReply.mock.calls[0]?.[0]?.guideName,
    );
    expect(guideAccessOpening("toddler sleep guide")).toContain("toddler sleep guide");
  });

  it("a repeat comment on the same journey sends no second private reply", async () => {
    const test = createHarness({});

    await expect(comment(test)).resolves.toBe("guide_opening_sent");
    await expect(comment(test, { commentId: "comment-4002" })).resolves.toBe(
      "guide_opening_already_sent",
    );

    expect(test.sendInitialPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("passes text-only capabilities when the rich gate is off", async () => {
    const test = createHarness({ richCapabilities: TEXT_ONLY });

    await comment(test);

    expect(test.sendInitialPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: TEXT_ONLY }),
    );
  });

  it("passes rich capabilities only when the rich gate is on", async () => {
    const test = createHarness({ richCapabilities: RICH });

    await comment(test);

    expect(test.sendInitialPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: RICH }),
    );
  });

  it("a rejected opening never attempts a second private reply", async () => {
    const rejection = new AxiosError("rich private reply unsupported");
    const test = createHarness({
      richCapabilities: RICH,
      sendInitialPrivateReply: async () => {
        throw rejection;
      },
    });

    await expect(comment(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.sendInitialPrivateReply).toHaveBeenCalledTimes(1);
    expect(test.sendText).not.toHaveBeenCalled();
  });

  // Honest scope: this covers a CALLER-SUPPLIED closed window only. Neither
  // production caller can currently reach it, because both derive the window from
  // `observedAt` (= now). It is not what protects the current callers — the
  // repository already fences the window at `issueToken` (which also marks the
  // attempt expired) and at `claimDirectInbound`. So the deferred Task 3 minor is
  // moot for these callers rather than closed by this guard.
  it("sends nothing when a caller supplies an already-closed messaging window", async () => {
    const test = createHarness({});

    await expect(
      comment(test, { windowExpiresAt: new Date(NOW.getTime() - 1) }),
    ).resolves.toBe("action_expired");

    expect(test.repository.createOrLoadAttempt).not.toHaveBeenCalled();
    expect(test.repository.issueToken).not.toHaveBeenCalled();
    expect(test.sendInitialPrivateReply).not.toHaveBeenCalled();
  });

  it.each([
    { state: "checking_follow" as const, want: "action_replayed" },
    { state: "awaiting_follow" as const, want: "action_replayed" },
    { state: "delivering" as const, want: "guide_delivery_already_started" },
    { state: "delivered" as const, want: "guide_delivery_already_started" },
    { state: "needs_review" as const, want: "access_attempt_needs_review" },
    { state: "expired" as const, want: "action_expired" },
  ])("sends no opening for an attempt already in $state", async ({ state, want }) => {
    const test = createHarness({ initialAttempt: attempt({ state }) });

    await expect(comment(test)).resolves.toBe(want);

    expect(test.sendInitialPrivateReply).not.toHaveBeenCalled();
    expect(test.repository.issueToken).not.toHaveBeenCalled();
  });

  it("records a definitely rejected opening without leaking comment id, token, or copy", async () => {
    const rejected = new AxiosError(
      "private payload",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 400,
        statusText: "Bad Request",
        headers: {},
        config: { headers: {} } as never,
        data: { error: { code: 100, fbtrace_id: "safe_trace_opening" } },
      },
    );
    const test = createHarness({
      sendInitialPrivateReply: async () => {
        throw rejected;
      },
    });

    await expect(comment(test)).resolves.toBe("guide_opening_failed");

    // A definite rejection never reached the parent, so the attempt stays
    // openable rather than being escalated as an ambiguous send.
    expect(test.attempt().state).toBe("awaiting_request");
    expect(test.logger.error).toHaveBeenCalled();
    const evidence = JSON.stringify(test.logger.error.mock.calls);
    expect(evidence).not.toContain(COMMENT_ID);
    expect(evidence).not.toContain(REQUEST_TOKEN_ID);
    expect(evidence).not.toContain("toddler sleep guide");
  });
});

// Fix round 1, Critical 1. `handleUnavailable` tells the parent "Please try again
// a little later", but `needs_review` is an ACTIVE_ATTEMPT_STATE, so their retry
// loaded the same attempt and was discarded with nothing sent — for the whole 24h
// window, with no sweeper (markExpired has no caller). A review reached WITHOUT a
// definitive follow answer must stay retryable, bounded by MAX_FOLLOW_CHECKS. A
// review reached WITH one (the lag limit) stays terminal on purpose.
describe("retry after an inconclusive review", () => {
  function direct(test: ReturnType<typeof createHarness>, inboundId: string = DIRECT_INBOUND_ID) {
    return test.service.startDirectDmGuideRequest(
      {
        id: CONVERSATION_ID,
        igUserId: SENDER_ID,
        resourceId: RESOURCE_ID,
        guideName: "toddler sleep guide",
      },
      { id: inboundId, threadId: THREAD_ID, eventAt: EVENT_AT },
    );
  }

  it("re-checks when the review followed an unavailable check", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "needs_review", lastFollowResult: "unknown" }),
      freshResults: [live(true)],
    });

    await expect(direct(test)).resolves.toBe("guide_delivery_started");

    expect(test.resolveFresh).toHaveBeenCalledTimes(1);
    expect(test.startGuideDelivery).toHaveBeenCalledTimes(1);
  });

  it("still gates a retry that comes back a confirmed non-follower", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "needs_review", lastFollowResult: "unknown" }),
      freshResults: [live(false)],
    });

    await expect(direct(test)).resolves.toBe("follow_not_confirmed");

    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });

  it("keeps a lag-limit review terminal and sends nothing", async () => {
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "non_follower",
        followResponseCount: 2,
      }),
    });

    await expect(direct(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.sendFollowLag).not.toHaveBeenCalled();
  });

  it("keeps a review terminal once a follow was definitively confirmed", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "needs_review", lastFollowResult: "follower" }),
    });

    await expect(direct(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("stops retrying once the bounded check limit is reached", async () => {
    // Drives the real bound through the harness fence rather than stubbing the
    // return value: three checks are already spent, so no Graph call may happen.
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        followCheckCount: MAX_FOLLOW_CHECKS,
      }),
    });

    await expect(direct(test)).resolves.toBe("access_attempt_needs_review");

    expect(test.resolveFresh).not.toHaveBeenCalled();
    expect(test.startGuideDelivery).not.toHaveBeenCalled();
  });

  it("two distinct retry webhooks re-check only once", async () => {
    // Distinct inbound ids on purpose. Reusing one id would exit at the earlier
    // replay guard and never exercise the new fence at all.
    const test = createHarness({
      initialAttempt: attempt({ state: "needs_review", lastFollowResult: "unknown" }),
      freshResults: [live(true)],
    });

    await expect(direct(test, DIRECT_INBOUND_ID)).resolves.toBe("guide_delivery_started");
    // The second webhook is a genuinely different message, so it passes the replay
    // guard and reaches the state check — which now reads `delivered`.
    await expect(direct(test, INBOUND_ID)).resolves.toBe("guide_delivery_already_started");

    expect(test.repository.claimDirectInbound).toHaveBeenCalledTimes(1);
    expect(test.resolveFresh).toHaveBeenCalledTimes(1);
    expect(test.startGuideDelivery).toHaveBeenCalledTimes(1);
  });

  it("keeps the gentle lag copy and its budget once a follow was already asked for", async () => {
    // An awaiting_follow attempt whose lag send came back uncertain lands in
    // needs_review with lastFollowResult still "unknown". Its retry must not be
    // treated as a first contact: that would send the initial gate copy and skip
    // reserveFollowResponse, escaping the two-response limit.
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        followResponseCount: 1,
      }),
      freshResults: [live(false)],
    });

    await expect(direct(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendFollowLag).toHaveBeenCalledTimes(1);
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.repository.reserveFollowResponse).toHaveBeenCalledTimes(1);
  });

  it("still sends the first-contact gate when no follow was asked for yet", async () => {
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        followResponseCount: 0,
      }),
      freshResults: [live(false)],
    });

    await expect(direct(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    expect(test.sendFollowLag).not.toHaveBeenCalled();
  });
});

// Task 9. A failed opening was a permanent silent drop: 15.3% of comment openings
// fail in production (1,358 of 8,904 over 60 days), and V2 only logged. The caller
// needs the send error and the exact retry copy so it can run the same recovery
// ladder V1 uses — queueing the STRICT opening, never V1 gate copy.
describe("failed opening surfaces recovery evidence", () => {
  function commentAgain(test: ReturnType<typeof createHarness>) {
    return test.service.startCommentGuideRequest({
      conversationId: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      commentId: COMMENT_ID,
      observedAt: EVENT_AT,
    });
  }

  const definiteRejection = new AxiosError(
    "private payload",
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: {} } as never,
      data: { error: { code: 100, fbtrace_id: "safe_trace_recovery" } },
    },
  );

  it("returns the send error and the text retry copy on a definite failure", async () => {
    const test = createHarness({
      sendInitialPrivateReply: async () => {
        throw definiteRejection;
      },
    });

    const result = await commentAgain(test);

    expect(result.outcome).toBe("guide_opening_failed");
    expect(result.openingSendFailure?.error).toBe(definiteRejection);
    // Always the text variant: a queued retry carries no control, whatever mode
    // the original attempt used.
    expect(result.openingSendFailure?.retryText).toBe(
      guideAccessOpeningText("toddler sleep guide"),
    );
  });

  it("surfaces the same evidence for an uncertain send, which still needs review", async () => {
    const ambiguous = new AxiosError("private payload", "ETIMEDOUT");
    const test = createHarness({
      sendInitialPrivateReply: async () => {
        throw ambiguous;
      },
    });

    const result = await commentAgain(test);

    expect(result.outcome).toBe("access_attempt_needs_review");
    expect(result.openingSendFailure?.error).toBe(ambiguous);
  });

  it("still passes rich capabilities to the sender while retry copy stays text", async () => {
    const test = createHarness({
      richCapabilities: RICH,
      sendInitialPrivateReply: async () => {
        throw definiteRejection;
      },
    });

    const result = await commentAgain(test);

    expect(test.sendInitialPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: RICH }),
    );
    expect(result.openingSendFailure?.retryText).toBe(
      guideAccessOpeningText("toddler sleep guide"),
    );
  });

  it("reports no send failure when the opening succeeded", async () => {
    const test = createHarness({});

    const result = await commentAgain(test);

    expect(result.outcome).toBe("guide_opening_sent");
    expect(result.openingSendFailure).toBeUndefined();
  });

  it.each([
    { label: "a closed window", build: () => createHarness({}), want: "action_expired" },
    {
      label: "an attempt already past its opening",
      build: () => createHarness({ initialAttempt: attempt({ state: "delivering" }) }),
      want: "guide_delivery_already_started",
    },
  ])(
    "reports no send failure when nothing was sent for $label",
    async ({ label, build, want }) => {
      const test = build();
      const result =
        label === "a closed window"
          ? await test.service.startCommentGuideRequest({
              conversationId: CONVERSATION_ID,
              igUserId: SENDER_ID,
              resourceId: RESOURCE_ID,
              commentId: COMMENT_ID,
              observedAt: EVENT_AT,
              messagingWindowExpiresAt: new Date(NOW.getTime() - 1),
            })
          : await commentAgain(test);

      // Assert the outcome too: without it, a regression that actually sent the
      // opening would still satisfy the undefined-failure expectation.
      expect(result.outcome).toBe(want);
      expect(test.sendInitialPrivateReply).not.toHaveBeenCalled();
      expect(result.openingSendFailure).toBeUndefined();
    },
  );
});

// Fix round 1 for Task 9. `sendMetaMessage` returns `{ messageId: null }` WITHOUT
// throwing when Meta answers 2xx with no `message_id`. `sendAfterFence` then falls
// through to needs_review, so a catch-only failure report skipped the recovery ladder
// entirely — the one uncertain class producing zero evidence, and invisible to the
// `dm_failed` baseline the task calibrates against.
describe("opening with no provider message id", () => {
  function commentOnce(test: ReturnType<typeof createHarness>) {
    return test.service.startCommentGuideRequest({
      conversationId: CONVERSATION_ID,
      igUserId: SENDER_ID,
      resourceId: RESOURCE_ID,
      commentId: COMMENT_ID,
      observedAt: EVENT_AT,
    });
  }

  it("reports recovery evidence when Meta acknowledges without a message id", async () => {
    const test = createHarness({
      sendInitialPrivateReply: async () => ({ messageId: null }),
    });

    const result = await commentOnce(test);

    expect(result.outcome).toBe("access_attempt_needs_review");
    expect(result.openingSendFailure).toBeDefined();
    expect(result.openingSendFailure?.retryText).toBe(
      guideAccessOpeningText("toddler sleep guide"),
    );
  });

  it("reports nothing when Meta returns a real message id", async () => {
    const test = createHarness({
      sendInitialPrivateReply: async () => ({ messageId: "mid-real" }),
    });

    const result = await commentOnce(test);

    expect(result.outcome).toBe("guide_opening_sent");
    expect(result.openingSendFailure).toBeUndefined();
  });

  it("keeps recovery evidence intact when the guide name cannot form reviewed copy", async () => {
    // `guideAccessOpeningText` throws above 56 characters. Computing it inside the
    // catch would replace the provider error and skip the ladder, so it must be
    // resolved before the send is attempted.
    const test = createHarness({
      loadGuideName: async () => "g".repeat(57),
      sendInitialPrivateReply: async () => ({ messageId: null }),
    });

    await expect(commentOnce(test)).rejects.toThrow("invalid_guide_access_copy");
    // Nothing was sent, so no opening escaped with unreviewed copy.
    expect(test.sendInitialPrivateReply).not.toHaveBeenCalled();
  });
});

// Parent-delivery Task 4. A confirmed non-follower sees the cover in the gate. The
// exposure is claimed pessimistically BEFORE the send (not_shown -> uncertain), then
// settled, so a crash or duplicate action can never re-expose it. Only `accepted` lets a
// later delivery skip the cover.
describe("gate cover exposure", () => {
  const COVER = {
    versionId: "b0000000-0000-4000-8000-00000000000b",
    resourceId: RESOURCE_ID,
    dmStoragePath: "guide-cover/sleep/dm.png",
  };

  function gateHarness(over: Parameters<typeof createHarness>[0] = {}) {
    return createHarness({
      initialAttempt: attempt({ coverVersionId: COVER.versionId }),
      freshResults: [live(false)],
      coverSnapshot: COVER,
      ...over,
    });
  }

  it("sends the cover before the gate and settles the exposure as accepted", async () => {
    const test = gateHarness();

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.coverMediaUrl).toHaveBeenCalledWith(COVER.dmStoragePath);
    expect(test.sendCover).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: SENDER_ID,
        mediaUrl: `https://cdn.example.test/${COVER.dmStoragePath}`,
      }),
    );
    // Claim, send, settle — in that order — and the gate copy still follows, so the
    // image is never the only source of what the parent has to do.
    expect(test.order).toEqual(
      expect.arrayContaining(["claim:cover_exposure", "external:cover", "settle:cover_accepted"]),
    );
    expect(test.order.indexOf("claim:cover_exposure")).toBeLessThan(
      test.order.indexOf("external:cover"),
    );
    expect(test.order.indexOf("external:cover")).toBeLessThan(
      test.order.indexOf("external:gate"),
    );
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    expect(test.attempt().coverExposure).toBe("accepted");
    expect(test.attempt().coverProviderMessageId).toBe("cover-mid");
  });

  it("settles a definitely rejected cover as failed and still sends the gate", async () => {
    const rejected = new AxiosError("cover", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: {} } as never,
      data: { error: { code: 100, fbtrace_id: "safe_cover" } },
    });
    const test = gateHarness({
      sendCover: async () => {
        throw rejected;
      },
    });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.attempt().coverExposure).toBe("failed");
    // A cover that provably never arrived must not stop the parent learning what to do.
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });

  it("leaves an ambiguous cover uncertain, sends no gate, and asks for review", async () => {
    const test = gateHarness({
      sendCover: async () => {
        throw new AxiosError("cover", "ETIMEDOUT");
      },
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    // Meta may have accepted it, so it is never repeated and a human looks.
    expect(test.attempt().coverExposure).toBe("uncertain");
    expect(test.sendCover).toHaveBeenCalledTimes(1);
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
  });

  it.each([
    { exposure: "accepted" as const },
    { exposure: "uncertain" as const },
    { exposure: "failed" as const },
  ])("never re-exposes a cover already claimed as $exposure", async ({ exposure }) => {
    const test = gateHarness({ exposureAlready: exposure });

    await request(test);

    expect(test.sendCover).not.toHaveBeenCalled();
  });

  it("shows no cover on the follow-lag response", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", coverVersionId: COVER.versionId }),
      freshResults: [live(false)],
      coverSnapshot: COVER,
    });

    await check(test, FOLLOW_TOKEN_1);

    // The lag response is a nudge, not a first impression; the cover belongs to the gate.
    expect(test.sendCover).not.toHaveBeenCalled();
    expect(test.repository.claimCoverExposure).not.toHaveBeenCalled();
  });

  it("sends the gate normally when the attempt snapshotted no cover", async () => {
    const test = createHarness({
      initialAttempt: attempt({ coverVersionId: null }),
      freshResults: [live(false)],
    });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendCover).not.toHaveBeenCalled();
    expect(test.repository.claimCoverExposure).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });

  it("refuses a snapshot belonging to a different guide and still sends the gate", async () => {
    const test = gateHarness({
      coverSnapshot: { ...COVER, resourceId: "99999999-9999-4999-8999-999999999999" },
    });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendCover).not.toHaveBeenCalled();
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    // Assert the reason, so this cannot pass merely because the feature is absent.
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "cover_resource_mismatch" }),
      expect.any(String),
    );
    expect(test.repository.claimCoverExposure).not.toHaveBeenCalled();
  });
});

// Parent-delivery Task 4, producer half. This is the only place `coverAlreadyShown` is
// ever set, and `accepted` is the only exposure that sets it. Without this the planner's
// omit-the-cover branch is unreachable and a parent who saw the cover in the gate would
// receive it again after confirming the follow.
describe("cover exposure feeds the durable plan", () => {
  const COVER = {
    versionId: "b0000000-0000-4000-8000-00000000000b",
    resourceId: RESOURCE_ID,
    dmStoragePath: "guide-cover/sleep/dm.png",
  };

  function followerHarness(coverExposure: GuideAccessAttempt["coverExposure"]) {
    return createHarness({
      initialAttempt: attempt({ coverVersionId: COVER.versionId, coverExposure }),
      freshResults: [live(true)],
      coverSnapshot: COVER,
    });
  }

  it("passes the snapshot so the planner can prepend it", async () => {
    const test = followerHarness("not_shown");

    await expect(request(test)).resolves.toBe("guide_delivery_started");

    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        cover: COVER,
        resourceId: RESOURCE_ID,
      }),
    );
  });

  it("marks the cover already shown when the gate exposure was accepted", async () => {
    const test = followerHarness("accepted");

    await request(test);

    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ coverAlreadyShown: true }),
    );
  });

  it("suppresses the cover after an UNCERTAIN gate exposure", async () => {
    const test = followerHarness("uncertain");

    await request(test);

    // Meta may well have accepted the uncertain send, and the spec forbids ever repeating
    // it automatically. An uncertain gate is also re-enterable, because the review keeps
    // `lastFollowResult: "unknown"` — so without this the parent's next reply plus a fresh
    // `true` would deliver a SECOND copy of an image they may already hold.
    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ coverAlreadyShown: true }),
    );
  });

  it.each([
    { coverExposure: "not_shown" as const },
    { coverExposure: "failed" as const },
  ])("still owes the cover for $coverExposure", async ({ coverExposure }) => {
    const test = followerHarness(coverExposure);

    await request(test);

    // `failed` provably never arrived, so the cover is still owed. `not_shown` was never
    // attempted. Only a send that MIGHT have landed suppresses.
    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.not.objectContaining({ coverAlreadyShown: true }),
    );
  });

  it("passes no cover when the attempt snapshotted none", async () => {
    const test = createHarness({
      initialAttempt: attempt({ coverVersionId: null }),
      freshResults: [live(true)],
    });

    await request(test);

    expect(test.startGuideDelivery).toHaveBeenCalledWith(
      expect.not.objectContaining({ cover: expect.anything() }),
    );
  });
});

// Parent-delivery Task 7. Aggregate-only: the recorder receives a stage and an outcome and
// nothing else — no attempt id, no token, no URL, no copy.
describe("cover exposure measurement", () => {
  const COVER = {
    versionId: "b0000000-0000-4000-8000-00000000000b",
    resourceId: RESOURCE_ID,
    dmStoragePath: "guide-cover/sleep/dm.png",
  };

  function gateHarness(over: Parameters<typeof createHarness>[0] = {}) {
    return createHarness({
      initialAttempt: attempt({ coverVersionId: COVER.versionId }),
      freshResults: [live(false)],
      coverSnapshot: COVER,
      ...over,
    });
  }

  it("records an accepted exposure and nothing identifying", async () => {
    const test = gateHarness();

    await request(test);

    expect(test.recordCoverMetric).toHaveBeenCalledWith("accepted");
    const recorded = JSON.stringify(test.recordCoverMetric.mock.calls);
    for (const secret of [ATTEMPT_ID, SENDER_ID, COVER.versionId, COVER.dmStoragePath]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it("records an uncertain exposure", async () => {
    const test = gateHarness({
      sendCover: async () => {
        throw new AxiosError("cover", "ETIMEDOUT");
      },
    });

    await request(test);

    expect(test.recordCoverMetric).toHaveBeenCalledWith("uncertain");
  });

  it("records a definitely failed exposure", async () => {
    const test = gateHarness({
      sendCover: async () => {
        throw new AxiosError("cover", "ERR_BAD_REQUEST", undefined, undefined, {
          status: 400,
          statusText: "Bad Request",
          headers: {},
          config: { headers: {} } as never,
          data: { error: { code: 100, fbtrace_id: "safe" } },
        });
      },
    });

    await request(test);

    expect(test.recordCoverMetric).toHaveBeenCalledWith("failed");
  });

  it("never lets a failed counter break the parent-facing outcome", async () => {
    const test = gateHarness();
    test.recordCoverMetric.mockRejectedValue(new Error("metrics down"));

    // Measurement is not worth losing an exposure over.
    await expect(request(test)).resolves.toBe("follow_not_confirmed");
    expect(test.attempt().coverExposure).toBe("accepted");
  });

  it("records nothing when no cover was exposed", async () => {
    const test = createHarness({
      initialAttempt: attempt({ coverVersionId: null }),
      freshResults: [live(false)],
    });

    await request(test);

    expect(test.recordCoverMetric).not.toHaveBeenCalled();
  });
});

// Review round 2, Critical. The gate sends its cover image DIRECTLY to a non-follower, and
// it never consulted the cover rollout switch. So publishing a cover in the creator console
// put an image in front of a real parent with `GUIDE_COVER_DELIVERY_ENABLED=false` — through
// a console-enableable switch whose own description promises it does not message parents.
describe("gate cover respects the rollout fence", () => {
  const FENCED_COVER = {
    versionId: "c0000000-0000-4000-8000-00000000000c",
    resourceId: RESOURCE_ID,
    dmStoragePath: "guide-cover/fenced/dm.png",
  };

  function fencedHarness(over: Parameters<typeof createHarness>[0] = {}) {
    return createHarness({
      initialAttempt: attempt({ coverVersionId: FENCED_COVER.versionId }),
      freshResults: [live(false)],
      coverSnapshot: FENCED_COVER,
      ...over,
    });
  }

  it("sends no cover image while the cover rollout is closed", async () => {
    const test = fencedHarness({ coverDecision: "omit" });

    await expect(request(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendCover).not.toHaveBeenCalled();
    // Not even a URL is resolved for an image nobody will receive.
    expect(test.coverMediaUrl).not.toHaveBeenCalled();
    // The gate itself still goes out. Withholding the image is not withholding the gate.
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    expect(test.recordCoverMetric).toHaveBeenCalledWith("omitted_not_selected");
  });

  it("leaves the exposure unclaimed so a later opened rollout can still send it", async () => {
    const test = fencedHarness({ coverDecision: "omit" });

    await request(test);

    // Claiming would settle the attempt's exposure and permanently suppress a cover the
    // parent never saw.
    expect(test.attempt().coverExposure).toBe("not_shown");
    expect(test.order).not.toContain("claim:cover_exposure");
  });

  it("sends the cover when the rollout selects this guide", async () => {
    const test = fencedHarness({ coverDecision: "include" });

    await request(test);

    expect(test.sendCover).toHaveBeenCalledTimes(1);
    expect(test.recordCoverMetric).toHaveBeenCalledWith("accepted");
  });

  it("counts a gate cover the provider acknowledged without a message id", async () => {
    // Previously this returned `needs_review` without recording anything, so the one class
    // the runbook tells an operator to watch was the class that went uncounted.
    const test = fencedHarness({
      coverDecision: "include",
      sendCover: async () => ({ messageId: null }),
    });

    await request(test);

    expect(test.recordCoverMetric).toHaveBeenCalledWith("uncertain");
  });

  it("reports a mispaired cover even while the rollout is closed", async () => {
    const test = fencedHarness({
      coverDecision: "omit",
      coverSnapshot: { ...FENCED_COVER, resourceId: "99999999-9999-4999-8999-999999999999" },
    });

    await request(test);

    // Integrity before policy, same ordering as the delivery side. A pairing fault is a
    // fault whether or not this send would have carried the image.
    expect(test.recordCoverMetric).toHaveBeenCalledWith("omitted_mismatch");
    expect(test.sendCover).not.toHaveBeenCalled();
  });
});

// Review round 2, Critical. A duplicate gate DM to a real parent.
//
// An uncertain gate send parks the attempt in `needs_review` from `checking_follow`, and
// `markNeedsReview` writes only the state — it never persists the follow result. So the
// attempt keeps `lastFollowResult: "unknown"` even though the check WAS definite, which
// makes `isRetryableReview` true. The parent's next ordinary DM then re-enters, finds
// `followResponseCount` still 0, picks the `gate` branch again, and sends a second gate
// that Meta may well have already delivered. Bounded at three by MAX_FOLLOW_CHECKS.
//
// This is also a regression against V1, where an uncertain gate reply is parked as
// `send_uncertain` and never retried automatically.
describe("an uncertain gate send is never repeated", () => {
  function directRequest(
    test: ReturnType<typeof createHarness>,
    inboundId = "70000000-0000-4000-8000-000000000070",
  ) {
    return test.service.startDirectDmGuideRequest(
      {
        id: CONVERSATION_ID,
        igUserId: SENDER_ID,
        resourceId: RESOURCE_ID,
        guideName: "toddler sleep guide",
      },
      { id: inboundId, threadId: THREAD_ID, eventAt: EVENT_AT },
    );
  }

  it("does not send a second gate after the first one's outcome was uncertain", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_request" }),
      freshResults: [live(false), live(false)],
      // Acknowledged with no message id: Meta may or may not have delivered it.
      sendGate: async () => ({ messageId: null }),
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);

    // The parent's next ordinary message. Nothing here is authorization; the question is
    // only whether the gate goes out a second time.
    await directRequest(test);

    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });

  it("records the definite follow answer on the review, so re-entry is refused", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_request" }),
      freshResults: [live(false)],
      sendGate: async () => ({ messageId: null }),
    });

    await request(test);

    // The check said non-follower. Parking that as `unknown` claims we never found out,
    // which is what made the review re-enterable.
    expect(test.attempt()).toMatchObject({
      state: "needs_review",
      lastFollowResult: "non_follower",
    });
  });

  it("still re-checks a review that followed an UNAVAILABLE check", async () => {
    // The intended retryable case, unchanged: nothing gate-like reached the parent, so
    // their next message must be able to try again.
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        followResponseCount: 0,
      }),
      freshResults: [live(false)],
    });

    await expect(directRequest(test)).resolves.toBe("follow_not_confirmed");

    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });
});

// The `gate` and `recheck` metric stages were declared in the vocabulary, admitted by the
// aggregate SQL, and written by NOTHING. Both read zero forever on the page an operator uses
// to decide whether to widen the rollout — and a zero there is indistinguishable from "the
// pilot has not started". `recheck` mattered most: its outcomes were folded into
// `fresh_check`, so the funnel could not separate "failed the first follow check" from
// "still not following after telling us they had", which is the whole point of a follow gate.
describe("follow-check and gate measurement", () => {
  it("counts a first-time check as a fresh check, never as a recheck", async () => {
    const test = createHarness({ freshResults: [live(true)] });

    await request(test);

    expect(test.recordFreshCheck).toHaveBeenCalledWith("follower");
    expect(test.recordRecheck).not.toHaveBeenCalled();
  });

  it("counts a check after the parent says they followed as a recheck", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      freshResults: [live(true)],
    });

    await check(test, FOLLOW_TOKEN_1);

    // `attempted` is the denominator; the outcome partitions it. Both are recorded so the
    // funnel still has a denominator if an outcome write is dropped.
    expect(test.recordRecheck).toHaveBeenCalledWith("attempted");
    expect(test.recordRecheck).toHaveBeenCalledWith("confirmed");
    // Not also counted as a first check, or the two would double-count each other.
    expect(test.recordFreshCheck).not.toHaveBeenCalled();
  });

  it("distinguishes a failed recheck from a failed first check", async () => {
    const first = createHarness({ freshResults: [live(false)] });
    await request(first);
    expect(first.recordFreshCheck).toHaveBeenCalledWith("non_follower");

    const again = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      freshResults: [live(false)],
    });
    await check(again, FOLLOW_TOKEN_1);

    // The number that actually matters: they told us they followed and Instagram disagrees.
    expect(again.recordRecheck).toHaveBeenCalledWith("not_confirmed");
    expect(again.recordFreshCheck).not.toHaveBeenCalled();
  });

  it("counts an unavailable check under whichever check ran", async () => {
    const first = createHarness({ freshResults: [unavailable] });
    await request(first);
    expect(first.recordFreshCheck).toHaveBeenCalledWith("unavailable");

    const again = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      freshResults: [unavailable],
    });
    await check(again, FOLLOW_TOKEN_1);
    expect(again.recordRecheck).toHaveBeenCalledWith("unavailable");
  });

  it("counts the gate only once it was actually sent", async () => {
    const test = createHarness({ freshResults: [live(false)] });

    await request(test);

    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    expect(test.recordGateShown).toHaveBeenCalledTimes(1);
  });

  it("does not count a gate whose send outcome was uncertain", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: async () => ({ messageId: null }),
    });

    await request(test);

    // Meta may or may not have delivered it. Counting it as shown would inflate the
    // denominator of every downstream gate conversion.
    expect(test.recordGateShown).not.toHaveBeenCalled();
  });

  it("does not count the follow-lag nudge as a gate", async () => {
    const test = createHarness({
      initialAttempt: attempt({ state: "awaiting_follow", lastFollowResult: "non_follower" }),
      freshResults: [live(false)],
    });

    await check(test, FOLLOW_TOKEN_1);

    expect(test.sendFollowLag).toHaveBeenCalledTimes(1);
    expect(test.recordGateShown).not.toHaveBeenCalled();
  });

  it("never fails a parent action because a counter failed", async () => {
    const test = createHarness({ freshResults: [live(false)] });
    test.recordFreshCheck.mockRejectedValue(new Error("metrics down"));
    test.recordGateShown.mockRejectedValue(new Error("metrics down"));

    await expect(request(test)).resolves.toBe("follow_not_confirmed");
  });
});

// Review round 3, Critical. The previous round marked EVERY review inside
// `handleNonFollower` terminal by recording the definite follow answer. That is right only
// where something gate-like provably reached the parent. On three of the five sites nothing
// had — and the worst of those hands a parent a cover image with no instructions and then
// refuses them for the rest of their messaging window.
describe("a review is terminal only when the parent was actually told something", () => {
  const COVER = {
    versionId: "d0000000-0000-4000-8000-00000000000d",
    resourceId: RESOURCE_ID,
    dmStoragePath: "guide-cover/wedge/dm.png",
  };

  it("keeps an uncertain COVER send re-enterable, because the gate copy never went out", async () => {
    const test = createHarness({
      initialAttempt: attempt({ coverVersionId: COVER.versionId }),
      freshResults: [live(false)],
      coverSnapshot: COVER,
      // Acknowledged with no message id: the image may have arrived, the instructions did not.
      sendCover: async () => ({ messageId: null }),
    });

    await expect(request(test)).resolves.toBe("access_attempt_needs_review");

    // Nothing that tells the parent what to do was sent, so this review must not be
    // terminal — otherwise they hold a bare picture and every later message is refused.
    expect(test.sendFollowerGate).not.toHaveBeenCalled();
    expect(test.attempt()).toMatchObject({
      state: "needs_review",
      lastFollowResult: "unknown",
    });
  });

  it("still delivers the gate copy on the parent's next message after that", async () => {
    const test = createHarness({
      initialAttempt: attempt({
        state: "needs_review",
        lastFollowResult: "unknown",
        coverVersionId: COVER.versionId,
      }),
      freshResults: [live(false)],
      coverSnapshot: COVER,
    });

    await test.service.startDirectDmGuideRequest(
      {
        id: CONVERSATION_ID,
        igUserId: SENDER_ID,
        resourceId: RESOURCE_ID,
        guideName: "toddler sleep guide",
      },
      { id: "80000000-0000-4000-8000-000000000080", threadId: THREAD_ID, eventAt: EVENT_AT },
    );

    // The cover exposure is already claimed, so no second image — but the instructions
    // finally arrive. That recovery is what the terminal marking took away.
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
  });

  it("keeps a DEFINITELY refused gate re-enterable when its bookkeeping then fails", async () => {
    const rejected = new AxiosError("private payload", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: { headers: {} } as never,
      data: { error: { code: 100, fbtrace_id: "safe_trace_wedge" } },
    });
    const test = createHarness({
      freshResults: [live(false)],
      sendGate: vi.fn().mockRejectedValue(rejected),
      repositoryFailures: { markAwaitingFollow: [new Error("checkpoint exploded")] },
    });

    await request(test);

    // Meta definitively refused the gate, so the parent holds nothing. Marking the
    // follow-up bookkeeping failure terminal would strand them over a message that
    // provably never arrived — the same fault as the cover case above.
    expect(test.attempt()).toMatchObject({
      state: "needs_review",
      lastFollowResult: "unknown",
    });
  });

  it("drives handleUnavailable and proves it records NO follow answer", async () => {
    // The existing test for this hand-builds a `needs_review`/`unknown` attempt, so it
    // proves the re-entry predicate and never runs the code that must preserve `unknown`.
    // Adding a follow answer at that checkpoint would wedge EVERY parent whose live check
    // was unavailable, right after telling them "Please try again a little later" — and it
    // passed the entire suite.
    const test = createHarness({ freshResults: [unavailable] });

    await expect(request(test)).resolves.toBe("follow_check_unavailable");

    expect(test.repository.markNeedsReview).toHaveBeenCalledWith(
      expect.not.objectContaining({ followResult: expect.anything() }),
    );
    expect(test.attempt()).toMatchObject({
      state: "needs_review",
      lastFollowResult: "unknown",
    });
    expect(test.sendText).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      text: "Unable to confirm right now. Please try again a little later.",
    });
  });

  it("marks the checkpoint terminal when the gate DID reach Meta", async () => {
    const test = createHarness({
      freshResults: [live(false)],
      repositoryFailures: { markAwaitingFollow: [new Error("checkpoint exploded")] },
    });

    await request(test);

    // The gate went out. Re-entry here would send a second one.
    expect(test.sendFollowerGate).toHaveBeenCalledTimes(1);
    expect(test.attempt().lastFollowResult).toBe("non_follower");
  });
});
