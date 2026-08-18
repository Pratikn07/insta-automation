// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => api(...a),
}));
vi.mock("@/components/ai/AiConnectionCard", () => ({
  AiConnectionCard: () => <div data-testid="connection-card" />,
}));

const { Assistant } = await import("./Assistant");

const CONNECTION = {
  connected: true,
  requiresOpenaiAuth: true,
  account: { email: "owner@example.com", planType: "plus" },
  rateLimits: null,
};

const ANSWER = {
  answer: "Reply rate is the thing to fix first.",
  recommendation: "Clear the needs-reply queue this week.",
  evidence: [{ label: "Needs reply", value: "3 threads", href: "/conversations" }],
  confidence: "medium",
  nextStep: "Open Conversations.",
  nextStepHref: "/conversations",
  dataGaps: [],
};

class ApiError extends Error {
  body: unknown;
  status: number;
  constructor(status: number, body: unknown) {
    super("api error");
    this.status = status;
    this.body = body;
  }
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    // An answer renders its next-step as a router Link, so the page needs a router.
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Assistant />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function askCalls() {
  return api.mock.calls.filter(([path]) => String(path) === "/ai/advisor/messages");
}

function bodyOf(call: unknown[]) {
  return JSON.parse(String((call[1] as { body?: string }).body));
}

beforeEach(() => {
  // jsdom does not implement it, and the page scrolls to the newest turn.
  Element.prototype.scrollIntoView = vi.fn();
  api.mockReset().mockImplementation((path: string) => {
    const p = String(path);
    if (p === "/ai/connection") return Promise.resolve(CONNECTION);
    if (p === "/ai/advisor/history") return Promise.resolve({ items: [] });
    return Promise.resolve(ANSWER);
  });
});

afterEach(cleanup);

/**
 * A model turn is the most expensive thing in the console to duplicate: it spends
 * quota and puts the owner's question in their history twice. So the question's key
 * has to outlive a failed attempt.
 */
describe("Assistant question identity", () => {
  async function typeQuestion(text = "What should I focus on?") {
    renderPage();
    const box = await waitFor(() =>
      screen.getByPlaceholderText("What should I focus on this week?"),
    );
    fireEvent.change(box, { target: { value: text } });
    return box;
  }

  function submit() {
    fireEvent.click(screen.getByRole("button", { name: /Ask|Send/i }));
  }

  it("sends the question with a client message id", async () => {
    await typeQuestion();

    submit();

    await waitFor(() => expect(askCalls().length).toBe(1));
    const body = bodyOf(askCalls()[0]);
    expect(body.message).toBe("What should I focus on?");
    expect(body.clientMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("reuses the same id when the same question is asked again after a failure", async () => {
    api.mockImplementation((path: string) => {
      const p = String(path);
      if (p === "/ai/connection") return Promise.resolve(CONNECTION);
      if (p === "/ai/advisor/history") return Promise.resolve({ items: [] });
      return Promise.reject(new ApiError(409, { error: "advisor_outcome_pending" }));
    });
    await typeQuestion();

    submit();
    await waitFor(() => expect(askCalls().length).toBe(1));
    const first = bodyOf(askCalls()[0]).clientMessageId;

    submit();
    await waitFor(() => expect(askCalls().length).toBe(2));

    // Same question, same key: the runtime recognises the replay rather than
    // starting a second turn.
    expect(bodyOf(askCalls()[1]).clientMessageId).toBe(first);
  });

  it("issues a new id once the question itself changes", async () => {
    api.mockImplementation((path: string) => {
      const p = String(path);
      if (p === "/ai/connection") return Promise.resolve(CONNECTION);
      if (p === "/ai/advisor/history") return Promise.resolve({ items: [] });
      return Promise.reject(new ApiError(503, { error: "runtime_unavailable" }));
    });
    const box = await typeQuestion();

    submit();
    await waitFor(() => expect(askCalls().length).toBe(1));
    const first = bodyOf(askCalls()[0]).clientMessageId;

    fireEvent.change(box, { target: { value: "A different question entirely" } });
    submit();
    await waitFor(() => expect(askCalls().length).toBe(2));

    expect(bodyOf(askCalls()[1]).clientMessageId).not.toBe(first);
  });

  it("issues a new id for the next question after one is answered", async () => {
    await typeQuestion();

    submit();
    await waitFor(() => expect(askCalls().length).toBe(1));
    const first = bodyOf(askCalls()[0]).clientMessageId;

    // Success clears the composer, so an empty box is the observable signal that
    // the turn was recorded. Re-query rather than holding a stale reference.
    await waitFor(() =>
      expect(screen.getByPlaceholderText("What should I focus on this week?")).toHaveValue(""),
    );
    const box = screen.getByPlaceholderText("What should I focus on this week?");
    fireEvent.change(box, { target: { value: "What should I focus on?" } });
    submit();
    await waitFor(() => expect(askCalls().length).toBe(2));

    // Same text, but the first one was answered, so this is a new question.
    expect(bodyOf(askCalls()[1]).clientMessageId).not.toBe(first);
  });

  it("explains a pending outcome without telling the owner to ask again", async () => {
    api.mockImplementation((path: string) => {
      const p = String(path);
      if (p === "/ai/connection") return Promise.resolve(CONNECTION);
      if (p === "/ai/advisor/history") return Promise.resolve({ items: [] });
      return Promise.reject(new ApiError(409, { error: "advisor_outcome_pending" }));
    });
    await typeQuestion();

    submit();

    expect(await screen.findByText(/still being answered/i)).toBeInTheDocument();
  });
});
