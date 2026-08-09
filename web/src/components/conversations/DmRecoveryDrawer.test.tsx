// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryReminderDetail } from "../../lib/types";

const detail = vi.fn();
const cancel = vi.fn();
const markReviewed = vi.fn();

// The real module reads Supabase env at import time, so importOriginal() cannot
// run here. ApiError is declared inside the factory instead: the component and
// this file both resolve it through the mock, so they share one class object and
// `instanceof` behaves exactly as it does in the browser.
vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    recoveryApi: {
      detail: (id: string) => detail(id),
      cancel: (id: string) => cancel(id),
      markReviewed: (id: string) => markReviewed(id),
    },
  };
});

const { ApiError } = (await import("../../lib/api")) as unknown as {
  ApiError: new (status: number, message: string) => Error & { status: number };
};

const { DmRecoveryDrawer, RECOVERY_CONFLICT_MESSAGE } = await import("./DmRecoveryDrawer");

function makeDetail(overrides: Partial<RecoveryReminderDetail> = {}): RecoveryReminderDetail {
  return {
    id: "recovery-1",
    conversationId: "convo-1",
    igUserId: "ig-1",
    username: "sarah",
    name: "Sarah",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    media: { id: "media-1", permalink: "https://instagram.com/p/x", caption: "Sleep reel" },
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    acceptedAt: "2026-08-06T00:00:00.000Z",
    eligibleAt: "2026-08-06T10:00:00.000Z",
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: "2026-08-05T23:00:00.000Z",
    settingsEvidence: null,
    commentId: "comment-1",
    keywordSnapshot: "SLEEP",
    templateVersion: "v1",
    publicReplyId: null,
    trackingAvailable: true,
    comment: { text: "sleep", receivedAt: "2026-08-05T23:00:00.000Z" },
    timeline: [
      { kind: "created", at: "2026-08-05T23:00:00.000Z", detail: null },
      { kind: "accepted", at: "2026-08-06T00:00:00.000Z", detail: null },
      { kind: "eligible", at: "2026-08-06T10:00:00.000Z", detail: null },
    ],
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderDrawer(
  overrides: Partial<RecoveryReminderDetail> = {},
  handlers: { onClose?: () => void; onOpenUser?: (id: string) => void } = {},
) {
  detail.mockResolvedValue(makeDetail(overrides));
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(queryClient, "invalidateQueries");
  return render(
    <QueryClientProvider client={queryClient}>
      <DmRecoveryDrawer
        id="recovery-1"
        onClose={handlers.onClose ?? vi.fn()}
        onOpenUser={handlers.onOpenUser}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  detail.mockReset();
  cancel.mockReset().mockResolvedValue(undefined);
  markReviewed.mockReset().mockResolvedValue(undefined);
});

describe("DmRecoveryDrawer", () => {
  it("tells the story from the comment forward", async () => {
    renderDrawer();

    const comment = await screen.findByText(/“sleep”/);
    expect(comment).toBeInTheDocument();
    const body = document.body.textContent ?? "";
    expect(body.indexOf("Comment")).toBeLessThan(body.indexOf("Gate DM accepted"));
  });

  // The absence of a receipt is stated as the absence of a receipt.
  it("says no read confirmation was received, not that it is unread", async () => {
    renderDrawer({ seenAt: null, engagedAt: null });

    expect(await screen.findByText("No read confirmation received")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bUnread\b/);
  });

  it("shows read evidence when it exists", async () => {
    // The API builds the timeline from the same stored timestamps, so a row
    // with seenAt always carries a matching entry.
    renderDrawer({
      seenAt: "2026-08-06T09:00:00.000Z",
      timeline: [
        { kind: "created", at: "2026-08-05T23:00:00.000Z", detail: null },
        { kind: "accepted", at: "2026-08-06T00:00:00.000Z", detail: null },
        { kind: "seen", at: "2026-08-06T09:00:00.000Z", detail: null },
      ],
    });
    expect(await screen.findByText(/Seen/)).toBeInTheDocument();
    expect(screen.queryByText("No read confirmation received")).not.toBeInTheDocument();
  });

  it("shows the sanitized verification snapshot for settings-specific copy", async () => {
    renderDrawer({
      triggerKind: "settings_blocked",
      cohort: "not_applicable",
      settingsEvidence: {
        status: "current",
        verificationId: "10000000-0000-4000-8000-000000000017",
        version: "settings-proof-v1",
        graphCode: 10,
        graphSubcode: 12345,
        classifiedAt: "2026-08-06T09:00:00.000Z",
        verifiedAt: "2026-08-06T08:00:00.000Z",
        validUntil: "2099-08-06T08:00:00.000Z",
        apiVersion: "v23.0",
        evidenceReference: "meta-sandbox/settings-proof-v1",
        evidenceSha256: "a".repeat(64),
      },
    });

    expect(await screen.findByText("Verified settings evidence")).toBeInTheDocument();
    expect(screen.getAllByText(/settings-proof-v1/)).toHaveLength(2);
    expect(screen.getByText(/10:12345/)).toBeInTheDocument();
    expect(screen.getByText(/meta-sandbox\/settings-proof-v1/)).toBeInTheDocument();
  });

  it("warns when a legacy settings row has no verification evidence", async () => {
    renderDrawer({
      triggerKind: "settings_blocked",
      cohort: "not_applicable",
      settingsEvidence: {
        status: "missing",
        verificationId: null,
        version: null,
        graphCode: null,
        graphSubcode: null,
        classifiedAt: null,
        verifiedAt: null,
        validUntil: null,
        apiVersion: null,
        evidenceReference: null,
        evidenceSha256: null,
      },
    });

    expect(await screen.findByText(/Verification evidence missing/i)).toBeInTheDocument();
  });

  // There is deliberately no way to force a send from the dashboard: the policy
  // decides, and a human override would bypass every safety check behind it.
  it("offers no Send now control in any state", async () => {
    for (const status of ["waiting", "ready", "sent", "send_failed"] as const) {
      cleanup();
      renderDrawer({ status: status === "ready" ? "waiting" : status });
      await screen.findByRole("heading", { name: /@sarah/ });
      expect(screen.queryByRole("button", { name: /send now/i })).not.toBeInTheDocument();
    }
  });

  describe("cancelling", () => {
    it("asks for confirmation that names what cancelling can and cannot do", async () => {
      const user = userEvent.setup();
      renderDrawer();

      await user.click(await screen.findByRole("button", { name: "Cancel reminder" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(/prevent/i);
      expect(dialog).toHaveTextContent(/cannot remove a comment that has already been posted/i);
      expect(cancel).not.toHaveBeenCalled();
    });

    it("cancels and refreshes the list once confirmed", async () => {
      const user = userEvent.setup();
      renderDrawer();

      await user.click(await screen.findByRole("button", { name: "Cancel reminder" }));
      await user.click(await screen.findByRole("button", { name: "Yes, cancel it" }));

      await waitFor(() => expect(cancel).toHaveBeenCalledWith("recovery-1"));
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["recovery-reminders"] }),
      );
    });

    it("keeps the reminder when the dialog is dismissed", async () => {
      const user = userEvent.setup();
      renderDrawer();

      await user.click(await screen.findByRole("button", { name: "Cancel reminder" }));
      await user.click(await screen.findByRole("button", { name: "Keep reminder" }));

      expect(cancel).not.toHaveBeenCalled();
    });

    it.each(["sent", "sending", "send_uncertain", "cancelled"] as const)(
      "does not offer cancellation for %s",
      async (status) => {
        renderDrawer({ status, sentAt: status === "sent" ? "2026-08-06T10:00:30.000Z" : null });
        await screen.findByRole("heading", { name: /@sarah/ });
        expect(screen.queryByRole("button", { name: "Cancel reminder" })).not.toBeInTheDocument();
      },
    );
  });

  describe("review", () => {
    it.each(["send_failed", "send_uncertain", "tracking_unavailable"] as const)(
      "offers review for %s",
      async (status) => {
        const user = userEvent.setup();
        renderDrawer({ status });

        await user.click(await screen.findByRole("button", { name: "Mark reviewed" }));

        await waitFor(() => expect(markReviewed).toHaveBeenCalledWith("recovery-1"));
      },
    );

    it("does not offer review for a healthy row", async () => {
      renderDrawer({ status: "sent", sentAt: "2026-08-06T10:00:30.000Z" });
      await screen.findByRole("heading", { name: /@sarah/ });
      expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    });
  });

  // A 409 means the worker changed the row between load and click. Retrying
  // cannot succeed, so the owner is told the state moved and the stale view goes
  // away — rather than being offered a button that can only fail again.
  describe("losing a race with the worker", () => {
    it("explains the conflict and closes instead of offering a retry", async () => {
      const onClose = vi.fn();
      cancel.mockRejectedValue(new ApiError(409, "conflict"));
      renderDrawer({ status: "waiting" }, { onClose });

      await userEvent.click(await screen.findByRole("button", { name: /cancel reminder/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, cancel it/i }));

      expect(await screen.findByText(RECOVERY_CONFLICT_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
      await waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalled());
      await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
    });

    it("keeps a non-conflict failure retryable without closing", async () => {
      const onClose = vi.fn();
      cancel.mockRejectedValue(new ApiError(500, "boom"));
      renderDrawer({ status: "waiting" }, { onClose });

      await userEvent.click(await screen.findByRole("button", { name: /cancel reminder/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, cancel it/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t complete that action/i);
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      expect(screen.queryByText(RECOVERY_CONFLICT_MESSAGE)).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    // Raw provider text is never shown: a 409 body could carry anything.
    it("never renders the server's error text", async () => {
      cancel.mockRejectedValue(new ApiError(500, "PGRST-INTERNAL-SENTINEL"));
      renderDrawer({ status: "waiting" });

      await userEvent.click(await screen.findByRole("button", { name: /cancel reminder/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, cancel it/i }));

      await screen.findByRole("alert");
      expect(document.body.textContent).not.toContain("PGRST-INTERNAL-SENTINEL");
    });
  });

  it("offers the user journey when the page can show one", async () => {
    const onOpenUser = vi.fn();
    renderDrawer({}, { onOpenUser });

    await userEvent.click(await screen.findByRole("button", { name: /view user journey/i }));

    expect(onOpenUser).toHaveBeenCalledWith("ig-1");
  });

  // Silently dropping the link left no way to tell "there is no post" from "we
  // failed to render one".
  it("says the original post is unavailable rather than omitting it", async () => {
    renderDrawer({ media: { id: null, permalink: null, caption: null } });

    expect(await screen.findByText(/original post unavailable/i)).toBeInTheDocument();
  });
});
