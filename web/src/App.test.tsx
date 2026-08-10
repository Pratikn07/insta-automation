// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";
import { Link, Outlet, useBlocker } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } }, loading: false }),
}));

vi.mock("@/components/layout/AppShell", () => ({ AppShell: () => <Outlet /> }));
vi.mock("@/pages/Home", () => ({ Home: () => <p>Home page</p> }));
vi.mock("@/pages/Content", () => ({ Content: () => <p>Content page</p> }));
vi.mock("@/pages/Keywords", () => ({ Keywords: () => <p>Keywords page</p> }));
vi.mock("@/pages/Sequences", () => ({ Sequences: () => <p>Sequences page</p> }));
vi.mock("@/pages/Conversations", () => ({ Conversations: () => <p>Conversations page</p> }));
vi.mock("@/pages/Assistant", () => ({ Assistant: () => <p>Assistant page</p> }));
vi.mock("@/pages/Activity", () => ({ Activity: () => <p>Activity page</p> }));
vi.mock("@/pages/Users", () => ({ Users: () => <p>Users page</p> }));
vi.mock("@/pages/Insights", () => ({ Insights: () => <p>Insights page</p> }));
vi.mock("@/pages/HistoricalRecovery", () => ({
  HistoricalRecovery: () => <p>Recovery page</p>,
}));
vi.mock("@/pages/Login", () => ({ Login: () => <p>Login page</p> }));

vi.mock("@/pages/SequenceEditor", () => ({
  SequenceEditor: () => {
    const blocker = useBlocker(true);
    return (
      <>
        <p>Sequence editor page</p>
        <Link to="/sequences">Back to sequences</Link>
        {blocker.state === "blocked" ? <p>Navigation blocked</p> : null}
      </>
    );
  },
}));

class TestErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {}

  render() {
    return this.state.failed ? <p>Router does not support blockers</p> : this.props.children;
  }
}

window.history.replaceState({}, "", "/sequences/resource-1");
const { default: App } = await import("./App");

afterEach(cleanup);
afterAll(() => window.history.replaceState({}, "", "/"));

describe("App router", () => {
  it("supports navigation blockers used by authored sequence drafts", async () => {
    const user = userEvent.setup();
    render(
      <TestErrorBoundary>
        <App />
      </TestErrorBoundary>,
    );

    expect(await screen.findByText("Sequence editor page")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to sequences" }));

    expect(screen.getByText("Navigation blocked")).toBeInTheDocument();
    expect(screen.queryByText("Sequences page")).not.toBeInTheDocument();
  });
});
