// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideAccessReview } from "@/lib/types";

const apiCall = vi.fn();
vi.mock("@/lib/api", () => ({
  apiMutation: (path: string, init?: RequestInit) => apiCall(path, init),
  apiErrorCode: () => null,
}));

const { GuideAccessReviewCard } = await import("./GuideAccessReviewCard");

const review: GuideAccessReview = {
  attemptId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  resourceName: "Toddler sleep guide",
  state: "needs_review",
  lastFollowResult: "unknown",
  followCheckCount: 5,
  followResponseCount: 3,
  messagingWindowExpiresAt: "2026-08-25T20:00:00.000Z",
  messagingWindowOpen: true,
  canRelease: true,
  canResendAction: true,
};

function renderCard(value: GuideAccessReview = review) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuideAccessReviewCard threadId="thread-1" review={value} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiCall.mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

describe("GuideAccessReviewCard", () => {
  it("shows the blocked guide without exposing tokens or private message content", () => {
    renderCard();
    expect(screen.getByText("Guide access needs review")).toBeInTheDocument();
    expect(screen.getByText(/Toddler sleep guide · 5 access checks/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/10000000|20000000|token/i);
  });

  it("requires confirmation and sends exactly one fresh action", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Resend action" }));
    expect(apiCall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Send fresh action" }));

    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    expect(apiCall.mock.calls[0]?.[0]).toBe(
      `/guide-deliveries/access/${review.conversationId}/resend-action`,
    );
    expect(JSON.parse(String(apiCall.mock.calls[0]?.[1]?.body))).toEqual({
      acknowledgeDuplicateRisk: true,
    });
  });

  it("disables sending after the messaging window closes", () => {
    renderCard({ ...review, messagingWindowOpen: false, canResendAction: false });
    expect(screen.getByRole("button", { name: "Resend action" })).toBeDisabled();
    expect(screen.getByText(/wait for a fresh parent message/i)).toBeInTheDocument();
  });
});
