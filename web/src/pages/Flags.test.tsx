// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "@/lib/types";

const apiRead = vi.fn();
const apiMutation = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));

const { Flags } = await import("./Flags");

function flag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "AI_DRAFTS_ENABLED",
    name: "Reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat: "Writes a suggested reply for each conversation waiting on you.",
    affectsWho: "Only you. A draft sits in Conversations until you approve it.",
    ifOff: "Suggestions stop appearing. You can still reply by hand.",
    pageMayEnable: true,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

const recovery = flag({
  key: "DM_RECOVERY_ENABLED",
  name: "Recovery reminders",
  group: "outbound",
  pageMayEnable: false,
  pageMayStop: true,
  doesWhat: "Leaves a public comment on the reel telling them to check their requests.",
  affectsWho: "People sent a guide who have not opened it.",
  ifOff: "No public reminders are posted.",
});

const workers = flag({
  key: "WORKERS_ENABLED",
  name: "Background jobs",
  group: "infrastructure",
  pageMayEnable: false,
  pageMayStop: false,
});

const rollout = flag({
  key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
  name: "Guide delivery rollout",
  group: "outbound",
  kind: "percent",
  valueBool: null,
  valuePercent: 45,
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Flags />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset().mockResolvedValue(flag({ valueBool: false }));
});

describe("Flags", () => {
  it("groups by what a flag touches, loudest first", async () => {
    apiRead.mockResolvedValue({ flags: [flag(), recovery, workers] });
    renderPage();

    const outbound = await screen.findByText("Reaches real people");
    const assistive = screen.getByText("Nothing leaves the app");
    const infra = screen.getByText("Not a product choice");

    expect(
      outbound.compareDocumentPosition(assistive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      assistive.compareDocumentPosition(infra) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("explains every flag in plain words, including what happens if it is off", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByText(/Writes a suggested reply/)).toBeInTheDocument();
    expect(screen.getByText(/A draft sits in Conversations/)).toBeInTheDocument();
    expect(screen.getByText(/Suggestions stop appearing/)).toBeInTheDocument();
  });

  it("offers a switch for a flag that may be turned both ways", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole("switch", { name: "Reply drafts" });
    await user.click(toggle);

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/flags/AI_DRAFTS_ENABLED", {
        method: "PATCH",
        body: JSON.stringify({ valueBool: false }),
      }),
    );
  });

  // The safety model, visible: a stop with no matching start.
  it("offers Stop now, and no way to start, for an outbound flag", async () => {
    apiRead.mockResolvedValue({ flags: [recovery] });
    const user = userEvent.setup();
    renderPage();

    const stop = await screen.findByRole("button", { name: "Stop Recovery reminders" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(stop);
    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/flags/DM_RECOVERY_ENABLED", {
        method: "PATCH",
        body: JSON.stringify({ valueBool: false }),
      }),
    );
  });

  it("offers no stop once an outbound flag is already off", async () => {
    apiRead.mockResolvedValue({ flags: [{ ...recovery, valueBool: false }] });
    renderPage();

    expect(await screen.findByText("Recovery reminders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("offers no control at all for a flag that cannot be changed", async () => {
    apiRead.mockResolvedValue({ flags: [workers] });
    renderPage();

    expect(await screen.findByText("Background jobs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/changed in Railway/)).toBeInTheDocument();
  });

  it("shows a percentage and saves a new one", async () => {
    apiRead.mockResolvedValue({ flags: [rollout] });
    renderPage();

    expect(await screen.findByText("45%")).toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: "Guide delivery rollout" });
    expect(slider).toHaveValue("45");
  });

  // A restart re-reads the environment, so a drifted value reverts silently.
  it("warns when a restart would revert the value", async () => {
    apiRead.mockResolvedValue({
      flags: [flag({ source: "override", valueBool: false, driftsFromEnv: true })],
    });
    renderPage();

    expect(await screen.findByText(/a restart would change this back/i)).toBeInTheDocument();
  });

  it("does not warn when the stored value agrees with the deployed one", async () => {
    apiRead.mockResolvedValue({ flags: [flag({ source: "override", driftsFromEnv: false })] });
    renderPage();

    expect(await screen.findByText("Reply drafts")).toBeInTheDocument();
    expect(screen.queryByText(/a restart would change this back/i)).not.toBeInTheDocument();
  });

  it("calls a failed read a connection problem, not an empty list", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
    expect(screen.queryByText("Reaches real people")).not.toBeInTheDocument();
  });
});
