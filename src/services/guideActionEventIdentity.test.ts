import { describe, expect, it } from "vitest";
import { guidePostbackEventId } from "./guideActionEventIdentity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("guide action event identity", () => {
  it("derives one stable UUID for repeated delivery of the same postback", () => {
    expect(guidePostbackEventId("mid-123")).toBe(guidePostbackEventId("mid-123"));
    expect(guidePostbackEventId("mid-123")).toMatch(UUID_RE);
  });

  it("separates distinct parent taps even when they carry the same action token", () => {
    expect(guidePostbackEventId("tap-1")).not.toBe(guidePostbackEventId("tap-2"));
  });

  it("does not embed the private provider identifier", () => {
    expect(guidePostbackEventId("private-provider-mid")).not.toContain(
      "private-provider-mid",
    );
  });
});
