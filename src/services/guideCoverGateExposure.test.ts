import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceMessage } from "@prisma/client";

const sendTrackedMedia = vi.fn();
const logEvent = vi.fn();
const findFirst = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock("./dmDeliveryService.js", () => ({ sendTrackedMedia }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../lib/prisma.js", () => ({ prisma: { eventLog: { findFirst } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: loggerWarn, error: loggerError },
}));

const {
  GATE_COVER_EVENT,
  attachedCoverMessage,
  sendCoverBeforeGate,
  wasCoverShownAtGate,
  withoutAlreadyShownCover,
} = await import("./guideCoverGateExposure.js");

const COVER_URL = "https://cdn.example.test/guide-cover/r/v/h/dm.png";

function message(partial: Partial<ResourceMessage>): ResourceMessage {
  return {
    id: "m",
    resourceId: "r",
    order: 0,
    type: "text",
    body: null,
    mediaUrl: null,
    altText: null,
    ...partial,
  } as ResourceMessage;
}

const COVER = message({ id: "cover", order: -1, type: "image", mediaUrl: COVER_URL });
const STEP = message({ id: "s1", order: 0, type: "text", body: "Step one" });

beforeEach(() => {
  sendTrackedMedia.mockReset();
  logEvent.mockReset();
  findFirst.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("attachedCoverMessage", () => {
  it("finds the cover attached ahead of the guide", () => {
    expect(attachedCoverMessage([STEP, COVER])?.id).toBe("cover");
  });

  /**
   * Order alone is not enough. `order: -1` is the slot the cover occupies, but an image with
   * no URL cannot be sent and a text row there is not a cover — matching on position only
   * would hand `sendTrackedMedia` an empty url.
   */
  it("ignores an order -1 row that is not a sendable image", () => {
    expect(attachedCoverMessage([message({ id: "x", order: -1, type: "text", body: "hi" })])).toBeNull();
    expect(attachedCoverMessage([message({ id: "y", order: -1, type: "image" })])).toBeNull();
  });

  it("does not treat an ordinary guide image as a cover", () => {
    const photo = message({ id: "p", order: 0, type: "image", mediaUrl: COVER_URL });
    expect(attachedCoverMessage([photo])).toBeNull();
  });
});

describe("sendCoverBeforeGate", () => {
  const input = {
    conversationId: "c1",
    resourceId: "r1",
    recipientIgUserId: "ig-1",
    messages: [COVER, STEP],
  };

  it("sends the cover and records that the parent saw it", async () => {
    sendTrackedMedia.mockResolvedValue({ messageId: "mid" });

    await expect(sendCoverBeforeGate(input)).resolves.toBe(true);
    expect(sendTrackedMedia).toHaveBeenCalledWith({
      recipientIgUserId: "ig-1",
      type: "image",
      url: COVER_URL,
      source: "keyword_automation",
    });
    expect(logEvent).toHaveBeenCalledWith(GATE_COVER_EVENT, {
      conversationId: "c1",
      resourceId: "r1",
    });
  });

  it("reports false without sending when the guide has no cover", async () => {
    await expect(sendCoverBeforeGate({ ...input, messages: [STEP] })).resolves.toBe(false);
    expect(sendTrackedMedia).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing case. The gate message is what converts, and the caller sends it after
   * this returns — so a cover failure must NOT throw, or a picture problem would cost the
   * parent the ask itself. It must also not record the event: claiming the parent saw a cover
   * that failed would suppress it at delivery too, leaving them with none anywhere.
   */
  it("never throws when the cover send fails, and records nothing", async () => {
    sendTrackedMedia.mockRejectedValue(new Error("graph exploded"));

    await expect(sendCoverBeforeGate(input)).resolves.toBe(false);
    expect(logEvent).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "guide_gate_cover_failed" }),
      expect.any(String),
    );
  });
});

describe("wasCoverShownAtGate", () => {
  it("queries by event kind and conversation", async () => {
    findFirst.mockResolvedValue({ id: "e1" });

    await expect(wasCoverShownAtGate("c1")).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        kind: GATE_COVER_EVENT,
        payload: { path: ["conversationId"], equals: "c1" },
      },
      select: { id: true },
    });
  });

  it("is false when no such event exists", async () => {
    findFirst.mockResolvedValue(null);
    await expect(wasCoverShownAtGate("c1")).resolves.toBe(false);
  });

  /**
   * Fails towards SHOWING the cover. A duplicate image is a blemish a reader forgives; a
   * guide that silently lost its cover because a lookup timed out is worse and far harder to
   * notice, since nothing errors and the guide still arrives.
   */
  it("falls back to showing the cover when the lookup fails", async () => {
    findFirst.mockRejectedValue(new Error("pool exhausted"));

    await expect(wasCoverShownAtGate("c1")).resolves.toBe(false);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "guide_gate_cover_lookup_failed" }),
      expect.any(String),
    );
  });
});

describe("withoutAlreadyShownCover", () => {
  it("drops the cover once the parent has seen it", () => {
    expect(withoutAlreadyShownCover([COVER, STEP], true).map((m) => m.id)).toEqual(["s1"]);
  });

  it("keeps the cover when the parent has not", () => {
    expect(withoutAlreadyShownCover([COVER, STEP], false).map((m) => m.id)).toEqual([
      "cover",
      "s1",
    ]);
  });

  /**
   * Only the cover is removed. Filtering by kind or by URL instead of by the cover row's own
   * id would strip an activity guide's photos — several guides lead with real images, and
   * losing those to a cover rule would quietly gut the guides most built around pictures.
   */
  it("never removes the guide's own images", () => {
    const photo = message({ id: "p", order: 1, type: "image", mediaUrl: COVER_URL });
    expect(withoutAlreadyShownCover([COVER, STEP, photo], true).map((m) => m.id)).toEqual([
      "s1",
      "p",
    ]);
  });

  it("returns a copy rather than mutating the caller's array", () => {
    const messages = [COVER, STEP];
    withoutAlreadyShownCover(messages, true);
    expect(messages).toHaveLength(2);
  });
});
