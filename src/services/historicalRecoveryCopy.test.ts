import { describe, it, expect } from "vitest";
import {
  recoveryCopyFor,
  copyPointsAtDm,
  COPY_VERSION,
} from "./historicalRecoveryCopy.js";

// This text is posted PUBLICLY on a real person's comment, weeks after they asked.
// The wording is not decoration: it decides whether the account looks like it is
// making amends or malfunctioning.

describe("recoveryCopyFor", () => {
  // The bug this module exists to fix. The keyword's own reply is "Check your DMs!",
  // which is right seconds after a comment and wrong 43 days later, because it points
  // the person at the exact thing that failed.
  it("never tells someone to check the DM that failed", () => {
    for (const evidence of ["gate_exhausted", "gate_sent_no_read", "something_new"]) {
      expect(copyPointsAtDm(recoveryCopyFor(evidence))).toBe(false);
    }
  });

  // Two different claims. `gate_exhausted` means Meta told us delivery failed, so
  // "couldn't reach you" is a fact we can state.
  it("states the failure plainly when we have proof of it", () => {
    expect(recoveryCopyFor("gate_exhausted")).toContain("couldn't reach you");
  });

  // `gate_sent_no_read` means Meta ACCEPTED the DM and no read receipt arrived.
  // Absence of a receipt is not evidence of absence, so this must hedge.
  it("hedges when all we know is that no read receipt arrived", () => {
    const copy = recoveryCopyFor("gate_sent_no_read");

    expect(copy).toContain("looks like");
    expect(copy).not.toContain("couldn't reach you");
  });

  it("gives the two evidence types different wording", () => {
    expect(recoveryCopyFor("gate_exhausted")).not.toBe(recoveryCopyFor("gate_sent_no_read"));
  });

  // An unrecognised evidence type must never produce a public claim that our DM
  // definitively failed, so the hedged copy is the fallback.
  it("falls back to the hedged wording, not the definite one", () => {
    expect(recoveryCopyFor("unrecognised")).toBe(recoveryCopyFor("gate_sent_no_read"));
  });
});

describe("recoveryCopyFor — house style", () => {
  const all = ["gate_exhausted", "gate_sent_no_read"].map(recoveryCopyFor);

  // Explicitly requested: no em dashes anywhere. The account's existing copy has
  // none either, so this matches rather than imposes.
  it("uses no em or en dashes", () => {
    for (const copy of all) {
      expect(copy).not.toMatch(/[—–]/);
    }
  });

  it("opens with the apology rather than burying it", () => {
    for (const copy of all) {
      expect(copy.startsWith("So sorry")).toBe(true);
    }
  });

  // "Reply here" works even when the person's DM settings are what blocked us. An
  // instruction they cannot follow would be worse than saying nothing.
  it("asks for a reply on the comment, not in the DM", () => {
    for (const copy of all) {
      expect(copy).toMatch(/reply here/i);
    }
  });

  it("keeps the account's 💛 and a single exclamation", () => {
    for (const copy of all) {
      expect(copy).toContain("💛");
      expect(copy.match(/!/g)).toHaveLength(1);
    }
  });

  // Instagram truncates long comments, and a public apology that needs "more" to
  // read the offer is worse than none.
  it("stays short enough to read without expanding", () => {
    for (const copy of all) {
      expect(copy.length).toBeLessThan(140);
    }
  });

  it("says nothing about following the account", () => {
    // The gate asks for a follow. This is an apology, and attaching an ask to it
    // would make the apology look transactional.
    for (const copy of all) {
      expect(copy).not.toMatch(/follow/i);
    }
  });
});

describe("COPY_VERSION", () => {
  // Two campaigns cannot be compared if their copy changed without the version
  // moving, so this is stamped onto every campaign.
  it("is a concrete version, not a placeholder", () => {
    expect(COPY_VERSION).toBe("recovery-v1");
    expect(COPY_VERSION).not.toBe("v1");
  });
});
