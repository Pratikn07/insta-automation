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

  /**
   * Above the grid, always, so a pending row is visible without scrolling.
   *
   * The earlier version put this below the grid, which read fine against a
   * four-tile fixture and left the whole feature ~50 rows down against a real
   * account of 197 posts.
   */
  it("puts the upcoming block before the grid in the document", async () => {
    renderContent();

    const heading = await screen.findByText("Set up in advance");
    const post = await screen.findByText("Already published");
    expect(heading.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The reason above-the-grid is affordable: with nothing pending it is one line,
  // not a section with a heading and a paragraph of explanation.
  it("costs one line when nothing is pending", async () => {
    upcomingItems = [];
    renderContent();

    await screen.findByRole("button", { name: "Set up its keyword in advance" });
    expect(screen.queryByText("Set up in advance")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Instagram doesn't let us see your scheduled queue/),
    ).not.toBeInTheDocument();
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

  /**
   * `/media/content` returns every post in one cached response, so the cost being
   * paged here is mounting them — 197 tiles is 197 images and 197 animated nodes
   * on first paint.
   */
  describe("paging the grid", () => {
    function manyPosts(count: number) {
      contentItems = Array.from({ length: count }, (_, i) => ({
        id: `media-${i}`,
        kind: i % 2 === 0 ? "reel" : "carousel",
        caption: `Post number ${i}`,
        thumbnailUrl: null,
        permalink: null,
        timestamp: "2026-08-10T17:30:00+0000",
      }));
    }

    it("mounts a first page and says how many there are in total", async () => {
      manyPosts(197);
      renderContent();

      expect(await screen.findByText("Showing 24 of 197")).toBeInTheDocument();
      expect(screen.getByText("Post number 0")).toBeInTheDocument();
      expect(screen.queryByText("Post number 24")).not.toBeInTheDocument();
    });

    it("shows more without losing what was already there", async () => {
      manyPosts(197);
      const user = userEvent.setup();
      renderContent();

      await user.click(await screen.findByRole("button", { name: "Show more" }));

      expect(await screen.findByText("Showing 48 of 197")).toBeInTheDocument();
      expect(screen.getByText("Post number 0")).toBeInTheDocument();
      expect(screen.getByText("Post number 24")).toBeInTheDocument();
    });

    it("offers no control once everything is mounted", async () => {
      manyPosts(10);
      renderContent();

      await screen.findByText("Post number 0");
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });

    // Carrying the count across filters would show 96 reels because you had
    // scrolled through 96 of everything.
    it("starts from the top again when the filter changes", async () => {
      manyPosts(197);
      const user = userEvent.setup();
      renderContent();

      await user.click(await screen.findByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Showing 48 of 197")).toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: /Reels/ }));

      expect(await screen.findByText("Showing 24 of 99")).toBeInTheDocument();
    });

    // The counts come from the whole list, never from the mounted slice.
    it("counts every post in the filters, not just the mounted ones", async () => {
      manyPosts(197);
      renderContent();

      expect(await screen.findByRole("tab", { name: /All\s*197/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Reels\s*99/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Carousels\s*98/ })).toBeInTheDocument();
    });
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
