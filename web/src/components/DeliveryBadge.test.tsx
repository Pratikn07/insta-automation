// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryBadge } from "./DeliveryBadge";

afterEach(cleanup);

describe("DeliveryBadge", () => {
  it("labels a link guide", () => {
    render(<DeliveryBadge mode="link" />);
    expect(screen.getByText("Link")).toBeInTheDocument();
  });

  it("treats a missing mode as gated", () => {
    render(<DeliveryBadge mode={undefined} />);
    expect(screen.getByText("Gated")).toBeInTheDocument();
  });
});
