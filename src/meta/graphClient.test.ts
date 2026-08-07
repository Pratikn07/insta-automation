import type { AxiosAdapter } from "axios";
import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerError, getAccessToken } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  getAccessToken: vi.fn(() => "IG-ACCESS-TOKEN-SECRET"),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError },
}));
vi.mock("./tokenStore.js", () => ({ getAccessToken }));

const { graph } = await import("./graphClient.js");

describe("Graph client error logging", () => {
  beforeEach(() => {
    loggerError.mockReset();
    getAccessToken.mockClear();
  });

  it("logs only allowlisted numeric provider metadata", async () => {
    const providerSecret = "provider-message-has-DM-and-token";
    const editorSecret = "private approved editor body";
    const urlSecret = "URL-QUERY-ACCESS-TOKEN";
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError(
        `Provider rejected: ${providerSecret}`,
        "ERR_BAD_RESPONSE",
        config,
        undefined,
        {
          data: {
            error: {
              code: 100,
              error_subcode: 2534025,
              message: providerSecret,
              error_user_msg: editorSecret,
              fbtrace_id: "trace_SAFE-123",
            },
          },
          status: 400,
          statusText: "Bad Request",
          headers: new AxiosHeaders(),
          config,
        },
      );
    };

    await expect(
      graph.post(`/messages?access_token=${urlSecret}`, { text: editorSecret }, { adapter }),
    ).rejects.toBeInstanceOf(AxiosError);

    expect(loggerError).toHaveBeenCalledWith(
      {
        category: "graph_response",
        httpStatus: 400,
        graphCode: 100,
        graphSubcode: 2534025,
        traceId: "trace_SAFE-123",
        transportCode: null,
      },
      "Graph API error",
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const secret of [
      providerSecret,
      editorSecret,
      urlSecret,
      "IG-ACCESS-TOKEN-SECRET",
      "ERR_BAD_RESPONSE",
    ]) {
      expect(captured).not.toContain(secret);
    }
  });
});
