import type { GuideAccessAttempt, GuideActionToken } from "@prisma/client";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { guideAccessCopy } from "./guideAccessCopy.js";
import { createGuideAccessActionService } from "./guideAccessActionService.js";

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
  sendGate?: () => Promise<{ messageId: string | null }>;
  sendText?: (input: { recipientId: string; text: string }) => Promise<{ messageId: string | null }>;
  loadGuideName?: (resourceId: string) => Promise<string>;
  loadThreadId?: (inboundMessageId: string) => Promise<string | null>;
}) {
  let current = input.initialAttempt ?? attempt();
  let nextToken = 0;
  const followTokens = [FOLLOW_TOKEN_1, FOLLOW_TOKEN_2, FOLLOW_TOKEN_3];
  const consumed = new Set<string>();
  const tokenAttempt = new Map<string, string>([
    [REQUEST_TOKEN_ID, ATTEMPT_ID],
    ...followTokens.map((id) => [id, ATTEMPT_ID] as const),
  ]);
  const order: string[] = [];

  const repository = {
    createOrLoadAttempt: vi.fn(async () => {
      const kind = current.state === "awaiting_request" ? "created" : "loaded";
      return { kind, attempt: { ...current } } as const;
    }),
    consumeToken: vi.fn(async (request: { tokenId: string; action: string }) => {
      order.push(`consume:${request.action}`);
      const forced = input.consumeResults?.shift();
      if (forced) {
        if (forced.kind === "consumed") current = { ...forced.attempt };
        return forced;
      }
      if (consumed.has(request.tokenId)) return { kind: "already_consumed" } as const;
      consumed.add(request.tokenId);
      current = {
        ...current,
        state: "checking_follow",
        lastFollowResult: "unknown",
        lastFollowCheckedAt: null,
        followCheckCount: current.followCheckCount + 1,
      };
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
      if (current.state !== "checking_follow") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "awaiting_follow",
        lastFollowResult: "non_follower",
        lastFollowCheckedAt: NOW,
      };
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markDelivering: vi.fn(async () => {
      order.push("mark:delivering");
      if (current.state !== "checking_follow") {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = {
        ...current,
        state: "delivering",
        lastFollowResult: "follower",
        lastFollowCheckedAt: NOW,
      };
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    markNeedsReview: vi.fn(async (request: { expectedState: GuideAccessAttempt["state"] }) => {
      order.push("mark:needs_review");
      if (current.state !== request.expectedState) {
        return { kind: "state_conflict", actualState: current.state } as const;
      }
      current = { ...current, state: "needs_review" };
      return { kind: "transitioned", attempt: { ...current } } as const;
    }),
    issueToken: vi.fn(async () => {
      order.push("issue:check_follow");
      const id = followTokens[nextToken++]!;
      return { kind: "issued", token: actionToken(id, "check_follow") } as const;
    }),
    reserveFollowResponse: vi.fn(async () => {
      order.push("reserve:follow_response");
      if (current.followResponseCount >= 2) return { kind: "limit_reached" } as const;
      const responseNumber = (current.followResponseCount + 1) as 1 | 2;
      current = { ...current, followResponseCount: responseNumber };
      return { kind: "reserved", responseNumber } as const;
    }),
    markDelivered: vi.fn(),
    markExpired: vi.fn(),
  };

  const resolveFresh = vi.fn(async () => {
    order.push("external:verify");
    return input.freshResults?.shift() ?? live(true);
  });
  const startGuideDelivery = vi.fn(async () => {
    order.push("external:delivery");
    return input.deliveryResults?.shift() ?? "completed";
  });
  const sendFollowerGate = vi.fn(async () => {
    order.push("external:gate");
    return input.sendGate ? input.sendGate() : { messageId: "gate-mid" };
  });
  const sendText = vi.fn(async (message: { recipientId: string; text: string }) => {
    order.push(
      message.text === guideAccessCopy.followLag ? "external:lag" : "external:unavailable",
    );
    return input.sendText ? input.sendText(message) : { messageId: "text-mid" };
  });
  const loadGuideName = vi.fn(
    input.loadGuideName ?? (async () => "toddler sleep guide"),
  );
  const loadThreadId = vi.fn(input.loadThreadId ?? (async () => THREAD_ID));

  const service = createGuideAccessActionService({
    repository: repository as never,
    resolveFollowStatusFresh: resolveFresh,
    startGuideDelivery,
    sendFollowerGate,
    sendText,
    loadGuideName,
    loadThreadId,
    findAttemptIdByToken: vi.fn(async (tokenId: string) => tokenAttempt.get(tokenId) ?? null),
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
    loadGuideName,
    loadThreadId,
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

    expect(test.repository.issueToken).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      action: "check_follow",
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
      "mark:awaiting_follow",
      "issue:check_follow",
      "external:gate",
    ]);
  });

  it("withholds on unavailable, sends only neutral wording, and moves the attempt to review first", async () => {
    const test = createHarness({ freshResults: [unavailable] });

    await expect(request(test)).resolves.toBe("follow_check_unavailable");

    expect(test.sendText).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      text: guideAccessCopy.unavailable,
    });
    expect(test.repository.issueToken).not.toHaveBeenCalled();
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

    expect(test.sendText).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      text: guideAccessCopy.followLag,
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

    expect(test.sendText).toHaveBeenCalledTimes(2);
    expect(test.sendText).toHaveBeenNthCalledWith(1, {
      recipientId: SENDER_ID,
      text: guideAccessCopy.followLag,
    });
    expect(test.sendText).toHaveBeenNthCalledWith(2, {
      recipientId: SENDER_ID,
      text: guideAccessCopy.followLag,
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
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.sendText).toHaveBeenCalledWith({
      recipientId: SENDER_ID,
      text: guideAccessCopy.followLag,
    });
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
      expectedState: "awaiting_follow",
    });
    expect(test.attempt().state).toBe("needs_review");
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
