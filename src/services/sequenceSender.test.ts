import type { ResourceMessage } from "@prisma/client";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTrackedText = vi.fn();
const sendTrackedMedia = vi.fn();
const loggerError = vi.fn();

vi.mock("./dmDeliveryService.js", () => ({ sendTrackedText, sendTrackedMedia }));
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError } }));

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
