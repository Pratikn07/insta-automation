// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

const { HistoricalCandidateDrawer } = await import("./HistoricalCandidateDrawer");

const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

function detail(overrides: Record<string, unknown> = {}) {
  return {
    candidate: {
      id: CANDIDATE_ID,
      campaignId: "11111111-1111-4111-8111-111111111111",
      campaignPhase: "unknown_read_pilot",
      intentId: "55555555-5555-4555-8555-555555555555",
      igUserId: "ig-1",
      conversationId: "canonical-1",
      keywordId: "keyword-1",
      commentId: "comment-1",
      mediaId: "media-1",
      commentAt: "2026-06-25T10:00:00.000Z",
      keywordSnapshot: "SLEEP",
      publicReplyText: "Recovery copy",
      evidence: "gate_sent_no_read",
      audienceOrigin: "us_western",
      audienceOriginMethod: "llm_v1",
      audienceOriginConfidence: "high",
      arm: "treatment",
      outcome: "send_uncertain",
      attempts: 1,
      lastAttemptAt: "2026-08-08T18:00:00.000Z",
      sentAt: null,
      publicReplyId: null,
      suppressionReason: "missing_reply_id",
      reviewedAt: null,
      laterInboundAt: null,
      laterCompletedAt: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-08T18:00:00.000Z",
    },
    campaign: {
      id: "11111111-1111-4111-8111-111111111111",
      phase: "unknown_read_pilot",
      state: "running",
      selectionVersion: "selection-v2",
      copyVersion: "recovery-v2",
      sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    },
    intent: {
      id: "55555555-5555-4555-8555-555555555555",
      igUserId: "ig-1",
      keyword: { id: "keyword-1", keyword: "SLEEP" },
      windowStartedAt: "2026-06-25T10:00:00.000Z",
      lastTriggerAt: "2026-06-25T10:05:00.000Z",
      windowExpiresAt: "2026-06-27T10:05:00.000Z",
      reconciledState: "canonical",
      completedAt: null,
      canonicalConversation: {
        id: "canonical-1",
        state: "expired",
        createdAt: "2026-06-25T10:00:00.000Z",
        reconciliationReason: "oldest_valid_owner",
      },
      aliasConversations: [
        {
          id: "alias-1",
          state: "expired",
          createdAt: "2026-06-25T10:03:00.000Z",
          reconciliationReason: "duplicate_inside_window",
        },
      ],
      triggers: [
        {
          id: "trigger-1",
          conversationId: "canonical-1",
          commentId: "comment-1",
          mediaId: "media-1",
          receivedAt: "2026-06-25T10:00:00.000Z",
          triggerKind: "comment",
          disposition: "new_journey",
        },
      ],
    },
    mediaPermalink: "https://www.instagram.com/reel/verified-source/",
    auditEvents: [
      {
        id: "event-1",
        kind: "historical_recovery_send_uncertain",
        actor: null,
        action: null,
        reason: null,
        category: "missing_reply_id",
        createdAt: "2026-08-08T18:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HistoricalCandidateDrawer candidateId={CANDIDATE_ID} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  api.mockReset().mockResolvedValue(detail());
});

describe("HistoricalCandidateDrawer", () => {
  it("shows canonical, alias, trigger, and audit evidence", async () => {
    renderDrawer();

    expect(await screen.findByText("canonical-1")).toBeInTheDocument();
    expect(screen.getByText("alias-1")).toBeInTheDocument();
    expect(screen.getAllByText("comment-1")).toHaveLength(2);
    expect(screen.getByText("historical recovery send uncertain")).toBeInTheDocument();
  });

  it("shows the frozen audience origin provenance", async () => {
    renderDrawer();

    expect(await screen.findByText("Audience origin")).toBeInTheDocument();
    expect(screen.getByText("us western")).toBeInTheDocument();
    expect(screen.getByText("llm v1")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("links only to the verified stored source permalink", async () => {
    renderDrawer();
    const link = await screen.findByRole("link", { name: "View source post" });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/reel/verified-source/");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders no Instagram link when the server has no verified permalink", async () => {
    api.mockResolvedValue(detail({ mediaPermalink: null }));
    renderDrawer();
    expect(await screen.findByText("Source permalink unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View source post" })).not.toBeInTheDocument();
  });

  it("marks an attention candidate reviewed and retires the action after refetch", async () => {
    let reviewed = false;
    api.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path.endsWith("/mark-reviewed")) {
        reviewed = true;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(
        detail({
          candidate: {
            ...detail().candidate,
            reviewedAt: reviewed ? "2026-08-08T19:00:00.000Z" : null,
          },
        }),
      );
    });
    const user = userEvent.setup();
    renderDrawer();

    await user.click(await screen.findByRole("button", { name: "Mark reviewed" }));

    expect(await screen.findByText("Reviewed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
  });
});
