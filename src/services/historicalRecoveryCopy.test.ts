import { describe, it, expect } from "vitest";
import {
  recoveryCopyFor,
  normalizeKeywordForCopy,
  copyHasWorkingAction,
  copyClaimsDeliveryFailed,
  COPY_VERSION,
  RECOVERY_HANDLE,
} from "./historicalRecoveryCopy.js";

// This text is posted publicly on a real person's comment, weeks after they asked.
// Two properties matter more than the wording, and version 1 broke both.

describe("the instructed action must actually work (QA-01)", () => {
  // The defect: "Reply here and I'll send your guide right over" is a dead end.
  // commentHandler ignores any comment containing no active keyword, so a person who
  // follows that instruction literally receives nothing, ever. Only a DM carrying the
  // keyword reaches messageHandler and delivers the guide.
  it("never tells someone to reply on the comment", () => {
    for (const evidence of ["gate_exhausted", "gate_sent_no_read", "unrecognised"]) {
      expect(recoveryCopyFor(evidence, "SLEEP")).not.toMatch(/repl(y|ies) here/i);
    }
  });

  it("names the DM handle and the keyword, which is the path that works", () => {
    for (const evidence of ["gate_exhausted", "gate_sent_no_read", "unrecognised"]) {
      const copy = recoveryCopyFor(evidence, "SLEEP");

      expect(copy).toContain(`DM ${RECOVERY_HANDLE}`);
      expect(copy).toContain('"SLEEP"');
      expect(copyHasWorkingAction(copy)).toBe(true);
    }
  });

  // Without the keyword the instruction is "DM us" with nothing to say, which the
  // keyword matcher would ignore exactly like a bare reply.
  it("refuses to render without a keyword", () => {
    expect(() => recoveryCopyFor("gate_sent_no_read", "")).toThrow(/non-empty keyword/);
    expect(() => recoveryCopyFor("gate_sent_no_read", "   ")).toThrow(/non-empty keyword/);
  });

  it("recognises the broken wording as having no working action", () => {
    expect(copyHasWorkingAction("Reply here and I'll send your guide right over 💛")).toBe(false);
  });
});

describe("never claim more than the evidence shows (QA-01)", () => {
  // gate_exhausted: Meta told us delivery failed, so this is a fact we can state.
  it("states the failure only where Meta confirmed it", () => {
    const copy = recoveryCopyFor("gate_exhausted", "SLEEP");

    expect(copy).toContain("couldn't send your guide");
    expect(copyClaimsDeliveryFailed(copy)).toBe(true);
  });

  // gate_sent_no_read: Meta ACCEPTED the DM and no read receipt arrived. That is not
  // failure. Version 1 said "looks like my DM never made it to you" to 988 people,
  // which asserts a delivery failure we cannot show.
  it("makes no delivery-failure claim for the unknown-read cohort", () => {
    const copy = recoveryCopyFor("gate_sent_no_read", "SLEEP");

    expect(copyClaimsDeliveryFailed(copy)).toBe(false);
    expect(copy).toContain("I sent your guide");
  });

  it("catches the version 1 wording as a false claim", () => {
    expect(copyClaimsDeliveryFailed("So sorry, looks like my DM never made it to you!")).toBe(true);
  });

  // An unrecognised evidence type must never produce the stronger claim.
  it("falls back to the cohort that claims less", () => {
    expect(recoveryCopyFor("something_new", "SLEEP")).toBe(
      recoveryCopyFor("gate_sent_no_read", "SLEEP"),
    );
    expect(copyClaimsDeliveryFailed(recoveryCopyFor("something_new", "SLEEP"))).toBe(false);
  });

  it("gives the two cohorts different wording", () => {
    expect(recoveryCopyFor("gate_exhausted", "SLEEP")).not.toBe(
      recoveryCopyFor("gate_sent_no_read", "SLEEP"),
    );
  });
});

describe("keyword normalisation (QA-18)", () => {
  // The design requires the configured keyword shown in uppercase.
  it("uppercases and trims", () => {
    expect(normalizeKeywordForCopy("  sleep ")).toBe("SLEEP");
    expect(normalizeKeywordForCopy("Potty")).toBe("POTTY");
  });

  it("renders the uppercase form in the copy", () => {
    expect(recoveryCopyFor("gate_sent_no_read", "sleep")).toContain('"SLEEP"');
  });

  it("rejects an empty keyword rather than rendering empty quotes", () => {
    expect(() => normalizeKeywordForCopy("")).toThrow();
  });
});

describe("house style", () => {
  const all = ["gate_exhausted", "gate_sent_no_read"].map((e) => recoveryCopyFor(e, "SLEEP"));

  // Explicitly requested, and the account's existing copy has none either.
  it("uses no em or en dashes", () => {
    for (const copy of all) expect(copy).not.toMatch(/[—–]/);
  });

  it("keeps the account's 💛", () => {
    for (const copy of all) expect(copy).toContain("💛");
  });

  // Instagram truncates long comments, and an apology that needs "more" to reach the
  // instruction is worse than none.
  it("stays short enough to read without expanding", () => {
    for (const copy of all) expect(copy.length).toBeLessThan(160);
  });

  // The gate already asks for a follow. Attaching one to an apology makes it
  // transactional.
  it("asks for no follow", () => {
    for (const copy of all) expect(copy).not.toMatch(/follow/i);
  });

  it("never labels the cohort unread", () => {
    // The design is explicit: "Historical—no confirmed read", never "Unread".
    for (const copy of all) expect(copy).not.toMatch(/\bunread\b/i);
  });
});

describe("COPY_VERSION", () => {
  // Two campaigns cannot be compared if the copy changed without the version moving.
  it("moved off the version whose action did not work", () => {
    expect(COPY_VERSION).toBe("recovery-v2");
    expect(COPY_VERSION).not.toBe("recovery-v1");
  });
});
