import { describe, it, expect } from "vitest";
import {
  decideEligibility,
  summarise,
  keepLatestPerPerson,
  assertNoDuplicates,
  evidenceMatchesPhase,
  evidenceForPhase,
  type EligibilityFacts,
} from "./historicalRecoveryEligibility.js";

// Every `include` here becomes a PUBLIC comment naming a real person. A wrong
// include is visible to that person's followers and cannot be recalled, so the
// exclusions are tested individually rather than trusting the happy path.

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    intentId: "intent-1",
    igUserId: "person-1",
    commentId: "18111572197955347",
    triggerKind: "comment",
    commentAt: new Date("2026-07-31T00:00:00.000Z"),
    gateAccepted: true,
    gateExhausted: false,
    recipientUnreachable: false,
    ambiguousPriorSend: false,
    hasEngagementEvidence: false,
    completedSameKeyword: false,
    priorPublicRecovery: false,
    supersededByNewerJourney: false,
    keywordActive: true,
    audienceOrigin: "us_western",
    westernOnly: true,
    ...overrides,
  };
}

describe("decideEligibility — inclusion", () => {
  it("includes an accepted gate with no read as the unknown-read basis", () => {
    expect(decideEligibility(facts())).toEqual({
      kind: "include",
      evidence: "gate_sent_no_read",
    });
  });

  it("includes a definitively failed gate as the confirmed-failure basis", () => {
    expect(decideEligibility(facts({ gateAccepted: false, gateExhausted: true }))).toEqual({
      kind: "include",
      evidence: "gate_exhausted",
    });
  });

  // "The DM never arrived" is a stronger and safer claim than "it arrived but may
  // not have been read", so its copy is the one to use when both look true.
  it("prefers the confirmed-failure basis when both are true", () => {
    const decision = decideEligibility(facts({ gateAccepted: true, gateExhausted: true }));
    expect(decision).toEqual({ kind: "include", evidence: "gate_exhausted" });
  });

  // §34 requires positive evidence. "No record" is not grounds to contact anyone.
  it("excludes an intent with no gate evidence at all", () => {
    expect(decideEligibility(facts({ gateAccepted: false, gateExhausted: false }))).toEqual({
      kind: "exclude",
      reason: "no_gate_evidence",
    });
  });
});

describe("decideEligibility — nothing to reply to", () => {
  // Measured: all 352 DM-origin historical intents have no comment id, because a
  // DM has no comment. Replying is physically impossible, not merely unwise.
  it("excludes a DM-origin journey", () => {
    expect(decideEligibility(facts({ triggerKind: "dm" }))).toEqual({
      kind: "exclude",
      reason: "dm_origin_no_comment",
    });
  });

  it("excludes an intent whose comment id was never captured", () => {
    expect(decideEligibility(facts({ commentId: null }))).toEqual({
      kind: "exclude",
      reason: "no_source_comment",
    });
  });

  // A DM-origin row is reported as such even when a comment id somehow exists, so
  // the campaign report names the real reason.
  it("reports dm origin ahead of other reasons", () => {
    const decision = decideEligibility(facts({ triggerKind: "dm", keywordActive: false }));
    expect(decision).toEqual({ kind: "exclude", reason: "dm_origin_no_comment" });
  });
});

describe("decideEligibility — the dead-account guard", () => {
  // 59 of 63 exhausted gate rows in this data are "user cannot be found". Publicly
  // apologising to a deleted account is the failure mode that makes this feature
  // look broken.
  it("excludes an unreachable recipient", () => {
    expect(decideEligibility(facts({ recipientUnreachable: true }))).toEqual({
      kind: "exclude",
      reason: "recipient_unreachable",
    });
  });

  // The confirmed-failure cohort is exactly where dead accounts concentrate, so the
  // liveness check must beat the strongest inclusion basis.
  it("excludes an unreachable recipient even with a confirmed gate failure", () => {
    const decision = decideEligibility(facts({ gateExhausted: true, recipientUnreachable: true }));
    expect(decision).toEqual({ kind: "exclude", reason: "recipient_unreachable" });
  });
});

describe("decideEligibility — the premise must hold", () => {
  it("excludes anyone with engagement evidence", () => {
    expect(decideEligibility(facts({ hasEngagementEvidence: true }))).toEqual({
      kind: "exclude",
      reason: "has_engagement_evidence",
    });
  });

  it("excludes anyone who already completed the keyword", () => {
    expect(decideEligibility(facts({ completedSameKeyword: true }))).toEqual({
      kind: "exclude",
      reason: "already_completed_keyword",
    });
  });

  it("excludes an intent a newer journey should own", () => {
    expect(decideEligibility(facts({ supersededByNewerJourney: true }))).toEqual({
      kind: "exclude",
      reason: "superseded_by_newer_journey",
    });
  });

  it("excludes an inactive keyword", () => {
    expect(decideEligibility(facts({ keywordActive: false }))).toEqual({
      kind: "exclude",
      reason: "keyword_inactive",
    });
  });
});

describe("decideEligibility — never contact twice", () => {
  it("excludes a person who already received a public recovery", () => {
    expect(decideEligibility(facts({ priorPublicRecovery: true }))).toEqual({
      kind: "exclude",
      reason: "prior_public_recovery",
    });
  });

  // Uncertainty is not permission. An earlier attempt whose outcome we cannot
  // establish may already have posted, so a second attempt risks double-posting.
  it("excludes a person whose prior attempt outcome is unknown", () => {
    expect(decideEligibility(facts({ ambiguousPriorSend: true }))).toEqual({
      kind: "exclude",
      reason: "ambiguous_prior_send",
    });
  });
});

describe("decideEligibility — Western-market filter", () => {
  // Matches the prospective feature exactly: a south_asian verdict withholds at
  // EITHER confidence, which is the change made to dmRecoveryPolicy step 3b.
  it("excludes a south_asian verdict while westernOnly is on", () => {
    expect(decideEligibility(facts({ audienceOrigin: "south_asian" }))).toEqual({
      kind: "exclude",
      reason: "audience_out_of_market",
    });
  });

  it("ignores the origin entirely when westernOnly is off", () => {
    const decision = decideEligibility(facts({ audienceOrigin: "south_asian", westernOnly: false }));
    expect(decision).toEqual({ kind: "include", evidence: "gate_sent_no_read" });
  });

  // Roughly a fifth of this audience has no usable name. Withholding from them
  // would cancel much of the feature while looking like a targeting rule.
  it("still includes an unknown origin", () => {
    const decision = decideEligibility(facts({ audienceOrigin: null }));
    expect(decision).toEqual({ kind: "include", evidence: "gate_sent_no_read" });
  });
});

describe("summarise", () => {
  it("splits inclusions from exclusions and counts each reason", () => {
    const pool = [
      facts({ intentId: "a", igUserId: "p1" }),
      facts({ intentId: "b", igUserId: "p2", triggerKind: "dm" }),
      facts({ intentId: "c", igUserId: "p3", triggerKind: "dm" }),
      facts({ intentId: "d", igUserId: "p4", recipientUnreachable: true }),
    ].map((f) => ({ facts: f, decision: decideEligibility(f) }));

    const { included, excludedByReason } = summarise(pool);

    expect(included).toHaveLength(1);
    expect(included[0]!.facts.intentId).toBe("a");
    expect(excludedByReason.get("dm_origin_no_comment")).toBe(2);
    expect(excludedByReason.get("recipient_unreachable")).toBe(1);
  });

  it("reports an empty pool without inventing rows", () => {
    const { included, excludedByReason } = summarise([]);
    expect(included).toEqual([]);
    expect(excludedByReason.size).toBe(0);
  });
});

describe("assertNoDuplicates", () => {
  it("accepts a pool with one candidate per person", () => {
    expect(() =>
      assertNoDuplicates([
        { facts: facts({ intentId: "a", igUserId: "p1" }) },
        { facts: facts({ intentId: "b", igUserId: "p2" }) },
      ]),
    ).not.toThrow();
  });

  // The database would catch this as a P2002 mid-insert, leaving half a campaign
  // written. Failing first turns it into a clean refusal.
  it("refuses a pool that would contact one person twice", () => {
    expect(() =>
      assertNoDuplicates([
        { facts: facts({ intentId: "a", igUserId: "p1" }) },
        { facts: facts({ intentId: "b", igUserId: "p1" }) },
      ]),
    ).toThrow(/would contact p1 twice/);
  });

  it("refuses a repeated intent", () => {
    expect(() =>
      assertNoDuplicates([
        { facts: facts({ intentId: "a", igUserId: "p1" }) },
        { facts: facts({ intentId: "a", igUserId: "p2" }) },
      ]),
    ).toThrow(/two candidates for intent a/);
  });

  it("names both intents so the collision can be investigated", () => {
    expect(() =>
      assertNoDuplicates([
        { facts: facts({ intentId: "first", igUserId: "p1" }) },
        { facts: facts({ intentId: "second", igUserId: "p1" }) },
      ]),
    ).toThrow(/first.*second/);
  });
});

// 43 of 1,487 eligible people asked more than once, holding 101 intents. Without
// this the campaign would try to contact them repeatedly and hit the unique index
// mid-write.
describe("keepLatestPerPerson", () => {
  const day = (n: number) => new Date(`2026-07-${String(n).padStart(2, "0")}T00:00:00.000Z`);

  it("keeps the most recent request when someone asked several times", () => {
    const kept = keepLatestPerPerson([
      { facts: facts({ intentId: "old", igUserId: "p1", commentAt: day(1) }) },
      { facts: facts({ intentId: "mid", igUserId: "p1", commentAt: day(10) }) },
      { facts: facts({ intentId: "new", igUserId: "p1", commentAt: day(20) }) },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.facts.intentId).toBe("new");
  });

  it("leaves single-request people untouched", () => {
    const kept = keepLatestPerPerson([
      { facts: facts({ intentId: "a", igUserId: "p1", commentAt: day(1) }) },
      { facts: facts({ intentId: "b", igUserId: "p2", commentAt: day(2) }) },
    ]);

    expect(kept.map((e) => e.facts.intentId)).toEqual(["a", "b"]);
  });

  it("dedupes several people independently", () => {
    const kept = keepLatestPerPerson([
      { facts: facts({ intentId: "p1-old", igUserId: "p1", commentAt: day(1) }) },
      { facts: facts({ intentId: "p1-new", igUserId: "p1", commentAt: day(5) }) },
      { facts: facts({ intentId: "p2-old", igUserId: "p2", commentAt: day(2) }) },
      { facts: facts({ intentId: "p2-new", igUserId: "p2", commentAt: day(9) }) },
    ]);

    expect(kept.map((e) => e.facts.intentId)).toEqual(["p1-new", "p2-new"]);
  });

  // Caller order is oldest-first so a staged `limit` takes the oldest cohort first.
  // Map iteration order would silently break that.
  it("preserves the caller's ordering", () => {
    const kept = keepLatestPerPerson([
      { facts: facts({ intentId: "early", igUserId: "p1", commentAt: day(3) }) },
      { facts: facts({ intentId: "later", igUserId: "p2", commentAt: day(20) }) },
      { facts: facts({ intentId: "middle", igUserId: "p3", commentAt: day(11) }) },
    ]);

    expect(kept.map((e) => e.facts.intentId)).toEqual(["early", "later", "middle"]);
  });

  it("its output always satisfies the duplicate assertion", () => {
    const kept = keepLatestPerPerson([
      { facts: facts({ intentId: "a", igUserId: "p1", commentAt: day(1) }) },
      { facts: facts({ intentId: "b", igUserId: "p1", commentAt: day(2) }) },
      { facts: facts({ intentId: "c", igUserId: "p2", commentAt: day(3) }) },
    ]);

    expect(() => assertNoDuplicates(kept)).not.toThrow();
  });

  it("returns nothing for an empty pool", () => {
    expect(keepLatestPerPerson([])).toEqual([]);
  });
});

// QA-03. Verified in production before this existed: a campaign labelled
// `unknown_read_pilot` contained 988 gate_sent_no_read rows AND 2 gate_exhausted
// rows, so its label, its copy, and its metrics all described something else.
describe("phase separation", () => {
  it("permits only confirmed failures in the confirmed_failure phase", () => {
    expect(evidenceMatchesPhase("confirmed_failure", "gate_exhausted")).toBe(true);
    expect(evidenceMatchesPhase("confirmed_failure", "gate_sent_no_read")).toBe(false);
  });

  it("permits only unknown-read rows in the pilot phase", () => {
    expect(evidenceMatchesPhase("unknown_read_pilot", "gate_sent_no_read")).toBe(true);
    expect(evidenceMatchesPhase("unknown_read_pilot", "gate_exhausted")).toBe(false);
  });

  // Exact match, not a subset rule: an evidence type added later must be assigned to
  // a phase deliberately rather than inherited by whichever cohort is permissive.
  it("permits nothing unrecognised in either phase", () => {
    for (const phase of ["confirmed_failure", "unknown_read_pilot"] as const) {
      expect(evidenceMatchesPhase(phase, "something_new")).toBe(false);
    }
  });

  it("maps each phase to exactly one evidence basis", () => {
    expect(evidenceForPhase("confirmed_failure")).toBe("gate_exhausted");
    expect(evidenceForPhase("unknown_read_pilot")).toBe("gate_sent_no_read");
    expect(evidenceForPhase("confirmed_failure")).not.toBe(evidenceForPhase("unknown_read_pilot"));
  });

  // The two cohorts get different copy, so a mixed campaign would tell someone
  // "I couldn't send your guide" when Meta actually accepted it.
  it("keeps the phases disjoint, so no row belongs to both", () => {
    for (const evidence of ["gate_exhausted", "gate_sent_no_read"]) {
      const inBoth =
        evidenceMatchesPhase("confirmed_failure", evidence) &&
        evidenceMatchesPhase("unknown_read_pilot", evidence);
      expect(inBoth).toBe(false);
    }
  });
});
