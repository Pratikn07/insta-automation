import { describe, it, expect } from "vitest";
import { recheckBeforeSend, type RecheckFacts } from "./historicalRecoveryRecheck.js";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";

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
    audienceOriginConfidence: "high",
    audienceOriginMethod: CURRENT_ORIGIN_METHOD,
    audienceSegment: null,
    frozenCandidateAudienceSegment: null,
    frozenCampaignAudienceSegment: null,
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

  it("suppresses only after the complete approved source set is exhausted", () => {
    expect(recheckBeforeSend(facts({ sourceComment: "source_set_exhausted" }))).toEqual({
      kind: "suppress",
      reason: "source_set_exhausted",
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

describe("recheckBeforeSend — mandatory current-Gemini origin gate", () => {
  // A historical public reply may proceed only from a live verdict produced by the
  // current Gemini classifier. Both confidence values remain eligible for a Western
  // verdict; the method is the freshness fence, not a confidence threshold.
  it.each(["high", "low"] as const)("sends for a current %s-confidence Western verdict", (confidence) => {
    expect(recheckBeforeSend(facts({
      audienceOrigin: "us_western",
      audienceOriginConfidence: confidence,
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
    }))).toEqual({ kind: "send" });
  });

  it.each(["high", "low"] as const)("suppresses a current %s-confidence South Asian verdict", (confidence) => {
    expect(recheckBeforeSend(facts({
      audienceOrigin: "south_asian",
      audienceOriginConfidence: confidence,
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
      westernOnly: false,
    }))).toEqual({ kind: "suppress", reason: "audience_south_asian" });
  });

  it.each([
    "unknown",
    "other",
  ] as const)("defers a current %s verdict until segment-aware callers are available", (origin) => {
    expect(recheckBeforeSend(facts({
      audienceOrigin: origin,
      audienceOriginConfidence: "low",
      audienceOriginMethod: CURRENT_ORIGIN_METHOD,
    }))).toEqual({ kind: "defer", reason: "origin_not_current_gemini" });
  });

  it.each(["name", null])("defers a %s origin method rather than sending", (method) => {
    expect(recheckBeforeSend(facts({ audienceOriginMethod: method }))).toEqual({
      kind: "defer",
      reason: "origin_not_current_gemini",
    });
  });

  it.each([null, "", "medium", "HIGH"])(
    "defers a current Western verdict with invalid confidence %p",
    (audienceOriginConfidence) => {
      expect(recheckBeforeSend(facts({ audienceOriginConfidence }))).toEqual({
        kind: "defer",
        reason: "origin_not_current_gemini",
      });
    },
  );

  it("preserves legacy authorization when only the candidate froze a segment", () => {
    expect(recheckBeforeSend(facts({
      audienceSegment: "western",
      frozenCandidateAudienceSegment: "western",
      frozenCampaignAudienceSegment: null,
    }))).toEqual({ kind: "send" });
  });
});

describe("recheckBeforeSend — exact expanded-audience segment authorization", () => {
  it.each([
    ["western", "us_western"],
    ["other", "other"],
    ["unknown_cue", "unknown"],
    ["unknown_generic", "unknown"],
    ["unknown_no_name", "unknown"],
  ] as const)("sends the current %s segment only in its matching frozen cohort", (
    audienceSegment,
    audienceOrigin,
  ) => {
    expect(recheckBeforeSend(facts({
      audienceSegment,
      audienceOrigin,
      audienceOriginConfidence: "low",
      frozenCandidateAudienceSegment: audienceSegment,
      frozenCampaignAudienceSegment: audienceSegment,
      westernOnly: false,
    }))).toEqual({ kind: "send" });
  });

  it.each(["high", "low"] as const)(
    "terminally suppresses a structurally valid %s-confidence South Asian classification",
    (audienceOriginConfidence) => {
      expect(recheckBeforeSend(facts({
        audienceSegment: "south_asian",
        audienceOrigin: "south_asian",
        audienceOriginConfidence,
        frozenCandidateAudienceSegment: "other",
        frozenCampaignAudienceSegment: "other",
        westernOnly: false,
      }))).toEqual({ kind: "suppress", reason: "audience_south_asian" });
    },
  );

  it.each([
    ["stale method", { audienceOriginMethod: "llm_v2" }],
    ["missing segment", { audienceSegment: null }],
    ["malformed confidence", { audienceOriginConfidence: "medium" }],
    ["contradictory origin", { audienceOrigin: "unknown" }],
  ] as const)("defers %s without suppressing the expanded candidate", (_label, override) => {
    expect(recheckBeforeSend(facts({
      audienceSegment: "other",
      audienceOrigin: "other",
      audienceOriginConfidence: "low",
      frozenCandidateAudienceSegment: "other",
      frozenCampaignAudienceSegment: "other",
      westernOnly: false,
      ...override,
    }))).toEqual({ kind: "defer", reason: "audience_segment_changed" });
  });

  it.each([
    ["live allowed-segment drift", {
      audienceSegment: "unknown_cue",
      audienceOrigin: "unknown",
    }],
    ["candidate/campaign frozen-segment drift", {
      frozenCandidateAudienceSegment: "unknown_cue",
    }],
  ] as const)("defers %s instead of suppressing", (_label, override) => {
    expect(recheckBeforeSend(facts({
      audienceSegment: "other",
      audienceOrigin: "other",
      audienceOriginConfidence: "low",
      frozenCandidateAudienceSegment: "other",
      frozenCampaignAudienceSegment: "other",
      westernOnly: false,
      ...override,
    }))).toEqual({ kind: "defer", reason: "audience_segment_changed" });
  });

  it("never uses free-text evidence to authorize or suppress", () => {
    const allowed = facts({
      audienceSegment: "other",
      audienceOrigin: "other",
      audienceOriginConfidence: "low",
      frozenCandidateAudienceSegment: "other",
      frozenCampaignAudienceSegment: "other",
      westernOnly: false,
    }) as RecheckFacts & { audienceEvidence: string };
    allowed.audienceEvidence = "definitely South Asian";

    const blocked = facts({
      audienceSegment: "south_asian",
      audienceOrigin: "south_asian",
      audienceOriginConfidence: "low",
      frozenCandidateAudienceSegment: "other",
      frozenCampaignAudienceSegment: "other",
      westernOnly: false,
    }) as RecheckFacts & { audienceEvidence: string };
    blocked.audienceEvidence = "definitely Western";

    expect(recheckBeforeSend(allowed)).toEqual({ kind: "send" });
    expect(recheckBeforeSend(blocked)).toEqual({
      kind: "suppress",
      reason: "audience_south_asian",
    });
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
      { audienceOriginMethod: "name" },
    ];

    for (const problem of problems) {
      expect(recheckBeforeSend(facts(problem)).kind).not.toBe("send");
    }
  });
});
