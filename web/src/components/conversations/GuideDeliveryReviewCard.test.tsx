// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideDeliveryReview } from "@/lib/types";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    body: unknown;

    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.body = body;
      void status;
    }
  }

  return {
    ApiError,
    api: (...args: unknown[]) => api(...args),
    apiErrorCode: (error: unknown) => {
      if (!(error instanceof ApiError)) return null;
      if (typeof error.body !== "object" || error.body === null || !("error" in error.body)) {
        return null;
      }
      const code = (error.body as { error: unknown }).error;
      return typeof code === "string" ? code : null;
    },
  };
});

const { ApiError } = (await import("@/lib/api")) as unknown as {
  ApiError: new (status: number, body: unknown, message: string) => Error;
};
const { GuideDeliveryReviewCard } = await import("./GuideDeliveryReviewCard");

const CLOSED_WINDOW_MESSAGE =
  "Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.";

function makeReview(overrides: Partial<GuideDeliveryReview> = {}): GuideDeliveryReview {
  return {
    id: "delivery-1",
    status: "needs_review",
    confirmedUnits: 2,
    totalUnits: 4,
    sendWindowExpiresAt: "2026-08-09T12:00:00.000Z",
    sendWindowOpen: true,
    failureCode: "guide_unit_uncertain",
    units: [
      { id: "unit-sent-1", position: 0, kind: "text", status: "sent" },
      { id: "unit-sent-2", position: 1, kind: "file", status: "sent" },
      { id: "unit-3", position: 2, kind: "image", status: "uncertain" },
      { id: "unit-4", position: 3, kind: "file", status: "uncertain" },
    ],
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderCard(review: GuideDeliveryReview = makeReview()) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(queryClient, "invalidateQueries");
  return render(
    <QueryClientProvider client={queryClient}>
      <GuideDeliveryReviewCard threadId="thread-1" review={review} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  api.mockReset().mockResolvedValue(undefined);
});

describe("GuideDeliveryReviewCard", () => {
  it("shows only aggregate and one-based structural metadata for every uncertain unit", () => {
    const reviewWithPrivateFields = {
      ...makeReview(),
      textSnapshot: "PRIVATE-TEXT-SENTINEL",
      recipientIgUserId: "PRIVATE-RECIPIENT-SENTINEL",
      units: makeReview().units.map((unit) => ({
        ...unit,
        mediaUrlSnapshot: "PRIVATE-MEDIA-SENTINEL",
        providerMessageId: "PRIVATE-PROVIDER-SENTINEL",
        errorTraceId: "PRIVATE-TRACE-SENTINEL",
      })),
    } as unknown as GuideDeliveryReview;

    renderCard(reviewWithPrivateFields);

    expect(screen.getByRole("heading", { name: "Delivery needs review" })).toBeInTheDocument();
    expect(screen.getByText("2 of 4 messages confirmed")).toBeInTheDocument();
    expect(screen.getByText("Message 3 · Image")).toBeInTheDocument();
    expect(screen.getByText("Message 4 · File")).toBeInTheDocument();
    expect(screen.queryByText("Message 1 · Text")).not.toBeInTheDocument();
    for (const sentinel of [
      "PRIVATE-TEXT-SENTINEL",
      "PRIVATE-RECIPIENT-SENTINEL",
      "PRIVATE-MEDIA-SENTINEL",
      "PRIVATE-PROVIDER-SENTINEL",
      "PRIVATE-TRACE-SENTINEL",
    ]) {
      expect(document.body.textContent).not.toContain(sentinel);
    }
  });

  it("confirms the selected unit immediately and invalidates every conversations cache", async () => {
    renderCard();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Already delivered for message 3 (Image) in delivery delivery-1",
      }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/guide-deliveries/delivery-1/units/unit-3/confirm-delivered",
        { method: "POST" },
      ),
    );
    for (const queryKey of [["dm-thread", "thread-1"], ["dm-threads"], ["conversation-counts"]]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("does not retry until duplicate risk is confirmed, then sends the exact acknowledgement", async () => {
    renderCard();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Retry unit for message 4 (File) in delivery delivery-1",
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Retry message 4?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Instagram may already have delivered this message. Retrying can send a duplicate.",
    );
    expect(api).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Retry anyway" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/guide-deliveries/delivery-1/units/unit-4/retry",
        {
          method: "POST",
          body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
        },
      ),
    );
    for (const queryKey of [["dm-thread", "thread-1"], ["dm-threads"], ["conversation-counts"]]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("dismisses a retry warning without sending anything", async () => {
    renderCard();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Retry unit for message 3 (Image) in delivery delivery-1",
      }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Keep delivery as is",
      }),
    );

    expect(api).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("prevents duplicate actions and keeps a confirmed dialog busy until its request settles", async () => {
    let resolveRequest: (() => void) | undefined;
    api.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderCard();
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", {
        name: "Retry unit for message 3 (Image) in delivery delivery-1",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Retry message 3?" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retry anyway" }));

    expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Keep delivery as is" })).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Already delivered for message 4 (File) in delivery delivery-1",
      }),
    ).toBeDisabled();
    expect(api).toHaveBeenCalledTimes(1);

    resolveRequest?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the closed-window warning and blocks sends or incomplete local confirmation", () => {
    renderCard(makeReview({ sendWindowOpen: false }));

    expect(screen.getByText(CLOSED_WINDOW_MESSAGE)).toHaveTextContent(
      "Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.",
    );
    for (const label of [
      "Retry unit for message 3 (Image) in delivery delivery-1",
      "Retry unit for message 4 (File) in delivery delivery-1",
      "Already delivered for message 3 (Image) in delivery delivery-1",
      "Already delivered for message 4 (File) in delivery delivery-1",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("keeps last-unit local confirmation enabled after the send window closes", async () => {
    renderCard(makeReview({
      confirmedUnits: 2,
      totalUnits: 3,
      sendWindowOpen: false,
      units: [
        { id: "unit-1", position: 0, kind: "text", status: "sent" },
        { id: "unit-2", position: 1, kind: "image", status: "sent" },
        { id: "unit-3", position: 2, kind: "file", status: "uncertain" },
      ],
    }));

    const confirm = screen.getByRole("button", {
      name: "Already delivered for message 3 (File) in delivery delivery-1",
    });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/guide-deliveries/delivery-1/units/unit-3/confirm-delivered",
        { method: "POST" },
      ),
    );
  });

  it("keeps cancellation available after close but sends only after confirmation", async () => {
    renderCard(makeReview({ sendWindowOpen: false }));

    const cancel = screen.getByRole("button", {
      name: "Cancel delivery delivery-1",
    });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(api).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Cancel this delivery?" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel delivery" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/guide-deliveries/delivery-1/cancel", { method: "POST" }),
    );
    for (const queryKey of [["dm-thread", "thread-1"], ["dm-threads"], ["conversation-counts"]]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });

  it.each([
    ["delivery_not_found", "This delivery no longer exists. Refresh the conversation."],
    ["unit_not_found", "This message is no longer available for review. Refresh the conversation."],
    [
      "delivery_state_changed",
      "This delivery changed before the action completed. Refresh and review its latest status.",
    ],
    ["messaging_window_closed", CLOSED_WINDOW_MESSAGE],
    [
      "duplicate_risk_acknowledgement_required",
      "Confirm the duplicate-delivery risk before retrying this message.",
    ],
    ["unknown_private_code", "This action could not be completed. Refresh and try again."],
  ])("maps stable error %s to safe inline guidance", async (code, expected) => {
    api.mockRejectedValue(new ApiError(409, { error: code }, `RAW ${code}`));
    renderCard();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Already delivered for message 3 (Image) in delivery delivery-1",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(document.body.textContent).not.toContain(`RAW ${code}`);
  });

  it("shows mapped inline guidance and never a raw API error sentinel", async () => {
    api.mockRejectedValue(
      new ApiError(
        409,
        { error: "delivery_state_changed", detail: "PRIVATE-RESPONSE-SENTINEL" },
        "HTTP PRIVATE-MESSAGE-SENTINEL",
      ),
    );
    renderCard();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Already delivered for message 3 (Image) in delivery delivery-1",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This delivery changed before the action completed. Refresh and review its latest status.",
    );
    expect(document.body.textContent).not.toContain("PRIVATE-RESPONSE-SENTINEL");
    expect(document.body.textContent).not.toContain("PRIVATE-MESSAGE-SENTINEL");
  });
});
