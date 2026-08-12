// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

const { HistoricalRecovery } = await import("./HistoricalRecovery");

const FIRST_CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: FIRST_CAMPAIGN_ID,
    phase: "unknown_read_pilot",
    state: "draft",
    selectionVersion: "selection-v2",
    copyVersion: "recovery-v2",
    sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    holdoutPercent: 50,
    batchSize: 1,
    hourlyCap: 3,
    dailyCap: 10,
    candidateCount: 2,
    excludedCount: 0,
    approvedBy: null,
    approvedAt: null,
    startedAt: null,
    pausedAt: null,
    pauseReason: null,
    endedAt: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    progress: {},
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    campaignId: FIRST_CAMPAIGN_ID,
    campaignPhase: "unknown_read_pilot",
    igUserId: "ig-1",
    username: "sarah",
    keywordSnapshot: "SLEEP",
    commentId: "comment-1",
    mediaId: "media-1",
    commentAt: "2026-06-25T10:00:00.000Z",
    publicReplyText: "Recovery copy",
    evidence: "gate_sent_no_read",
    arm: "treatment",
    outcome: "pending",
    audienceOrigin: "us_western",
    audienceOriginConfidence: "high",
    sentAt: null,
    publicReplyId: null,
    suppressionReason: null,
    reviewedAt: null,
    laterInboundAt: null,
    laterCompletedAt: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function candidatesPage(overrides: Record<string, unknown> = {}) {
  return {
    counts: {
      all: 1,
      pending: 1,
      sent: 0,
      suppressed: 0,
      attention: 0,
      holdout: 0,
      recovered: 0,
    },
    nextCursor: null,
    asOf: "2026-08-08T20:00:00.000Z",
    candidates: [candidate()],
    ...overrides,
  };
}

function candidateDetail() {
  const row = candidate();
  return {
    candidate: {
      ...row,
      intentId: "55555555-5555-4555-8555-555555555555",
      conversationId: "canonical-1",
      keywordId: "keyword-1",
      attempts: 0,
      lastAttemptAt: null,
      updatedAt: row.createdAt,
    },
    campaign: {
      id: FIRST_CAMPAIGN_ID,
      state: "draft",
      selectionVersion: "selection-v2",
      copyVersion: "recovery-v2",
      sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    },
    intent: {
      id: "55555555-5555-4555-8555-555555555555",
      keyword: { id: "keyword-1", keyword: "SLEEP" },
      reconciledState: "canonical",
      completedAt: null,
      canonicalConversation: { id: "canonical-1", state: "expired", reconciliationReason: null },
      aliasConversations: [],
      triggers: [],
    },
    mediaPermalink: "https://www.instagram.com/reel/source/",
    auditEvents: [],
  };
}

let campaigns = [
  campaign(),
  campaign({
    id: SECOND_CAMPAIGN_ID,
    phase: "confirmed_failure",
    createdAt: "2026-08-01T00:00:00.000Z",
  }),
];

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HistoricalRecovery />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  campaigns = [
    campaign(),
    campaign({
      id: SECOND_CAMPAIGN_ID,
      phase: "confirmed_failure",
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
  ];
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/historical-recovery/campaigns") {
      return Promise.resolve({ sendingEnabled: true, campaigns });
    }
    if (path.startsWith("/historical-recovery/candidates?")) {
      return Promise.resolve(candidatesPage());
    }
    if (path.startsWith("/historical-recovery/candidates/")) {
      return Promise.resolve(candidateDetail());
    }
    return Promise.resolve({ state: "running" });
  });
});

describe("HistoricalRecovery", () => {
  it("lets the operator select a campaign and shows phase-safe copy", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByRole("combobox", { name: "Campaign" }), SECOND_CAMPAIGN_ID);

    await waitFor(() =>
      expect(
        api.mock.calls.some(([path]) =>
          String(path).includes(`campaignId=${SECOND_CAMPAIGN_ID}`),
        ),
      ).toBe(true),
    );
    expect(screen.getByText(/original guide could not be delivered/i)).toBeInTheDocument();
  });

  it("approves with an empty body so the server owns attribution", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Approve 2 people" }));
    await user.click(screen.getByRole("button", { name: "Approve and start" }));

    await waitFor(() => {
      const call = api.mock.calls.find(([path]) => String(path).endsWith("/approve"));
      expect(call?.[1]).toMatchObject({ method: "POST", body: "{}" });
      expect(String(call?.[1]?.body)).not.toContain("approvedBy");
    });
  });

  it("submits numeric stage caps through the existing endpoint", async () => {
    campaigns = [campaign({ state: "running" })];
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Advance stage" }));
    const batch = screen.getByRole("spinbutton", { name: "Batch size" });
    const hourly = screen.getByRole("spinbutton", { name: "Hourly cap" });
    const daily = screen.getByRole("spinbutton", { name: "Daily cap" });
    await user.clear(batch);
    await user.type(batch, "2");
    await user.clear(hourly);
    await user.type(hourly, "6");
    await user.clear(daily);
    await user.type(daily, "20");
    await user.click(screen.getByRole("button", { name: "Save stage" }));

    await waitFor(() => {
      const call = api.mock.calls.find(([path]) => String(path).endsWith("/stage"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        batchSize: 2,
        hourlyCap: 6,
        dailyCap: 20,
      });
    });
  });

  it("loads the next cursor with the first page asOf boundary", async () => {
    api.mockImplementation((path: string) => {
      if (path === "/historical-recovery/campaigns") {
        return Promise.resolve({ sendingEnabled: true, campaigns });
      }
      if (path.includes("cursor=33333333-3333-4333-8333-333333333333")) {
        return Promise.resolve(
          candidatesPage({
            candidates: [
              candidate({
                id: "44444444-4444-4444-8444-444444444444",
                username: "maria",
              }),
            ],
          }),
        );
      }
      if (path.startsWith("/historical-recovery/candidates?")) {
        return Promise.resolve(
          candidatesPage({ nextCursor: "33333333-3333-4333-8333-333333333333" }),
        );
      }
      return Promise.resolve({ state: "running" });
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(
        api.mock.calls.some(([path]) => {
          const value = String(path);
          return value.startsWith("/historical-recovery/candidates?") && !value.includes("asOf=");
        }),
      ).toBe(true),
    );
    await user.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(
        api.mock.calls.some(([path]) => {
          const value = String(path);
          return (
            value.includes("cursor=33333333-3333-4333-8333-333333333333") &&
            value.includes("asOf=2026-08-08T20%3A00%3A00.000Z")
          );
        }),
      ).toBe(true),
    );
    expect(await screen.findByText("@maria")).toBeInTheDocument();
    expect(screen.getAllByText("@sarah")).toHaveLength(1);
  });

  it("opens the real evidence drawer from a candidate row", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Open @sarah SLEEP" }));

    expect(await screen.findByRole("dialog", { name: "Historical recovery evidence" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View source post" })).toHaveAttribute(
      "href",
      "https://www.instagram.com/reel/source/",
    );
  });

  it("offers one confirmed shared pause for a group with a running sibling", async () => {
    campaigns = [
      campaign({
        id: FIRST_CAMPAIGN_ID,
        state: "running",
        audienceSegment: "other",
        rolloutGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rolloutGroupHourlyCap: 10,
        rolloutGroupSentLastHour: 7,
      }),
      campaign({
        id: SECOND_CAMPAIGN_ID,
        state: "running",
        audienceSegment: "unknown_no_name",
        rolloutGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rolloutGroupHourlyCap: 10,
        rolloutGroupSentLastHour: 7,
      }),
    ];
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Shared group capacity used")).toBeInTheDocument();
    expect(screen.getByText("7 / 10 in the past hour")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pause all expanded campaigns" })).toHaveLength(1);

    const pauseAll = screen.getByRole("button", { name: "Pause all expanded campaigns" });
    pauseAll.focus();
    await user.click(pauseAll);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Pause all expanded campaigns?");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(within(dialog).getByRole("button", { name: "Pause all campaigns" }));

    await waitFor(() => {
      const call = api.mock.calls.find(([path]) => String(path).includes("/rollout-groups/"));
      expect(call?.[0]).toBe(
        "/historical-recovery/rollout-groups/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pause",
      );
      expect(call?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ reason: "Stopped from the dashboard" }),
      });
    });
  });

  it("restores the group pause trigger after an Escape-dismissed confirmation", async () => {
    campaigns = [
      campaign({
        id: FIRST_CAMPAIGN_ID,
        state: "running",
        rolloutGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      campaign({
        id: SECOND_CAMPAIGN_ID,
        state: "running",
        rolloutGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ];
    const user = userEvent.setup();
    renderPage();

    const pauseAll = await screen.findByRole("button", { name: "Pause all expanded campaigns" });
    pauseAll.focus();
    await user.click(pauseAll);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(pauseAll).toHaveFocus();
  });

  it("does not offer a shared pause when a group has no running sibling", async () => {
    campaigns = [campaign({
      state: "running",
      rolloutGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      rolloutGroupHourlyCap: 10,
      rolloutGroupSentLastHour: 0,
    })];
    renderPage();

    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause all expanded campaigns" })).not.toBeInTheDocument();
  });
});
