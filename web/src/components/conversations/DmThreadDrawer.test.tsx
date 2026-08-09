// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DmThreadDetail } from "@/lib/types";

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

const { DmThreadDrawer } = await import("./DmThreadDrawer");
const { ConfirmDialog } = await import("@/components/ui/confirm-dialog");
const { Drawer } = await import("@/components/ui/drawer");

const detail: DmThreadDetail = {
  id: "thread-escape",
  igUserId: "ig-escape",
  username: "geri",
  name: "Geri",
  needsReply: false,
  latestInboundMessageId: "message-inbound",
  lastMessageAt: "2026-08-09T10:00:00.000Z",
  messages: [{
    id: "message-inbound",
    direction: "inbound",
    text: "Can you help?",
    type: "text",
    source: "instagram",
    mediaUrl: null,
    instagramTimestamp: "2026-08-09T10:00:00.000Z",
  }],
  draft: null,
  deliveryReviews: [{
    id: "delivery-escape",
    status: "needs_review",
    confirmedUnits: 0,
    totalUnits: 1,
    sendWindowExpiresAt: "2026-08-10T10:00:00.000Z",
    sendWindowOpen: true,
    failureCode: "guide_unit_uncertain",
    units: [{ id: "unit-escape", position: 0, kind: "text", status: "uncertain" }],
  }],
};

const onDrawerClose = vi.fn();

function renderThreadDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Harness() {
    const [threadId, setThreadId] = useState<string | null>(detail.id);
    return (
      <DmThreadDrawer
        threadId={threadId}
        sendEnabled
        onClose={() => {
          onDrawerClose();
          setThreadId(null);
        }}
      />
    );
  }

  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const dialogCases = [
  {
    kind: "retry",
    openName: "Retry unit for message 1 (Text) in delivery delivery-escape",
    title: "Retry message 1?",
    confirmName: "Retry anyway",
    mutationPath: "/guide-deliveries/delivery-escape/units/unit-escape/retry",
  },
  {
    kind: "cancel",
    openName: "Cancel delivery delivery-escape",
    title: "Cancel this delivery?",
    confirmName: "Cancel delivery",
    mutationPath: "/guide-deliveries/delivery-escape/cancel",
  },
] as const;

afterEach(cleanup);

beforeEach(() => {
  onDrawerClose.mockReset();
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/dm-threads/thread-escape") return Promise.resolve(detail);
    return Promise.resolve(undefined);
  });
});

describe("DmThreadDrawer confirmation Escape exclusivity", () => {
  it.each(dialogCases)(
    "idle Escape closes only the $kind confirmation and leaves its drawer open",
    async ({ openName, title }) => {
      const user = userEvent.setup();
      renderThreadDrawer();
      await screen.findByRole("heading", { name: "@geri" });

      await user.click(screen.getByRole("button", { name: openName }));
      expect(screen.getAllByRole("dialog")).toHaveLength(2);
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "@geri" })).toBeInTheDocument();
      expect(onDrawerClose).not.toHaveBeenCalled();
    },
  );

  it.each(dialogCases)(
    "pending Escape leaves both the $kind confirmation and its drawer open",
    async ({ openName, title, confirmName, mutationPath }) => {
      api.mockImplementation((path: string) => {
        if (path === "/dm-threads/thread-escape") return Promise.resolve(detail);
        return new Promise<void>(() => undefined);
      });
      const user = userEvent.setup();
      renderThreadDrawer();
      await screen.findByRole("heading", { name: "@geri" });

      await user.click(screen.getByRole("button", { name: openName }));
      const confirmation = screen
        .getByRole("heading", { name: title })
        .closest("[role=dialog]") as HTMLElement | null;
      expect(confirmation).not.toBeNull();
      await user.click(within(confirmation!).getByRole("button", { name: confirmName }));
      await waitFor(() =>
        expect(api.mock.calls.some(([path]) => path === mutationPath)).toBe(true),
      );

      await user.keyboard("{Escape}");

      expect(screen.getAllByRole("dialog")).toHaveLength(2);
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "@geri" })).toBeInTheDocument();
      expect(onDrawerClose).not.toHaveBeenCalled();
    },
  );
});

describe("standalone Escape behavior", () => {
  it("still closes a standalone confirmation dialog", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          open={open}
          title="Standalone confirmation"
          onConfirm={vi.fn()}
          onCancel={() => setOpen(false)}
        />
      );
    }
    render(<Harness />);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("still closes a drawer when no confirmation is open", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Drawer open={open} onClose={() => setOpen(false)} title="Standalone drawer">
          Drawer content
        </Drawer>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("dialog", { name: "Standalone drawer" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
