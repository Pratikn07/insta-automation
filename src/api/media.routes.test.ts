import { AxiosError } from "axios";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAllMedia = vi.fn();
const fetchAllReels = vi.fn();
const loggerError = vi.fn();

vi.mock("../meta/fetchMedia.js", () => ({ fetchAllMedia, fetchAllReels }));
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError } }));

const { mediaRouter } = await import("./media.routes.js");

function makeApp() {
  const app = express();
  app.use("/api/media", mediaRouter);
  return app;
}

const SENTINELS = [
  "PRIVATE-DM-SENTINEL",
  "ACCESS-TOKEN-SENTINEL",
  "https://graph.instagram.com/media?access_token=ACCESS-TOKEN-SENTINEL",
  "PROVIDER-MESSAGE-SENTINEL",
  "REQUEST-BODY-SENTINEL",
  "ARBITRARY-AXIOS-CODE-SENTINEL",
];

function graphFailure(): AxiosError {
  const error = new AxiosError(
    "PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
    "ARBITRARY-AXIOS-CODE-SENTINEL",
  );
  error.config = {
    headers: {} as never,
    url: SENTINELS[2],
    data: "REQUEST-BODY-SENTINEL PRIVATE-DM-SENTINEL",
  };
  error.response = {
    status: 500,
    statusText: "Server Error",
    headers: {},
    config: error.config,
    data: {
      error: {
        code: 2,
        error_subcode: 99,
        message: "PROVIDER-MESSAGE-SENTINEL",
        fbtrace_id: "trace_MEDIA-1",
      },
    },
  };
  return error;
}

beforeEach(() => {
  fetchAllMedia.mockReset();
  fetchAllReels.mockReset();
  loggerError.mockReset();
});

describe("media route Graph failure privacy", () => {
  it.each([
    ["content", fetchAllMedia, "media_fetch_failed", "Failed to fetch media from Graph API"],
    ["reels", fetchAllReels, "reels_fetch_failed", "Failed to fetch reels from Graph API"],
  ] as const)("sanitizes /%s failures", async (path, fetcher, responseCode, logMessage) => {
    fetcher.mockRejectedValue(graphFailure());

    await request(makeApp())
      .get(`/api/media/${path}`)
      .expect(502, { error: responseCode });

    expect(loggerError).toHaveBeenCalledWith(
      {
        category: "graph_response",
        httpStatus: 500,
        graphCode: 2,
        graphSubcode: 99,
        traceId: "trace_MEDIA-1",
      },
      logMessage,
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });
});
