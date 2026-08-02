import { describe, expect, it } from "vitest";
import { mediaTimestamp } from "./mediaTimestamp.js";

/**
 * The Instagram Graph API returns timestamps with a NUMERIC UTC offset and no
 * colon — "2026-08-02T20:00:02+0000" — verified live against
 * GET /{ig-user-id}/media on 2026-08-02. Zod's plain `.datetime()` only accepts
 * a "Z" suffix, so it rejected every real post timestamp the UI forwarded and
 * the keyword form failed with "mediaPostedAt: Invalid datetime".
 *
 * These cases lock the accepted shape to what Meta actually sends, while
 * keeping genuinely malformed input rejected.
 */
describe("mediaTimestamp", () => {
  it("accepts the Instagram Graph API's numeric-offset format", () => {
    // The exact string shape returned by the live media endpoint.
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02+0000").success).toBe(true);
  });

  it("accepts a non-UTC numeric offset", () => {
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02-0700").success).toBe(true);
  });

  it("accepts RFC3339 offsets with a colon", () => {
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02+00:00").success).toBe(true);
  });

  it("still accepts the plain Z form our own snapshots emit", () => {
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02Z").success).toBe(true);
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02.000Z").success).toBe(true);
  });

  it("rejects a timestamp with no zone, so an ambiguous local time can't be stored", () => {
    expect(mediaTimestamp.safeParse("2026-08-02T20:00:02").success).toBe(false);
  });

  it("rejects dates, empty strings, and garbage", () => {
    expect(mediaTimestamp.safeParse("2026-08-02").success).toBe(false);
    expect(mediaTimestamp.safeParse("").success).toBe(false);
    expect(mediaTimestamp.safeParse("not a date").success).toBe(false);
    expect(mediaTimestamp.safeParse("2026-13-45T99:99:99Z").success).toBe(false);
  });

  it("is nullable and optional, since a post can lack a timestamp", () => {
    expect(mediaTimestamp.safeParse(null).success).toBe(true);
    expect(mediaTimestamp.safeParse(undefined).success).toBe(true);
  });

  it("produces a value new Date() converts to the correct instant", () => {
    // The route does `new Date(value)` before writing to Postgres, so the
    // accepted string must survive that conversion with the offset honored.
    const parsed = mediaTimestamp.parse("2026-08-02T20:00:02-0700");
    expect(new Date(parsed as string).toISOString()).toBe("2026-08-03T03:00:02.000Z");
  });
});
