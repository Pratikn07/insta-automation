import { describe, it, expect } from "vitest";
import { recheckBeforeSend, type RecheckFacts } from "./historicalRecoveryRecheck.js";

// This function stands between a days-old snapshot and a public comment on a real
// person's post. Every branch is tested, and the ordering is tested too: when two
// things are wrong the reported reason has to be the informative one.

function facts(overrides: Partial<RecheckFacts> = {}): RecheckFacts {
  return {
    sourceComment: "visible",
    repliedSinceSelection: false,
    completedSinceSelection: false,
    contactedSinceSelection: false,
    audienceOrigin: "us_western",
    westernOnly: true,
    campaignRunning: true,
    sentThisHour: 0,
    hourlyCap: 3,
    sentToday: 0,
    dailyCap: 10,
    ...overrides,
  };
}

describe("recheckBeforeSend — the send case", () => {
  it("sends when every check passes", () => {
    expect(recheckBeforeSend(facts())).toEqual({ kind: "send" });
  });
});

describe("recheckBeforeSend — owner control", () => {
  // A pause is the emergency stop. It must take effect even for a row already
  // claimed in this tick, which is why campaign state is checked first.
  it("defers when the campaign is no longer running", () => {
    expect(recheckBeforeSend(facts({ campaignRunning: false }))).toEqual({
      kind: "defer",
      reason: "campaign_not_running",
    });
  });

  it("stops a paused campaign even when everything else is perfect", () => {
    const decision = recheckBeforeSend(facts({ campaignRunning: false, sentThisHour: 0 }));
    expect(decision.kind).toBe("defer");
  });
});

describe("recheckBeforeSend — pacing", () => {
  // A cap is a rate limit, not a judgement about this person, so the row defers and
  // sends later rather than being burned.
  it("defers rather than suppresses at the hourly cap", () => {
    expect(recheckBeforeSend(facts({ sentThisHour: 3, hourlyCap: 3 }))).toEqual({
      kind: "defer",
      reason: "hourly_cap_reached",
    });
  });

  it("sends with one slot left", () => {
    expect(recheckBeforeSend(facts({ sentThisHour: 2, hourlyCap: 3 }))).toEqual({ kind: "send" });
  });

  it("treats an over-cap count as still capped", () => {
    const decision = recheckBeforeSend(facts({ sentThisHour: 9, hourlyCap: 3 }));
    expect(decision).toEqual({ kind: "defer", reason: "hourly_cap_reached" });
  });
});

describe("recheckBeforeSend — the daily cap", () => {
  // The bug this fixes: dailyCap was stored, validated, and displayed, but never
  // checked. The hourly cap alone permits 24x its value per day, so a campaign
  // configured for 10 a day was free to post 72.
  it("defers once the daily cap is reached, even with hourly headroom", () => {
    const decision = recheckBeforeSend(
      facts({ sentToday: 10, dailyCap: 10, sentThisHour: 0, hourlyCap: 3 }),
    );

    expect(decision).toEqual({ kind: "defer", reason: "daily_cap_reached" });
  });

  it("sends with one slot left in the day", () => {
    expect(recheckBeforeSend(facts({ sentToday: 9, dailyCap: 10 }))).toEqual({ kind: "send" });
  });

  // Reported ahead of the hourly cap: the daily one is the binding constraint, and
  // naming the hourly cap would suggest waiting an hour would help when it will not.
  it("reports the daily cap when both are exhausted", () => {
    const decision = recheckBeforeSend(
      facts({ sentToday: 10, dailyCap: 10, sentThisHour: 3, hourlyCap: 3 }),
    );

    expect(decision).toEqual({ kind: "defer", reason: "daily_cap_reached" });
  });

  it("treats an over-cap daily count as still capped", () => {
    expect(recheckBeforeSend(facts({ sentToday: 99, dailyCap: 10 })).kind).toBe("defer");
  });
});

describe("recheckBeforeSend — the comment must be there", () => {
  // Measured: 1 of 3 sampled 44-day-old comments had been deleted. This is not a
  // rare edge case.
  it("suppresses a deleted comment", () => {
    expect(recheckBeforeSend(facts({ sourceComment: "missing" }))).toEqual({
      kind: "suppress",
      reason: "source_comment_deleted",
    });
  });

  // Worse than a deletion: replying to a hidden comment SUCCEEDS, so it would be
  // recorded as sent and counted in the experiment while nobody ever saw it.
  it("suppresses a hidden comment", () => {
    expect(recheckBeforeSend(facts({ sourceComment: "hidden" }))).toEqual({
      kind: "suppress",
      reason: "source_comment_hidden",
    });
  });

  // QA-09. THE distinction that was missing: a read we could not complete must never
  // read as "the comment is gone". The worker caught every failure and reported
  // not-there, so one timeout permanently suppressed a candidate whose comment was
  // fine — and counted it as a deletion in the source-unavailable metric.
  it("defers a read we could not complete, never suppresses it", () => {
    expect(recheckBeforeSend(facts({ sourceComment: "unknown" }))).toEqual({
      kind: "defer",
      reason: "source_read_failed",
    });
  });

  // Auth is reported separately so the worker can open the shared circuit. One
  // expired token would otherwise churn the entire remaining pool.
  it("defers an auth failure under its own reason", () => {
    expect(recheckBeforeSend(facts({ sourceComment: "auth" }))).toEqual({
      kind: "defer",
      reason: "source_read_auth_failed",
    });
  });

  // The property that matters more than any single case: only a definitive answer
  // from Meta may be terminal.
  it("only ever suppresses on a definitive answer", () => {
    for (const state of ["auth", "unknown"] as const) {
      expect(recheckBeforeSend(facts({ sourceComment: state })).kind).toBe("defer");
    }
    for (const state of ["missing", "hidden"] as const) {
      expect(recheckBeforeSend(facts({ sourceComment: state })).kind).toBe("suppress");
    }
  });
});

describe("recheckBeforeSend — the premise must still hold", () => {
  // The copy says "I don't think my DM reached you". Each of these makes that false.
  it("suppresses when they replied after selection", () => {
    expect(recheckBeforeSend(facts({ repliedSinceSelection: true }))).toEqual({
      kind: "suppress",
      reason: "replied_since_selection",
    });
  });

  it("suppresses when they completed the guide after selection", () => {
    expect(recheckBeforeSend(facts({ completedSinceSelection: true }))).toEqual({
      kind: "suppress",
      reason: "completed_since_selection",
    });
  });

  // Covers the prospective feature reaching them first. One public recovery per
  // person, across both features.
  it("suppresses when another recovery reached them after selection", () => {
    expect(recheckBeforeSend(facts({ contactedSinceSelection: true }))).toEqual({
      kind: "suppress",
      reason: "contacted_since_selection",
    });
  });
});

describe("recheckBeforeSend — market rule on the live verdict", () => {
  // An origin verdict is retired when the name it came from changes, so someone
  // in-market at selection can read out-of-market now. That is exactly why §35
  // requires the recheck rather than trusting the snapshot.
  it("suppresses a south_asian verdict that appeared after selection", () => {
    expect(recheckBeforeSend(facts({ audienceOrigin: "south_asian" }))).toEqual({
      kind: "suppress",
      reason: "audience_out_of_market",
    });
  });

  it("ignores the origin when westernOnly is off", () => {
    const decision = recheckBeforeSend(facts({ audienceOrigin: "south_asian", westernOnly: false }));
    expect(decision).toEqual({ kind: "send" });
  });

  it("still sends to an unknown origin", () => {
    expect(recheckBeforeSend(facts({ audienceOrigin: null }))).toEqual({ kind: "send" });
  });
});

describe("recheckBeforeSend — reason precedence", () => {
  // When several things are wrong the reported reason must be the actionable one.
  // A paused campaign explains itself; "comment deleted" would send someone
  // hunting for a data problem that is not there.
  it("reports the pause ahead of a data problem", () => {
    const decision = recheckBeforeSend(
      facts({ campaignRunning: false, sourceComment: "missing" }),
    );
    expect(decision).toEqual({ kind: "defer", reason: "campaign_not_running" });
  });

  it("reports the missing comment ahead of the market rule", () => {
    const decision = recheckBeforeSend(
      facts({ sourceComment: "missing", audienceOrigin: "south_asian" }),
    );
    expect(decision).toEqual({ kind: "suppress", reason: "source_comment_deleted" });
  });

  // A deferral is recoverable and a suppression is terminal, so when both apply the
  // deferral must win — otherwise a temporary cap would permanently burn the row.
  it("prefers a deferral over a suppression", () => {
    const decision = recheckBeforeSend(
      facts({ sentThisHour: 5, hourlyCap: 3, repliedSinceSelection: true }),
    );
    expect(decision.kind).toBe("defer");
  });

  it("never returns send when anything is wrong", () => {
    const problems: Array<Partial<RecheckFacts>> = [
      { campaignRunning: false },
      { sentThisHour: 3 },
      { sentToday: 10 },
      { sourceComment: "missing" },
      { sourceComment: "hidden" },
      { sourceComment: "auth" },
      { sourceComment: "unknown" },
      { repliedSinceSelection: true },
      { completedSinceSelection: true },
      { contactedSinceSelection: true },
      { audienceOrigin: "south_asian" },
    ];

    for (const problem of problems) {
      expect(recheckBeforeSend(facts(problem)).kind).not.toBe("send");
    }
  });
});
