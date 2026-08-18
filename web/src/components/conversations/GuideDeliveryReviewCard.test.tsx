// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideDeliveryReview, GuideDeliveryReviewUnit } from "../../lib/types";

const apiCall = vi.fn();

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../lib/api", () => ({
  api: (path: string, init?: RequestInit) => apiCall(path, init),
  ApiError,
  apiErrorCode: (error: unknown) =>
    error instanceof ApiError && error.body && typeof error.body === "object"
      ? ((error.body as { error?: unknown }).error as string | null) ?? null
      : null,
}));

const { GuideDeliveryReviewCard, CLOSED_WINDOW_MESSAGE } = await import(
  "./GuideDeliveryReviewCard"
);

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";

function unit(overrides: Partial<GuideDeliveryReviewUnit> = {}): GuideDeliveryReviewUnit {
  return {
    id: "33333333-3333-4333-8333-333333333331",
    position: 0,
    kind: "text",
    status: "sent",
    ...overrides,
  };
}

/**
 * Four units: two already sent, one uncertain (the decision), one still pending.
 * `position` is zero-based on the wire, so the rendered labels prove the
 * one-based translation rather than echoing the raw column.
 */
function review(overrides: Partial<GuideDeliveryReview> = {}): GuideDeliveryReview {
  return {
    id: DELIVERY_ID,
    status: "needs_review",
    confirmedUnits: 2,
    totalUnits: 4,
    sendWindowExpiresAt: "2026-08-18T00:00:00.000Z",
    sendWindowOpen: true,
    failureCode: null,
    units: [
      unit({ id: "33333333-3333-4333-8333-333333333331", position: 0, status: "sent" }),
      unit({ id: "33333333-3333-4333-8333-333333333332", position: 1, status: "sent" }),
      unit({
        id: "33333333-3333-4333-8333-333333333333",
        position: 2,
        kind: "image",
        status: "uncertain",
      }),
      unit({ id: "33333333-3333-4333-8333-333333333334", position: 3, status: "pending" }),
    ],
    ...overrides,
  };
}

function renderCard(value: GuideDeliveryReview = review()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <GuideDeliveryReviewCard threadId={THREAD_ID} review={value} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  apiCall.mockReset();
  apiCall.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("GuideDeliveryReviewCard", () => {
  it("states the decision and how far the delivery actually got", () => {
    renderCard();

    expect(screen.getByText("Delivery needs review")).toBeInTheDocument();
    expect(screen.getByText("2 of 4 messages confirmed")).toBeInTheDocument();
  });

  it("numbers messages from one and names each kind", () => {
    renderCard();

    expect(screen.getByText("Message 3")).toBeInTheDocument();
    expect(screen.getByText("Message 4")).toBeInTheDocument();
    // Zero-based wire positions must never reach the owner.
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument();
  });

  it("offers all three owner resolutions for the uncertain message", () => {
    renderCard();

    expect(screen.getByRole("button", { name: "Already delivered" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry unit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel delivery" })).toBeEnabled();
  });

  it("never renders guide content, media, provider bodies, or tokens", () => {
    renderCard(
      review({
        // Fields the server does not serialise. If a future change leaks them into
        // the DTO, this card must still refuse to print them.
        ...({
          textSnapshot: "PRIVATE-SNAPSHOT",
          mediaUrlSnapshot: "https://cdn.example.com/PRIVATE-MEDIA.jpg",
          providerBody: "PRIVATE-PROVIDER-BODY",
          accessToken: "PRIVATE-TOKEN",
          errorTraceId: "PRIVATE-TRACE",
        } as unknown as Partial<GuideDeliveryReview>),
      }),
    );

    expect(screen.queryByText("PRIVATE-SNAPSHOT")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PRIVATE-SNAPSHOT");
    expect(document.body.textContent).not.toContain("PRIVATE-MEDIA");
    expect(document.body.textContent).not.toContain("PRIVATE-PROVIDER-BODY");
    expect(document.body.textContent).not.toContain("PRIVATE-TOKEN");
    expect(document.body.textContent).not.toContain("PRIVATE-TRACE");
    expect(document.body.innerHTML).not.toContain("cdn.example.com");
  });

  it("confirms a delivered message against the unit route", async () => {
    const { invalidate } = renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Already delivered" }));

    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1));
    expect(apiCall.mock.calls[0][0]).toBe(
      `/guide-deliveries/${DELIVERY_ID}/units/33333333-3333-4333-8333-333333333333/confirm-delivered`,
    );
    expect(apiCall.mock.calls[0][1]).toMatchObject({ method: "POST" });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dm-thread", THREAD_ID] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dm-threads"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation-counts"] });
  });

  it("requires an explicit duplicate-risk acknowledgement before retrying", async () => {
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Retry unit" }));

    // Opening the dialog must not dispatch anything.
    expect(apiCall).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Instagram may have already delivered this message/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry anyway" }));

    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1));
    expect(apiCall.mock.calls[0][0]).toBe(
      `/guide-deliveries/${DELIVERY_ID}/units/33333333-3333-4333-8333-333333333333/retry`,
    );
    expect(JSON.parse(String(apiCall.mock.calls[0][1].body))).toEqual({
      acknowledgeDuplicateRisk: true,
    });
  });

  it("sends nothing when the duplicate-risk dialog is dismissed", async () => {
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Retry unit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(apiCall).not.toHaveBeenCalled();
  });

  it("cancels the whole delivery through the delivery route", async () => {
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Cancel delivery" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel delivery anyway" }));

    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1));
    expect(apiCall.mock.calls[0][0]).toBe(`/guide-deliveries/${DELIVERY_ID}/cancel`);
  });

  describe("when the messaging window has closed", () => {
    const closedButReviewable = review({ sendWindowOpen: false });

    it("explains that a fresh inbound message is required", () => {
      renderCard(closedButReviewable);

      expect(screen.getByText(CLOSED_WINDOW_MESSAGE)).toBeInTheDocument();
      expect(CLOSED_WINDOW_MESSAGE).toBe(
        "Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.",
      );
    });

    it("disables retry but keeps the local resolutions available", () => {
      renderCard(closedButReviewable);

      // A retry would have to send, and sending is impossible.
      expect(screen.getByRole("button", { name: "Retry unit" })).toBeDisabled();
      // Confirming is a local record of what Instagram already did, so it stands.
      expect(screen.getByRole("button", { name: "Already delivered" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel delivery" })).toBeEnabled();
    });
  });

  describe("when the server already sealed the delivery as window-closed", () => {
    const sealed = review({
      status: "failed",
      failureCode: "messaging_window_closed",
      sendWindowOpen: false,
    });

    it("withdraws both unit actions the server would now reject", () => {
      renderCard(sealed);

      expect(screen.getByText("Delivery failed")).toBeInTheDocument();
      expect(screen.getByText(CLOSED_WINDOW_MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry unit" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Already delivered" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel delivery" })).toBeEnabled();
    });
  });

  it("turns a stale-state rejection into owner guidance", async () => {
    apiCall.mockRejectedValueOnce(
      new ApiError(409, { error: "delivery_state_changed" }, "HTTP 409"),
    );
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Already delivered" }));

    expect(
      await screen.findByText(/changed while you were reviewing it/i),
    ).toBeInTheDocument();
  });

  it("reports a closed window rejection with the same exact copy", async () => {
    apiCall.mockRejectedValueOnce(
      new ApiError(409, { error: "messaging_window_closed" }, "HTTP 409"),
    );
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Already delivered" }));

    expect(await screen.findByText(CLOSED_WINDOW_MESSAGE)).toBeInTheDocument();
  });

  it("does not retry a rejected owner action on its own", async () => {
    apiCall.mockRejectedValue(new ApiError(500, { error: "internal" }, "HTTP 500"));
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Already delivered" }));

    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1));
    // Give any retry a chance to appear before asserting it never came.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiCall).toHaveBeenCalledTimes(1);
  });
});
