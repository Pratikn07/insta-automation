import { describe, expect, it, vi } from "vitest";

vi.mock("./insightsGraphClient.js", () => ({
  insightsGraph: { get: vi.fn() },
}));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "123", INSIGHTS_GRAPH_VERSION: "v23.0" } }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../services/eventLogger.js", () => ({ describeGraphError: () => ({ status: 400 }) }));

const { insightsGraph } = await import("./insightsGraphClient.js");
const { fetchProfileTotals } = await import("./profileFetcher.js");

// NO beforeEach hook here, deliberately. Under Vitest 4, registering a
// beforeEach in a describe whose test rejects a mocked promise makes the runner
// report that rejection as unhandled and fail the test — even though the code
// under test catches it. Isolated and confirmed: the same test body passes
// verbatim without the hook, and fails with it. Each test sets the mock it needs
// via mockImplementation, so no shared state needs resetting anyway.
function mockGet(impl: () => Promise<unknown>): void {
  vi.mocked(insightsGraph.get).mockImplementation(impl as never);
}

describe("fetchProfileTotals", () => {
  it("returns the true follower count from the user node", async () => {
    mockGet(() => Promise.resolve({ data: { followers_count: 4577, id: "123" } }));
    expect(await fetchProfileTotals()).toEqual({ followersTotal: 4577 });
  });

  it("requests only the followers_count field off the user node", async () => {
    vi.mocked(insightsGraph.get).mockClear();
    mockGet(() => Promise.resolve({ data: { followers_count: 10 } }));
    await fetchProfileTotals();
    const [path, config] = vi.mocked(insightsGraph.get).mock.calls[0]!;
    expect(path).toBe("/123");
    expect((config as { params: Record<string, string> }).params.fields).toBe("followers_count");
  });

  it("returns null rather than throwing when the call fails", async () => {
    mockGet(() => Promise.reject(new Error("401 bad token")));
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });
  });

  it("returns null when the field is absent", async () => {
    mockGet(() => Promise.resolve({ data: { id: "123" } }));
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });
  });

  it("returns null when the field is non-numeric", async () => {
    mockGet(() => Promise.resolve({ data: { followers_count: "lots" } }));
    expect(await fetchProfileTotals()).toEqual({ followersTotal: null });
  });
});
