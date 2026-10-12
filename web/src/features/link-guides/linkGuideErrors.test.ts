import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { linkSaveError } from "./linkGuideErrors";

describe("linkSaveError", () => {
  it("names the rule a rejected link broke", () => {
    expect(linkSaveError(new ApiError(400, { error: "link_url_host_not_allowed" }, "Bad Request"))).toBe(
      "That site isn't on the allowed list.",
    );
    expect(linkSaveError(new ApiError(400, { error: "link_button_label_too_long" }, "Bad Request"))).toBe(
      "Button text can be up to 20 characters.",
    );
  });

  it("falls back to a plain retry message", () => {
    expect(linkSaveError(new Error("offline"))).toBe(
      "Couldn't save the link. Check your connection and try again.",
    );
  });
});
