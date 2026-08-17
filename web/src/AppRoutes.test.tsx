// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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

describe("legacy routes", () => {
  it("preserves the People intent when redirecting /users", async () => {
    const { AppRoutes } = await import("./AppRoutes");
    render(
      <MemoryRouter initialEntries={["/users"]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("location")).toHaveTextContent(
        "/conversations?lens=people",
      ),
    );
  });
});
