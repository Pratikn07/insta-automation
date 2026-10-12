// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Resource } from "@/lib/types";

const apiMutation = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { LinkGuidePanel } = await import("./LinkGuidePanel");

const RESOURCE: Resource = {
  id: "res-1",
  name: "Halloween collection",
  description: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  deliveryMode: "link",
  linkUrl: "https://mycuratedhaven.com/halloween",
  linkButtonLabel: "Open the recipes",
  linkCardTitle: null,
  linkCardSubtitle: null,
};

function renderPanel(resource: Resource = RESOURCE) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinkGuidePanel resource={resource} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiMutation.mockReset().mockResolvedValue(RESOURCE));
afterEach(cleanup);

describe("LinkGuidePanel", () => {
  it("saves the link, switching the guide to Link in the same write", async () => {
    const user = userEvent.setup();
    renderPanel({ ...RESOURCE, deliveryMode: "gated", linkUrl: null });
    fireEvent.change(screen.getByPlaceholderText("https://mycuratedhaven.com/halloween"), {
      target: { value: "https://mycuratedhaven.com/thanksgiving" },
    });
    await user.click(screen.getByRole("button", { name: "Save link" }));

    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));
    const [path, options] = apiMutation.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/resources/res-1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/thanksgiving",
      linkButtonLabel: "Open the recipes",
      linkCardTitle: null,
      linkCardSubtitle: null,
    });
  });

  it("won't save an address that isn't https", () => {
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("https://mycuratedhaven.com/halloween"), {
      target: { value: "http://mycuratedhaven.com/halloween" },
    });
    expect(screen.getByRole("button", { name: "Save link" })).toBeDisabled();
  });

  it("previews the card with the guide name when no title is set", () => {
    renderPanel();
    const preview = screen.getByRole("complementary", { name: "Card preview" });
    expect(preview).toHaveTextContent("Halloween collection");
    expect(preview).toHaveTextContent("Open the recipes");
    expect(preview).toHaveTextContent("Follow @tinysoho");
  });
});
