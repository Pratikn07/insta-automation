// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PresentationCategoryPicker } from "./PresentationCategoryPicker";
import type { PresentationCategory } from "./types";

const apiMutation = vi.fn();

vi.mock("@/lib/api", () => ({
  apiMutation: (...args: unknown[]) => apiMutation(...args),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const recipes: PresentationCategory = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "recipes",
  name: "Recipes",
  collectionLabel: "RECIPES",
  defaultKicker: "A LITTLE WIN AT THE TABLE",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "recipes_corner_table_v1",
  illustrationKey: "recipes_corner_bowl_v1",
  designStatus: "ready",
  nextEditionNumber: 1,
  sortOrder: 10,
  createdBy: "creator@tinysoho.com",
  updatedBy: "creator@tinysoho.com",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

const feedingTips: PresentationCategory = {
  ...recipes,
  id: "10000000-0000-4000-8000-000000000002",
  slug: "feeding-tips",
  name: "Feeding Tips",
  collectionLabel: "FEEDING",
  designStatus: "needs_review",
};

function renderPicker(onSelect = vi.fn()) {
  return { onSelect, ...render(<PresentationCategoryPicker categories={[recipes]} onSelect={onSelect} />) };
}

beforeEach(() => {
  apiMutation.mockReset();
});

afterEach(cleanup);

describe("PresentationCategoryPicker", () => {
  it("searches and selects ready categories with labelled combobox results", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.type(screen.getByRole("combobox", { name: "Presentation category" }), "recipe");
    await user.click(screen.getByRole("option", { name: /Recipes/ }));

    expect(onSelect).toHaveBeenCalledWith(recipes.id);
    expect(screen.getByRole("listbox", { name: "Presentation category results" })).toBeVisible();
  });

  it("adds a reusable needs-review category without making it publishable", async () => {
    const user = userEvent.setup();
    apiMutation.mockResolvedValue({ category: feedingTips, replayed: false });
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Add reusable category" }));
    await user.type(screen.getByRole("textbox", { name: "Category name" }), "Feeding Tips");
    await user.type(screen.getByRole("textbox", { name: "Collection label" }), "FEEDING");
    await user.type(
      screen.getByRole("textbox", { name: "Kicker" }),
      "A LITTLE WIN AT THE TABLE",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Visual family" }), "recipes");
    await user.click(screen.getByRole("button", { name: "Create reusable category" }));

    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));
    const [, request] = apiMutation.mock.calls[0] as [string, { body: string; operationId: string }];
    const payload = JSON.parse(request.body) as { id: string; basedOnCategorySlug: string };
    expect(payload.id).toBe(request.operationId);
    expect(payload.basedOnCategorySlug).toBe("recipes");
    expect(screen.getByText("Needs visual review")).toBeVisible();
    expect(screen.getByRole("option", { name: /Feeding Tips.*Needs visual review/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the create UUID for an uncertain retry", async () => {
    const user = userEvent.setup();
    apiMutation.mockRejectedValueOnce(new Error("request outcome unknown"));
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Add reusable category" }));
    await user.type(screen.getByRole("textbox", { name: "Category name" }), "Feeding Tips");
    await user.type(screen.getByRole("textbox", { name: "Collection label" }), "FEEDING");
    await user.type(
      screen.getByRole("textbox", { name: "Kicker" }),
      "A LITTLE WIN AT THE TABLE",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Visual family" }), "recipes");
    await user.click(screen.getByRole("button", { name: "Create reusable category" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not create category"));

    apiMutation.mockResolvedValueOnce({ category: feedingTips, replayed: true });
    await user.click(screen.getByRole("button", { name: "Create reusable category" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));

    const [, firstRequest] = apiMutation.mock.calls[0] as [string, { body: string; operationId: string }];
    const [, retryRequest] = apiMutation.mock.calls[1] as [string, { body: string; operationId: string }];
    expect(JSON.parse(firstRequest.body)).toEqual(
      expect.objectContaining({ id: firstRequest.operationId }),
    );
    expect(JSON.parse(retryRequest.body)).toEqual(
      expect.objectContaining({ id: firstRequest.operationId }),
    );
    expect(retryRequest.operationId).toBe(firstRequest.operationId);
  });
});
