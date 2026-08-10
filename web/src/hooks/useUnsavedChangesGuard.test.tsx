// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Link, createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

afterEach(cleanup);

function GuardHarness({ shouldBlock }: { shouldBlock: boolean }) {
  const blocker = useUnsavedChangesGuard(shouldBlock);

  return (
    <>
      <Link to="/away">Away</Link>
      {blocker.state === "blocked" ? (
        <>
          <button type="button" onClick={() => blocker.reset()}>
            Keep editing
          </button>
          <button type="button" onClick={() => blocker.proceed()}>
            Leave
          </button>
        </>
      ) : null}
    </>
  );
}

function renderGuard(shouldBlock: boolean) {
  const router = createMemoryRouter(
    [
      { path: "/editor", element: <GuardHarness shouldBlock={shouldBlock} /> },
      { path: "/away", element: <p>Away page</p> },
    ],
    { initialEntries: ["/editor"] },
  );
  render(<RouterProvider router={router} />);
}

function UnloadHarness() {
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesGuard(dirty);
  return (
    <button type="button" onClick={() => setDirty(true)}>
      Make dirty
    </button>
  );
}

function renderUnloadHarness() {
  const router = createMemoryRouter(
    [{ path: "/", element: <UnloadHarness /> }],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

describe("useUnsavedChangesGuard", () => {
  it("allows navigation when protection is off", async () => {
    const user = userEvent.setup();
    renderGuard(false);

    await user.click(screen.getByRole("link", { name: "Away" }));

    expect(await screen.findByText("Away page")).toBeInTheDocument();
  });

  it("blocks navigation until the author chooses whether to leave", async () => {
    const user = userEvent.setup();
    renderGuard(true);

    await user.click(screen.getByRole("link", { name: "Away" }));
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Away page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Away" }));
    await user.click(screen.getByRole("button", { name: "Leave" }));

    expect(await screen.findByText("Away page")).toBeInTheDocument();
  });

  it("prevents browser unload only while protection is on", async () => {
    const user = userEvent.setup();
    renderUnloadHarness();

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await user.click(screen.getByRole("button", { name: "Make dirty" }));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);

    expect(dirtyEvent.defaultPrevented).toBe(true);
  });
});
