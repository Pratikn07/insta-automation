import { describe, expect, it } from "vitest";
import {
  GUIDE_ACCESS_MAX_FOLLOW_CHECKS,
  GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
  GUIDE_ACCESS_WINDOW_MS,
} from "./guideAccessPolicy.js";

describe("guide access policy", () => {
  it("keeps the parent action window open for the complete 24-hour messaging window", () => {
    expect(GUIDE_ACCESS_WINDOW_MS).toBe(86_400_000);
  });

  it("keeps enough follow checks and responses for the reviewed recovery ladder", () => {
    expect(GUIDE_ACCESS_MAX_FOLLOW_CHECKS).toBe(5);
    expect(GUIDE_ACCESS_MAX_FOLLOW_RESPONSES).toBe(3);
  });
});
