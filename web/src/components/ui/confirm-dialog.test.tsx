// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open confirmation</button>
      <ConfirmDialog
        open={open}
        title="Pause campaign?"
        description="This stops all running campaigns in the group."
        confirmLabel="Pause"
        onConfirm={vi.fn()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("labels the dialog, traps tab focus, and restores its trigger after Escape", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    trigger.focus();
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    const heading = screen.getByRole("heading", { name: "Pause campaign?" });
    const description = screen.getByText("This stops all running campaigns in the group.");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(dialog).toHaveAttribute("aria-describedby", description.id);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Pause" });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
