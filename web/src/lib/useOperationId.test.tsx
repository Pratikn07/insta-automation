// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useOperationId } from "./useOperationId";

afterEach(cleanup);

function Probe() {
  const { operationId, renew } = useOperationId();
  return (
    <>
      <output aria-label="id">{operationId}</output>
      <button type="button" onClick={renew}>
        Renew
      </button>
      <button type="button" onClick={() => undefined}>
        Rerender
      </button>
    </>
  );
}

describe("useOperationId", () => {
  it("keeps one ID across re-renders so a retry replays instead of duplicating", async () => {
    render(<Probe />);
    const first = screen.getByLabelText("id").textContent;

    // Any interaction re-renders. The key must survive that, because the second
    // attempt after an unknown outcome has to carry the first attempt's identity.
    await userEvent.click(screen.getByRole("button", { name: "Rerender" }));

    expect(screen.getByLabelText("id").textContent).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("issues a fresh ID only when the intent is genuinely new", async () => {
    render(<Probe />);
    const first = screen.getByLabelText("id").textContent;

    await userEvent.click(screen.getByRole("button", { name: "Renew" }));

    expect(screen.getByLabelText("id").textContent).not.toBe(first);
  });
});
