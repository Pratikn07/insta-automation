import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("./logger.js", () => ({ logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { parseProviderTimestamp } = await import("./providerTime.js");

const RECEIVED_AT = new Date("2026-08-06T20:00:00.000Z");

beforeEach(() => warn.mockReset());

describe("parseProviderTimestamp", () => {
  it("accepts a plausible millisecond epoch", () => {
    const raw = Date.UTC(2026, 7, 6, 19, 0, 0);
    expect(parseProviderTimestamp(raw, RECEIVED_AT)).toEqual(new Date(raw));
    expect(warn).not.toHaveBeenCalled();
  });

  // Webhook JSON is untrusted, and recovery evidence keeps the EARLIEST
  // timestamp it has seen. A value that parses to 1970 would therefore pin a
  // row's seenAt to 1970 permanently, and no later correct event could fix it.
  it.each([
    ["a seconds epoch", 1786003200],
    ["zero", 0],
    ["a negative value", -1],
    ["far future", Date.UTC(2030, 0, 1)],
    ["undefined", undefined],
    ["null", null],
    ["a string", "1786003200000"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to receipt time for %s", (_label, raw) => {
    expect(parseProviderTimestamp(raw, RECEIVED_AT)).toEqual(RECEIVED_AT);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_timestamp_invalid" }),
      expect.any(String),
    );
  });

  it("allows a small amount of provider clock skew", () => {
    const slightlyAhead = RECEIVED_AT.getTime() + 60_000;
    expect(parseProviderTimestamp(slightlyAhead, RECEIVED_AT)).toEqual(new Date(slightlyAhead));
    expect(warn).not.toHaveBeenCalled();
  });

  it("never returns an Invalid Date", () => {
    for (const raw of [undefined, null, "x", Number.NaN, {}, []]) {
      expect(Number.isNaN(parseProviderTimestamp(raw, RECEIVED_AT).getTime())).toBe(false);
    }
  });
});
