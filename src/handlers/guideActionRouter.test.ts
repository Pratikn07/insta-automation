import { describe, expect, it, vi } from "vitest";
import {
  GUIDE_ACTION_PAYLOAD,
  GUIDE_ACTION_TOKEN,
} from "../test/fixtures/metaGuideGateEvents.js";
import {
  createGuideActionRouter,
  parseGuideActionPayload,
} from "./guideActionRouter.js";

const SENDER_ID = "controlled-recipient";
const INBOUND_MESSAGE_ID = "d85f8707-a270-4b86-a85f-c91e366a52bd";
const EVENT_AT = new Date("2026-08-23T01:30:00.000Z");

function makeRouter(input: {
  action?: "request_guide" | "check_follow" | null;
  requestOutcome?: "guide_delivery_started" | "action_expired";
  checkOutcome?: "follow_not_confirmed" | "action_expired" | "action_replayed";
} = {}) {
  const loadAction = vi
    .fn()
    .mockResolvedValue(input.action === undefined ? "request_guide" : input.action);
  const requestGuideFromAction = vi
    .fn()
    .mockResolvedValue(input.requestOutcome ?? "guide_delivery_started");
  const checkFollowFromAction = vi
    .fn()
    .mockResolvedValue(input.checkOutcome ?? "follow_not_confirmed");
  const logger = { error: vi.fn() };
  const route = createGuideActionRouter({
    loadAction,
    requestGuideFromAction,
    checkFollowFromAction,
    logger,
  });

  return {
    route,
    loadAction,
    requestGuideFromAction,
    checkFollowFromAction,
    logger,
  };
}

describe("parseGuideActionPayload", () => {
  it("accepts only the exact guide prefix followed by a canonical UUID", () => {
    expect(parseGuideActionPayload(GUIDE_ACTION_PAYLOAD)).toEqual({
      tokenId: GUIDE_ACTION_TOKEN,
    });
  });

  it.each([
    undefined,
    null,
    "",
    GUIDE_ACTION_TOKEN,
    `other:guide:${GUIDE_ACTION_TOKEN}`,
    `ts:guide:${GUIDE_ACTION_TOKEN}:extra`,
    ` ts:guide:${GUIDE_ACTION_TOKEN}`,
    `ts:guide:${GUIDE_ACTION_TOKEN} `,
    "ts:guide:not-a-uuid",
    "ts:guide:3f05a5141f044b149df47730c7c39af4",
  ])("rejects malformed or unknown payload %j", (payload) => {
    expect(parseGuideActionPayload(payload)).toBeNull();
  });
});

describe("createGuideActionRouter", () => {
  it("loads the durable token action and routes request-guide once", async () => {
    const test = makeRouter({ action: "request_guide" });

    await expect(
      test.route({
        payload: GUIDE_ACTION_PAYLOAD,
        senderId: SENDER_ID,
        inboundMessageId: INBOUND_MESSAGE_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "handled", outcome: "guide_delivery_started" });

    expect(test.loadAction).toHaveBeenCalledOnce();
    expect(test.loadAction).toHaveBeenCalledWith(GUIDE_ACTION_TOKEN);
    expect(test.requestGuideFromAction).toHaveBeenCalledOnce();
    expect(test.requestGuideFromAction).toHaveBeenCalledWith(
      GUIDE_ACTION_TOKEN,
      SENDER_ID,
      INBOUND_MESSAGE_ID,
      EVENT_AT,
    );
    expect(test.checkFollowFromAction).not.toHaveBeenCalled();
  });

  it("routes check-follow once and uses the token UUID as a safe postback trigger", async () => {
    const test = makeRouter({ action: "check_follow" });

    await expect(
      test.route({
        payload: GUIDE_ACTION_PAYLOAD,
        senderId: SENDER_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "handled", outcome: "follow_not_confirmed" });

    expect(test.checkFollowFromAction).toHaveBeenCalledOnce();
    expect(test.checkFollowFromAction).toHaveBeenCalledWith(
      GUIDE_ACTION_TOKEN,
      SENDER_ID,
      GUIDE_ACTION_TOKEN,
      EVENT_AT,
    );
    expect(test.requestGuideFromAction).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong sender", "request_guide", "action_expired"],
    ["expired token", "check_follow", "action_expired"],
    ["replayed token", "check_follow", "action_replayed"],
  ] as const)("fails closed for a %s outcome", async (_label, action, outcome) => {
    const test = makeRouter({
      action,
      requestOutcome: outcome === "action_replayed" ? "action_expired" : outcome,
      checkOutcome: outcome,
    });

    await expect(
      test.route({
        payload: GUIDE_ACTION_PAYLOAD,
        senderId: SENDER_ID,
        inboundMessageId: INBOUND_MESSAGE_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "handled", outcome });

    expect(
      test.requestGuideFromAction.mock.calls.length +
        test.checkFollowFromAction.mock.calls.length,
    ).toBe(1);
  });

  it("acknowledges malformed and unknown-prefix payloads without a token lookup", async () => {
    const test = makeRouter();

    await expect(
      test.route({
        payload: `unregistered:action:${GUIDE_ACTION_TOKEN}`,
        senderId: SENDER_ID,
        inboundMessageId: INBOUND_MESSAGE_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "ignored" });

    expect(test.loadAction).not.toHaveBeenCalled();
    expect(test.requestGuideFromAction).not.toHaveBeenCalled();
    expect(test.checkFollowFromAction).not.toHaveBeenCalled();
  });

  it("fails closed when a canonical token is unknown", async () => {
    const test = makeRouter({ action: null });

    await expect(
      test.route({
        payload: GUIDE_ACTION_PAYLOAD,
        senderId: SENDER_ID,
        inboundMessageId: INBOUND_MESSAGE_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "handled", outcome: "action_expired" });

    expect(test.requestGuideFromAction).not.toHaveBeenCalled();
    expect(test.checkFollowFromAction).not.toHaveBeenCalled();
  });

  it("contains a token-action lookup failure without logging the opaque token", async () => {
    const test = makeRouter();
    test.loadAction.mockRejectedValue(new Error(`database failed ${GUIDE_ACTION_TOKEN}`));

    await expect(
      test.route({
        payload: GUIDE_ACTION_PAYLOAD,
        senderId: SENDER_ID,
        inboundMessageId: INBOUND_MESSAGE_ID,
        eventAt: EVENT_AT,
      }),
    ).resolves.toEqual({ kind: "handled", outcome: "access_attempt_needs_review" });

    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(GUIDE_ACTION_TOKEN);
    expect(test.requestGuideFromAction).not.toHaveBeenCalled();
    expect(test.checkFollowFromAction).not.toHaveBeenCalled();
  });
});
