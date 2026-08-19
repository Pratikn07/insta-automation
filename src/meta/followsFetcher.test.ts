import { describe, expect, it, vi } from "vitest";

vi.mock("./insightsGraphClient.js", () => ({ insightsGraph: { get: vi.fn() } }));
vi.mock("../config/env.js", () => ({
  env: { IG_USER_ID: "123", INSIGHTS_GRAPH_VERSION: "v23.0" },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../services/eventLogger.js", () => ({
  describeGraphError: () => ({
    category: "unknown_error",
    httpStatus: null,
    graphCode: null,
    graphSubcode: null,
    traceId: null,
  }),
}));

const { insightsGraph } = await import("./insightsGraphClient.js");
const { fetchFollowerChurn, parseFollowerChurn } = await import("./followsFetcher.js");

function payload(results: Array<[string, number]>, name = "follows_and_unfollows") {
  return {
    data: [
      {
        name,
        total_value: {
          breakdowns: [
            {
              dimension_keys: ["follow_type"],
              results: results.map(([label, value]) => ({
                dimension_values: [label],
                value,
              })),
            },
          ],
        },
      },
    ],
  };
}

describe("parseFollowerChurn", () => {
  it("reads the follow/unfollow split", () => {
    expect(parseFollowerChurn(payload([["FOLLOWS", 412], ["UNFOLLOWS", 96]]))).toEqual({
      follows: 412,
      unfollows: 96,
    });
  });

  it("does not swallow unfollows into follows on a substring match", () => {
    // "UNFOLLOWS".includes("FOLLOW") is true — the looser test reports 508/0.
    const churn = parseFollowerChurn(payload([["UNFOLLOWS", 96], ["FOLLOWS", 412]]))!;
    expect(churn.unfollows).toBe(96);
    expect(churn.follows).toBe(412);
  });

  it("accepts whatever casing Meta uses", () => {
    expect(parseFollowerChurn(payload([["follows", 10], ["unfollows", 3]]))).toEqual({
      follows: 10,
      unfollows: 3,
    });
  });

  it("refuses a FOLLOWER/NON_FOLLOWER answer — that is not a churn split", () => {
    // The docs describe follow_type this way; it is the `reach` spelling. Reading
    // it as churn would report every non-follower reach bucket as a follow.
    expect(parseFollowerChurn(payload([["FOLLOWER", 800], ["NON_FOLLOWER", 5000]]))).toBeNull();
  });

  it("refuses a half ledger rather than reporting zero unfollows", () => {
    expect(parseFollowerChurn(payload([["FOLLOWS", 412]]))).toBeNull();
  });

  it("returns null for the empty data set Meta sends instead of 0", () => {
    expect(parseFollowerChurn({ data: [] })).toBeNull();
    expect(parseFollowerChurn({})).toBeNull();
    expect(parseFollowerChurn({ data: [{ name: "follows_and_unfollows" }] })).toBeNull();
  });

  it("treats a missing value as zero once the side is identified", () => {
    const body = payload([["FOLLOWS", 5], ["UNFOLLOWS", 0]]);
    delete (body.data[0]!.total_value!.breakdowns![0]!.results[1] as { value?: number }).value;
    expect(parseFollowerChurn(body)).toEqual({ follows: 5, unfollows: 0 });
  });

  it("sums repeated rows for the same side", () => {
    expect(
      parseFollowerChurn(payload([["FOLLOWS", 5], ["FOLLOWS", 7], ["UNFOLLOWS", 2]])),
    ).toEqual({ follows: 12, unfollows: 2 });
  });
});

describe("fetchFollowerChurn", () => {
  it("asks for exactly the account's Pacific analytics day", async () => {
    vi.mocked(insightsGraph.get).mockResolvedValueOnce({
      data: payload([["FOLLOWS", 200], ["UNFOLLOWS", 30]]),
    } as never);

    await expect(fetchFollowerChurn("2026-08-17")).resolves.toEqual({
      follows: 200,
      unfollows: 30,
    });

    const params = vi.mocked(insightsGraph.get).mock.calls[0]![1]!.params as Record<string, unknown>;
    expect(params.metric).toBe("follows_and_unfollows");
    expect(params.period).toBe("day");
    expect(params.metric_type).toBe("total_value");
    expect(params.breakdown).toBe("follow_type");
    // 2026-08-17 00:00 and 2026-08-18 00:00 Pacific (PDT, UTC-7).
    expect(params.since).toBe(Date.parse("2026-08-17T07:00:00Z") / 1000);
    expect(params.until).toBe(Date.parse("2026-08-18T07:00:00Z") / 1000);
  });

  it("degrades to null when the Graph call fails", async () => {
    vi.mocked(insightsGraph.get).mockRejectedValueOnce(new Error("429"));
    await expect(fetchFollowerChurn("2026-08-17")).resolves.toBeNull();
  });
});
