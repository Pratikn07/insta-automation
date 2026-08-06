import type { AxiosAdapter } from "axios";
import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerError, getAccessToken } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  getAccessToken: vi.fn(() => "IG-ACCESS-TOKEN-SENTINEL"),
}));

vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError } }));
vi.mock("./tokenStore.js", () => ({ getAccessToken }));

const { insightsGraph } = await import("./insightsGraphClient.js");

describe("Insights Graph client error logging", () => {
  beforeEach(() => {
    loggerError.mockReset();
    getAccessToken.mockClear();
  });

  it("emits only the shared closed Graph metadata allowlist", async () => {
    const sentinels = [
      "PRIVATE-DM-SENTINEL",
      "ACCESS-TOKEN-SENTINEL",
      "https://graph.instagram.com/insights?access_token=ACCESS-TOKEN-SENTINEL",
      "PROVIDER-MESSAGE-SENTINEL",
      "REQUEST-BODY-SENTINEL",
      "ARBITRARY-AXIOS-CODE-SENTINEL",
      "IG-ACCESS-TOKEN-SENTINEL",
    ];
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError(
        "PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
        "ARBITRARY-AXIOS-CODE-SENTINEL",
        config,
        undefined,
        {
          data: {
            error: {
              code: 190,
              error_subcode: 460,
              message: "PROVIDER-MESSAGE-SENTINEL",
              fbtrace_id: "trace_INSIGHTS-1",
            },
          },
          status: 500,
          statusText: "Server Error",
          headers: new AxiosHeaders(),
          config,
        },
      );
    };

    await expect(
      insightsGraph.post(sentinels[2], { marker: "REQUEST-BODY-SENTINEL" }, { adapter }),
    ).rejects.toBeInstanceOf(AxiosError);

    expect(loggerError).toHaveBeenCalledWith(
      {
        category: "graph_response",
        httpStatus: 500,
        graphCode: 190,
        graphSubcode: 460,
        traceId: "trace_INSIGHTS-1",
      },
      "Insights Graph API error",
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const sentinel of sentinels) expect(captured).not.toContain(sentinel);
  });
});
