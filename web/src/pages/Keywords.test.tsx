// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const apiMutation = vi.fn();

/** Carries `status` and `body`, because the refusals are read from `body.error`. */
class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

vi.mock("../lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...args: unknown[]) => apiMutation(...args),
  ApiError,
  // Mirrors lib/api.ts: the code is a string at `body.error`, never parsed out of
  // the message.
  apiErrorCode: (error: unknown) =>
    error instanceof ApiError && error.body && typeof error.body === "object"
      ? ((error.body as { error?: unknown }).error as string | null) ?? null
      : null,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m) } }));

const { Keywords } = await import("./Keywords");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Keywords />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  apiMutation.mockReset();
  toastError.mockReset();
  api.mockReset().mockImplementation((path: string) =>
    Promise.resolve(
      path === "/keywords"
        ? [
            {
              id: "keyword-donut",
              keyword: "DONUT",
              mediaId: "18102152690212842",
              mediaCaption: "Donut recipe",
              mediaPermalink: null,
              mediaPostedAt: null,
              resourceId: "resource-1",
              publicReply: "Sent!",
              gateMessage: "Follow to get it",
              active: true,
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              resource: { id: "resource-1", name: "Donut guide", _count: { messages: 2 } },
            },
          ]
        : [],
    ),
  );
});

/**
 * Every refusal has to name what is holding the keyword and where to go instead.
 *
 * All of these previously reached the browser as a 500, which `apiMutation` reports
 * as an outcome nobody knows rather than an `ApiError` — so the page could only say
 * "Delete failed", with nothing about the record blocking it or the pause toggle that
 * retires the keyword without touching that record.
 */
describe("Keywords delete refusals", () => {
  async function attemptDelete() {
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Delete keyword" }))[0]!);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    return user;
  }

  function refusal(code: string) {
    return new ApiError(409, { error: code }, code);
  }

  it("names the guide that already reached someone", async () => {
    apiMutation.mockRejectedValue(refusal("keyword_has_delivery_history"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Someone has already been sent a guide through this keyword, so it is kept as a record. Pause it instead.",
      ),
    );
  });

  it("names the follow check when someone asked through it", async () => {
    apiMutation.mockRejectedValue(refusal("keyword_has_guide_access_history"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Someone has already asked for a guide through this keyword's follow check, so it is kept as a record. Pause it instead.",
      ),
    );
  });

  it("names the follow-up records", async () => {
    apiMutation.mockRejectedValue(refusal("keyword_has_recovery_history"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This keyword has follow-up records for people who never finished, so it is kept. Pause it instead.",
      ),
    );
  });

  // The one an owner actually meets: most keywords have been commented by someone.
  it("names the request history for a keyword people have commented", async () => {
    apiMutation.mockRejectedValue(refusal("keyword_has_journey_history"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "People have already commented this word, so what they asked for is kept as a record. Pause the keyword instead.",
      ),
    );
  });

  it("still points at pausing for a reference the server cannot name", async () => {
    apiMutation.mockRejectedValue(refusal("keyword_still_referenced"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Something still points at this keyword, so it can't be deleted. Pause it instead.",
      ),
    );
  });

  // An unknown outcome is not a refusal, and must not claim to name a cause.
  it("falls back to a retry when the outcome is unknown", async () => {
    apiMutation.mockRejectedValue(new Error("The result of /keywords/x is unknown."));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not delete this keyword. Check your connection and try again.",
      ),
    );
  });
});
