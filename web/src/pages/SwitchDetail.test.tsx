// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "@/lib/types";

const apiRead = vi.fn();
const apiMutation = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));

const { SwitchDetail } = await import("./SwitchDetail");

function flag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Leaves a public comment telling them to check their requests.",
    affectsWho: "People sent a guide who have not opened it.",
    ifOff: "No public reminders are posted.",
    pageMayEnable: false,
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

function renderDetail(key = "DM_RECOVERY_ENABLED") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/switches/${key}`]}>
        <Routes>
          <Route path="/switches/:key" element={<SwitchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
// Block bodies: an arrow returning a mock hands vitest a teardown callback it then
// calls, which invokes the mock and turns a rejecting read into an unhandled error.
beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset().mockResolvedValue(flag({ valueBool: false }));
});

describe("SwitchDetail", () => {
  it("answers all three questions here, where there is room", async () => {
    apiRead.mockResolvedValue(flag());
    renderDetail();

    expect(await screen.findByText(/Leaves a public comment/)).toBeInTheDocument();
    expect(screen.getByText(/People sent a guide/)).toBeInTheDocument();
    expect(screen.getByText(/No public reminders are posted/)).toBeInTheDocument();
  });

  it("fetches the one switch by key rather than filtering a list", async () => {
    apiRead.mockResolvedValue(flag());
    renderDetail();

    await screen.findByText(/Leaves a public comment/);
    expect(apiRead).toHaveBeenCalledWith("/flags/DM_RECOVERY_ENABLED", expect.anything());
  });

  it("offers Stop now and no way to start, for an outbound switch", async () => {
    apiRead.mockResolvedValue(flag());
    const user = userEvent.setup();
    renderDetail();

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

  it("offers no stop once an outbound switch is already off", async () => {
    apiRead.mockResolvedValue(flag({ valueBool: false }));
    renderDetail();

    expect(await screen.findByText("Recovery reminders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("offers a two-way switch where the console may also start it", async () => {
    apiRead.mockResolvedValue(
      flag({
        key: "AI_DRAFTS_ENABLED",
        name: "Reply drafts",
        group: "assistive",
        pageMayEnable: true,
        pageMayStop: true,
      }),
    );
    const user = userEvent.setup();
    renderDetail("AI_DRAFTS_ENABLED");

    const toggle = await screen.findByRole("switch", { name: "Reply drafts" });
    await user.click(toggle);

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/flags/AI_DRAFTS_ENABLED", {
        method: "PATCH",
        body: JSON.stringify({ valueBool: false }),
      }),
    );
  });

  it("links back to the experiment it belongs to", async () => {
    apiRead.mockResolvedValue(
      flag({
        experimentKey: "recovery-reminder-timing",
        experimentName: "Recovery reminder timing",
      }),
    );
    renderDetail();

    expect(await screen.findByRole("link", { name: /Recovery reminder timing/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing",
    );
  });

  it("warns when a restart would revert the value", async () => {
    apiRead.mockResolvedValue(flag({ source: "override", driftsFromEnv: true }));
    renderDetail();

    expect(await screen.findByText(/a restart would change this back/i)).toBeInTheDocument();
  });

  it("does not warn when the stored value agrees with the deployed one", async () => {
    apiRead.mockResolvedValue(flag({ source: "override", driftsFromEnv: false }));
    renderDetail();

    expect(await screen.findByText("Recovery reminders")).toBeInTheDocument();
    expect(screen.queryByText(/a restart would change this back/i)).not.toBeInTheDocument();
  });

  it("says so plainly when the console cannot change it", async () => {
    apiRead.mockResolvedValue(
      flag({
        key: "WORKERS_ENABLED",
        name: "Background jobs",
        group: "infrastructure",
        pageMayEnable: false,
        pageMayStop: false,
      }),
    );
    renderDetail("WORKERS_ENABLED");

    expect(await screen.findByText(/changed in Railway/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  // A percentage the console may not move must show its value and no slider — the
  // stop-sending threshold is display-only because raising it tolerates more
  // failures.
  it("shows a locked percentage without a slider", async () => {
    apiRead.mockResolvedValue(
      flag({
        key: "DM_RECOVERY_FAILURE_RATE_PERCENT",
        name: "Stop-sending threshold",
        kind: "percent",
        valueBool: null,
        valuePercent: 50,
        pageMayEnable: false,
        pageMayStop: false,
      }),
    );
    renderDetail("DM_RECOVERY_FAILURE_RATE_PERCENT");

    // The value shares its line with where it came from, so this matches within.
    expect(await screen.findByText(/50% · from the deployed value/)).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("shows a movable percentage as a slider at its current value", async () => {
    apiRead.mockResolvedValue(
      flag({
        key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
        name: "Guide delivery rollout",
        kind: "percent",
        valueBool: null,
        valuePercent: 45,
        pageMayEnable: true,
        pageMayStop: true,
      }),
    );
    renderDetail("GUIDE_DELIVERY_ROLLOUT_PERCENT");

    const slider = await screen.findByRole("slider", { name: "Guide delivery rollout" });
    expect(slider).toHaveValue("45");
  });

  it("calls a failed read a connection problem, not a missing switch", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderDetail();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
