// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_DESTINATIONS } from "@/lib/navigation";

vi.mock("@/components/layout/AppShell", () => ({ AppShell: () => <Outlet /> }));
vi.mock("@/pages/Home", () => ({ Home: () => null }));
vi.mock("@/pages/Content", () => ({ Content: () => null }));
vi.mock("@/pages/Keywords", () => ({ Keywords: () => null }));
vi.mock("@/pages/Sequences", () => ({ Sequences: () => null }));
vi.mock("@/pages/SequenceEditor", () => ({ SequenceEditor: () => null }));
vi.mock("@/pages/Conversations", () => ({ Conversations: () => null }));
vi.mock("@/pages/DmRecovery", () => ({ DmRecovery: () => null }));
vi.mock("@/pages/Assistant", () => ({ Assistant: () => null }));
vi.mock("@/pages/Activity", () => ({ Activity: () => null }));
vi.mock("@/pages/Insights", () => ({ Insights: () => null }));
vi.mock("@/pages/Funnels", () => ({ Funnels: () => null }));
vi.mock("@/pages/HistoricalRecovery", () => ({ HistoricalRecovery: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

async function renderRoute(initialEntry: string) {
  const { AppRoutes } = await import("./AppRoutes");
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("legacy routes", () => {
  it("preserves the People intent when redirecting /users", async () => {
    await renderRoute("/users");

    await waitFor(() =>
      expect(screen.getByLabelText("location")).toHaveTextContent(
        "/conversations?lens=people",
      ),
    );
  });

  it("preserves the old /reels bookmark as Content", async () => {
    await renderRoute("/reels");
    await waitFor(() =>
      expect(screen.getByLabelText("location")).toHaveTextContent("/content"),
    );
  });
});

describe("authenticated destinations", () => {
  it.each(NAV_DESTINATIONS)("matches $path for $label", async ({ path }) => {
    await renderRoute(path);
    expect(screen.getByLabelText("location")).toHaveTextContent(path);
  });

  it("matches sequence editor detail routes", async () => {
    await renderRoute("/sequences/sequence-1");
    expect(screen.getByLabelText("location")).toHaveTextContent("/sequences/sequence-1");
  });
});
