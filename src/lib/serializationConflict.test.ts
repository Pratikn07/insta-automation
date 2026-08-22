import { describe, expect, it } from "vitest";
import { isRetryableConflict } from "./serializationConflict.js";

/**
 * Exactly how Prisma surfaced the conflict that dropped an inbound DM in
 * production: the SQLSTATE is in the message and there is no `code` property at
 * all, which is why a `code === "P2034"` check missed it.
 */
const RAW_QUERY_FAILURE = new Error(
  "Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`",
);

describe("isRetryableConflict", () => {
  it("accepts Prisma's normalised serialization code", () => {
    expect(isRetryableConflict({ code: "P2034" })).toBe(true);
  });

  it("accepts Postgres' native serialization_failure as a code", () => {
    expect(isRetryableConflict({ code: "40001" })).toBe(true);
  });

  it("accepts deadlock_detected, which is retryable and arrives the same way", () => {
    expect(isRetryableConflict({ code: "40P01" })).toBe(true);
  });

  it("accepts a raw-query failure that carries 40001 only in its message", () => {
    expect(isRetryableConflict(RAW_QUERY_FAILURE)).toBe(true);
  });

  it("accepts the Postgres wording without the numeric code", () => {
    expect(
      isRetryableConflict(new Error("could not serialize access due to read/write dependencies")),
    ).toBe(true);
  });

  // ── Not retryable ───────────────────────────────────────────────────────

  it("rejects a unique-constraint violation, which is a different decision", () => {
    // P2002 means the row already exists. Callers that retry it must look up the
    // winner rather than repeat the write, so it must not classify as a conflict.
    expect(isRetryableConflict({ code: "P2002" })).toBe(false);
  });

  it("rejects an unrelated database error", () => {
    expect(isRetryableConflict(new Error("relation \"nope\" does not exist"))).toBe(false);
  });

  it("rejects an unrelated Prisma code", () => {
    expect(isRetryableConflict({ code: "P2025" })).toBe(false);
  });

  it("survives values that are not error objects", () => {
    expect(isRetryableConflict(null)).toBe(false);
    expect(isRetryableConflict(undefined)).toBe(false);
    expect(isRetryableConflict("could not serialize access")).toBe(false);
    expect(isRetryableConflict({})).toBe(false);
  });
});
