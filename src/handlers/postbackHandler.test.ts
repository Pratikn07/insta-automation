import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GUIDE_ACTION_PAYLOAD,
  GUIDE_ACTION_TIMESTAMP,
  guidePostbackEvent,
  unknownPostbackEvent,
} from "../test/fixtures/metaGuideGateEvents.js";
import { guidePostbackEventId } from "../services/guideActionEventIdentity.js";

const recordRecoveryPostback = vi.fn();
const routeGuideAction = vi.fn();
const loggerInfo = vi.fn();

vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoveryPostback }));
vi.mock("./guideActionRouter.js", () => ({ routeGuideAction }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: loggerInfo, error: vi.fn(), warn: vi.fn() },
}));

const { handlePostback } = await import("./postbackHandler.js");

beforeEach(() => {
  recordRecoveryPostback.mockReset();
  routeGuideAction.mockReset().mockResolvedValue({
    kind: "handled",
    outcome: "follow_not_confirmed",
  });
  loggerInfo.mockReset();
});

describe("postbackHandler", () => {
  it("records recovery postback when mid is present", async () => {
    const timestamp = 1786003200000;
    await handlePostback({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp,
      postback: { mid: "mid-1", payload: "OPEN" },
    });

    expect(recordRecoveryPostback).toHaveBeenCalledWith({
      instagramMessageId: "mid-1",
      eventAt: new Date(timestamp),
      receivedAt: expect.any(Date),
    });
    expect(routeGuideAction).toHaveBeenCalledWith({
      payload: "OPEN",
      senderId: "user-1",
      eventId: guidePostbackEventId("mid-1"),
      source: "postback",
      eventAt: new Date(timestamp),
    });
    expect(recordRecoveryPostback.mock.invocationCallOrder[0]).toBeLessThan(
      routeGuideAction.mock.invocationCallOrder[0]!,
    );
  });

  it("acknowledges without evidence write when mid is missing", async () => {
    await handlePostback({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      postback: { payload: "OPEN" },
    });

    expect(recordRecoveryPostback).not.toHaveBeenCalled();
    expect(routeGuideAction).not.toHaveBeenCalled();
  });

  it("does not log an opaque action payload when a malformed postback has no mid", async () => {
    const entry = guidePostbackEvent();
    entry.postback = { title: entry.postback?.title, payload: GUIDE_ACTION_PAYLOAD };

    await handlePostback(entry);

    expect(recordRecoveryPostback).not.toHaveBeenCalled();
    expect(routeGuideAction).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain(GUIDE_ACTION_PAYLOAD);
  });

  it("passes duplicate provider delivery to the idempotent recovery boundary twice", async () => {
    const entry = guidePostbackEvent();

    await handlePostback(entry);
    await handlePostback(entry);

    expect(recordRecoveryPostback).toHaveBeenCalledTimes(2);
    expect(recordRecoveryPostback).toHaveBeenNthCalledWith(1, {
      instagramMessageId: "controlled-template-mid",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
      receivedAt: expect.any(Date),
    });
    expect(recordRecoveryPostback).toHaveBeenNthCalledWith(2, {
      instagramMessageId: "controlled-template-mid",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
      receivedAt: expect.any(Date),
    });
    expect(routeGuideAction).toHaveBeenCalledTimes(2);
    expect(routeGuideAction).toHaveBeenNthCalledWith(1, {
      payload: GUIDE_ACTION_PAYLOAD,
      senderId: "controlled-recipient",
      eventId: guidePostbackEventId("controlled-template-mid"),
      source: "postback",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
    expect(routeGuideAction).toHaveBeenNthCalledWith(2, {
      payload: GUIDE_ACTION_PAYLOAD,
      senderId: "controlled-recipient",
      eventId: guidePostbackEventId("controlled-template-mid"),
      source: "postback",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
  });

  it("derives different action-event identities for two real taps carrying the same token", async () => {
    const first = guidePostbackEvent();
    const second = guidePostbackEvent();
    second.postback = { ...second.postback, mid: "controlled-template-mid-2" };

    await handlePostback(first);
    await handlePostback(second);

    const firstEventId = routeGuideAction.mock.calls[0]?.[0]?.eventId;
    const secondEventId = routeGuideAction.mock.calls[1]?.[0]?.eventId;
    expect(firstEventId).toBe(guidePostbackEventId("controlled-template-mid"));
    expect(secondEventId).toBe(guidePostbackEventId("controlled-template-mid-2"));
    expect(firstEventId).not.toBe(secondEventId);
  });

  it("acknowledges an unknown action payload through recovery evidence only", async () => {
    await handlePostback(unknownPostbackEvent());

    expect(recordRecoveryPostback).toHaveBeenCalledWith({
      instagramMessageId: "controlled-unknown-mid",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
      receivedAt: expect.any(Date),
    });
    expect(routeGuideAction).toHaveBeenCalledWith({
      payload: "unregistered:action:value",
      senderId: "controlled-recipient",
      eventId: guidePostbackEventId("controlled-unknown-mid"),
      source: "postback",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
