import type { ResourceMessage } from "@prisma/client";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTrackedText = vi.fn();
const sendTrackedMedia = vi.fn();
const loggerError = vi.fn();
const loggerWarn = vi.fn();

vi.mock("./dmDeliveryService.js", () => ({ sendTrackedText, sendTrackedMedia }));
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError, warn: loggerWarn } }));

const { sendSequence } = await import("./sequenceSender.js");

beforeEach(() => {
  sendTrackedText.mockReset();
  sendTrackedMedia.mockReset();
  loggerError.mockReset();
});

describe("sendSequence Graph failure privacy", () => {
  it("rethrows for caller state handling but never logs private step or provider content", async () => {
    const sentinels = [
      "PRIVATE-DM-SENTINEL",
      "ACCESS-TOKEN-SENTINEL",
      "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
      "PROVIDER-MESSAGE-SENTINEL",
      "REQUEST-BODY-SENTINEL",
      "ARBITRARY-AXIOS-CODE-SENTINEL",
    ];
    const error = new AxiosError(
      "PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
      "ARBITRARY-AXIOS-CODE-SENTINEL",
    );
    error.config = {
      headers: {} as never,
      url: sentinels[2],
      data: "REQUEST-BODY-SENTINEL PRIVATE-DM-SENTINEL",
    };
    error.response = {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: error.config,
      data: {
        error: {
          code: 100,
          error_subcode: 2534025,
          message: "PROVIDER-MESSAGE-SENTINEL",
          fbtrace_id: "trace_SEQUENCE-1",
        },
      },
    };
    sendTrackedText.mockRejectedValue(error);
    const message = {
      id: "step-1",
      resourceId: "resource-1",
      order: 1,
      type: "text",
      body: "PRIVATE-DM-SENTINEL",
      mediaUrl: null,
      altText: null,
    } as ResourceMessage;

    await expect(
      sendSequence({
        igUserId: "ig-user-1",
        messages: [message],
        source: "guide_automation",
      }),
    ).rejects.toBe(error);

    expect(loggerError).toHaveBeenCalledWith(
      {
        step: "step-1",
        type: "text",
        category: "graph_response",
        httpStatus: 400,
        graphCode: 100,
        graphSubcode: 2534025,
        traceId: "trace_SEQUENCE-1",
        transportCode: null,
      },
      "Sequence step failed",
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const sentinel of sentinels) expect(captured).not.toContain(sentinel);
  });
});

describe("over-length steps", () => {
  const over = "a".repeat(1001); // 1,001 characters
  const fine = "Short and deliverable.";

  it("skips a step that cannot be delivered and still sends the rest", async () => {
    const sent: string[] = [];
    vi.mocked(sendTrackedText).mockImplementation(async ({ text }) => {
      sent.push(text);
      return undefined as never;
    });

    await sendSequence({
      igUserId: "ig-1",
      source: "guide_automation",
      messages: [
        { id: "a", order: 0, type: "text", body: fine, mediaUrl: null },
        { id: "b", order: 1, type: "text", body: over, mediaUrl: null },
        { id: "c", order: 2, type: "text", body: "The closing message.", mediaUrl: null },
      ] as never,
    });

    // The Cardboard shape: the step after the bad one must still arrive.
    expect(sent).toEqual([fine, "The closing message."]);
  });

  /**
   * The one that nearly shipped.
   *
   * "potty" step 0 is 973 characters and 1,005 UTF-8 bytes, and it is the FIRST
   * step of a guide roughly 194 people receive each month. This guard skips what
   * it flags, so a byte measure here would have delivered them nothing at all —
   * causing precisely the failure the skip exists to prevent. It completed 79
   * times in the 30 days before the measure was corrected.
   */
  it("sends the over-1000-byte, under-1000-character bodies production delivers", async () => {
    const sent: string[] = [];
    vi.mocked(sendTrackedText).mockImplementation(async ({ text }) => {
      sent.push(text);
      return undefined as never;
    });

    const pottyShaped = "a".repeat(962) + "💛".repeat(11);
    expect([...pottyShaped].length).toBe(973);
    expect(Buffer.byteLength(pottyShaped, "utf8")).toBeGreaterThan(1000);

    await sendSequence({
      igUserId: "ig-1",
      source: "guide_automation",
      messages: [
        { id: "a", order: 0, type: "text", body: pottyShaped, mediaUrl: null },
        { id: "b", order: 1, type: "text", body: fine, mediaUrl: null },
      ] as never,
    });

    expect(sent).toEqual([pottyShaped, fine]);
  });

  it("never spends a request on a body it knows is too long", async () => {
    vi.mocked(sendTrackedText).mockResolvedValue(undefined as never);

    await sendSequence({
      igUserId: "ig-1",
      source: "guide_automation",
      messages: [{ id: "a", order: 0, type: "text", body: over, mediaUrl: null }] as never,
    });

    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("still aborts on a real send failure, exactly as before", async () => {
    vi.mocked(sendTrackedText)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error("graph exploded"));

    await expect(
      sendSequence({
        igUserId: "ig-1",
        source: "guide_automation",
        messages: [
          { id: "a", order: 0, type: "text", body: fine, mediaUrl: null },
          { id: "b", order: 1, type: "text", body: fine, mediaUrl: null },
          { id: "c", order: 2, type: "text", body: fine, mediaUrl: null },
        ] as never,
      }),
    ).rejects.toThrow("graph exploded");

    // Two attempts, not three: the rethrow still stops the loop.
    expect(sendTrackedText).toHaveBeenCalledTimes(2);
  });
});
