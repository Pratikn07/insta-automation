// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRead = vi.fn();
const apiMutation = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...args: unknown[]) => apiRead(...args),
  apiMutation: (...args: unknown[]) => apiMutation(...args),
  ApiError: class ApiError extends Error {},
}));

const { Content } = await import("./Content");

const resource = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "High-chair guide",
  description: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  _count: { messages: 3, keywords: 0 },
};

const setup = {
  id: "setup-1",
  triggerWord: "HIGHCHAIR",
  resourceId: resource.id,
  publicReply: "Sent!",
  gateMessage: "Follow and reply DONE.",
  active: true,
  status: "waiting",
  matchedMediaId: null,
  keywordId: null,
  errorCode: null,
  createdBy: "owner@example.com",
  lastAttemptAt: null,
  retriedAt: null,
  boundAt: null,
  cancelledAt: null,
  createdAt: "2026-08-16T18:00:00.000Z",
  updatedAt: "2026-08-16T18:00:00.000Z",
  resource: { id: resource.id, name: resource.name, _count: { messages: 3 } },
};

let contentItems: unknown[];
let keywords: unknown[];
let upcomingItems: unknown[];

function renderContent() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Content />
      </QueryClientProvider>,
    ),
  };
}

afterEach(cleanup);

beforeEach(() => {
  contentItems = [
    {
      id: "published-1",
      kind: "reel",
      caption: "Already published",
      thumbnailUrl: null,
      permalink: null,
      timestamp: "2026-08-10T17:30:00+0000",
    },
  ];
  keywords = [];
  upcomingItems = [setup];
  apiRead.mockReset().mockImplementation((path: string) => {
    if (path === "/media/content") {
      return Promise.resolve({ items: contentItems, nextCursor: null });
    }
    if (path === "/keywords") return Promise.resolve(keywords);
    if (path === "/resources") return Promise.resolve([resource]);
    if (path === "/upcoming-automations") {
      return Promise.resolve({ automations: upcomingItems, discoveryEnabled: true });
    }
    return Promise.resolve({});
  });
  apiMutation.mockReset().mockResolvedValue(setup);
});

describe("Content", () => {
  it("shows the published grid and the upcoming setups together, with no view tabs", async () => {
    renderContent();

    expect(await screen.findByText("Already published")).toBeInTheDocument();
    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText("Set up in advance")).toBeInTheDocument();

    // The Published/Upcoming pair is gone. All/Reels/Carousels is a filter on the
    // grid, not a choice of what the page is, so it stays.
    expect(screen.queryByRole("tab", { name: "Published" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Upcoming" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All/ })).toBeInTheDocument();
  });

  // The grid is the page's subject. Putting a handful of pending setups above 147
  // posts would invert that on every visit.
  it("puts the grid before the upcoming block in the document", async () => {
    renderContent();

    const post = await screen.findByText("Already published");
    const heading = await screen.findByText("Set up in advance");
    expect(post.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Content has no header action: the only route to a keyword is tile → drawer →
  // Attach keyword, which needs a post that exists. If the block vanished when
  // empty, the first upcoming setup would be unreachable.
  it("keeps the upcoming entry point reachable when nothing is pending", async () => {
    upcomingItems = [];
    const user = userEvent.setup();
    renderContent();

    await screen.findByText("Already published");
    const door = await screen.findByRole("button", { name: "Set up its keyword in advance" });

    await user.click(door);
    expect(screen.getByLabelText("Keyword")).toBeInTheDocument();
  });

  it("replaces a bound setup with the real published card and attached keyword", async () => {
    const user = userEvent.setup();
    const { client } = renderContent();

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();

    // What the worker does: the setup resolves, and the post it bound to arrives
    // in the grid carrying an ordinary keyword.
    upcomingItems = [];
    contentItems = [
      {
        id: "scheduled-reel-1",
        kind: "reel",
        caption: "Scheduled high chair post. Comment HIGHCHAIR",
        thumbnailUrl: null,
        permalink: "https://www.instagram.com/reel/example/",
        timestamp: "2026-08-27T17:30:00+0000",
      },
    ];
    keywords = [
      {
        id: "keyword-1",
        keyword: "HIGHCHAIR",
        mediaId: "scheduled-reel-1",
        mediaCaption: "Scheduled high chair post. Comment HIGHCHAIR",
        mediaPermalink: "https://www.instagram.com/reel/example/",
        mediaPostedAt: "2026-08-27T17:30:00.000Z",
        resourceId: resource.id,
        publicReply: "Sent!",
        gateMessage: "Follow and reply DONE.",
        active: true,
        createdAt: "2026-08-27T17:30:00.000Z",
        updatedAt: "2026-08-27T17:30:00.000Z",
        resource: { id: resource.id, name: resource.name, _count: { messages: 3 } },
      },
    ];
    client.setQueryData(["upcoming-automations"], {
      automations: upcomingItems,
      discoveryEnabled: true,
    });
    client.setQueryData(["content"], { items: contentItems, nextCursor: null });
    client.setQueryData(["keywords"], keywords);

    // No tab to click now: the setup leaves the list and the post appears in the
    // grid on the same screen.
    await waitFor(() => expect(screen.queryByText("HIGHCHAIR")).not.toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: /Scheduled high chair post/ }));

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText(/High-chair guide/)).toBeInTheDocument();
  });
});
