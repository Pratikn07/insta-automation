import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./TopBar", () => ({ TopBar: () => null }));

import { mobileNavigationOpen } from "./mobileNavigationState";

describe("mobileNavigationOpen", () => {
  it("stays open on the path where the menu was opened", () => {
    expect(mobileNavigationOpen("/content", "/content")).toBe(true);
  });

  it("closes as soon as navigation changes the current path", () => {
    expect(mobileNavigationOpen("/content", "/keywords")).toBe(false);
    expect(mobileNavigationOpen(null, "/content")).toBe(false);
  });
});
