import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * `web` is a separate build and cannot import from `src`, so the recovery view
 * model keeps its own copy of which statuses may be cancelled or marked
 * reviewed. Two hand-maintained copies of the same rule drift.
 *
 * Drift is not corruption — every action re-reads the row and answers 409 when
 * the status is no longer eligible — but it offers the owner a button that then
 * fails, which reads as a broken dashboard.
 *
 * This test parses the web copies out of the source text rather than importing
 * them, because importing a `.tsx`-adjacent module here would drag JSX and the
 * browser env into the backend suite for two array literals.
 */

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../services/igUserService.js", () => ({ getIgUsers: vi.fn() }));
vi.mock("../services/eventLogger.js", () => ({ logEvent: vi.fn() }));
vi.mock("../services/dmRecoveryHealth.js", () => ({ getRecoveryHealthSnapshot: vi.fn() }));
vi.mock("../config/env.js", () => ({ env: {} }));
// This suite is about status mapping and reads no flag. Stubbed so the partial env
// above does not have to satisfy the flag service's own dependencies.
vi.mock("../services/flagService.js", () => ({
  flags: { bool: () => false, percent: () => 0 },
}));

const { CANCELLABLE, REVIEWABLE } = await import("./recoveryReminders.routes.js");

const VIEW_MODEL_PATH = new URL(
  "../../web/src/components/conversations/dmRecoveryViewModel.ts",
  import.meta.url,
);

/** Pull a `new Set([...])` literal's string members out of the web source. */
function webSetMembers(constName: string): string[] {
  const source = readFileSync(VIEW_MODEL_PATH, "utf8");
  const match = source.match(
    new RegExp(`const ${constName}:[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`, "m"),
  );
  if (!match) throw new Error(`could not find ${constName} in dmRecoveryViewModel.ts`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe("recovery action statuses agree across the API and the dashboard", () => {
  it("offers cancel for exactly the statuses the API accepts", () => {
    expect(webSetMembers("CANCELLABLE")).toEqual([...CANCELLABLE].sort());
  });

  it("offers mark-reviewed for exactly the statuses the API accepts", () => {
    // The web copy is named NEEDS_REVIEW and also drives the attention badge.
    expect(webSetMembers("NEEDS_REVIEW")).toEqual([...REVIEWABLE].sort());
  });

  it("never offers cancel for a terminal status", () => {
    // `sent` and `suppressed` are outcomes, not pending work. The API would 409,
    // but the button should never appear in the first place.
    for (const terminal of ["sent", "suppressed", "cancelled"]) {
      expect(CANCELLABLE).not.toContain(terminal);
      expect(webSetMembers("CANCELLABLE")).not.toContain(terminal);
    }
  });
});
