import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  decodeRecoveryCursor,
  encodeRecoveryCursor,
  type RecoveryCursorScope,
} from "./recoveryRemindersCursor.js";

const SCOPE: RecoveryCursorScope = {
  id: "10000000-0000-4000-8000-000000000001",
  from: "2026-08-01",
  to: "2026-08-16",
  asOf: "2026-08-17T03:00:00.000Z",
};

function tokenFor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("recovery reminder scoped cursor", () => {
  it("round-trips a versioned cursor bound to its range and asOf", () => {
    expect(decodeRecoveryCursor(encodeRecoveryCursor(SCOPE), SCOPE)).toEqual(SCOPE);
  });

  it.each([
    ["malformed base64url", "***"],
    ["invalid JSON", Buffer.from("not-json", "utf8").toString("base64url")],
    ["an invalid UUID", tokenFor({ v: 1, ...SCOPE, id: "not-a-uuid" })],
    ["an impossible from day", tokenFor({ v: 1, ...SCOPE, from: "2026-02-30" })],
    ["an invalid to day", tokenFor({ v: 1, ...SCOPE, to: "08/16/2026" })],
    ["an invalid asOf", tokenFor({ v: 1, ...SCOPE, asOf: "yesterday" })],
    ["an unsupported version", tokenFor({ v: 2, ...SCOPE })],
  ])("rejects %s", (_label, token) => {
    expect(() => decodeRecoveryCursor(token, SCOPE)).toThrow("invalid_cursor");
  });

  it.each([
    ["from", { ...SCOPE, from: "2026-08-02" }],
    ["to", { ...SCOPE, to: "2026-08-15" }],
    ["asOf", { ...SCOPE, asOf: "2026-08-17T03:00:01.000Z" }],
  ] as const)("rejects reuse with a different %s scope", (_field, currentScope) => {
    const token = encodeRecoveryCursor(SCOPE);
    expect(() => decodeRecoveryCursor(token, currentScope)).toThrow(
      "invalid_cursor_scope",
    );
  });

  it("caps cursor length before decoding", () => {
    expect(() => decodeRecoveryCursor("a".repeat(1_025), SCOPE)).toThrow(
      "invalid_cursor",
    );
  });
});
