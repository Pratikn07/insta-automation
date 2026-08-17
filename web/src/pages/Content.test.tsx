// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

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
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
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
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/media/content") return Promise.resolve({ items: contentItems, nextCursor: null });
    if (path === "/keywords") return Promise.resolve(keywords);
    if (path === "/resources") return Promise.resolve([resource]);
    if (path === "/upcoming-automations") {
      return Promise.resolve({ automations: upcomingItems, discoveryEnabled: true });
    }
    return Promise.resolve({});
  });
});

describe("Content Published and Upcoming views", () => {
  it("keeps Published as the default and opens the local Upcoming setup view", async () => {
    const user = userEvent.setup();
    renderContent();

    expect(await screen.findByText("Already published")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Published" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Upcoming" }));

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText(/Instagram does not provide scheduled previews/)).toBeInTheDocument();
    expect(screen.queryByText("Already published")).not.toBeInTheDocument();
  });

  it("replaces a bound setup with the real published card and attached keyword", async () => {
    const user = userEvent.setup();
    const { client } = renderContent();

    await user.click(await screen.findByRole("tab", { name: "Upcoming" }));
    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();

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

    await waitFor(() => expect(screen.queryByText("HIGHCHAIR")).not.toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Published" }));
    await user.click(await screen.findByRole("button", { name: /Scheduled high chair post/ }));

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText(/High-chair guide/)).toBeInTheDocument();
  });
});
