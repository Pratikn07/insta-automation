import { describe, it, expect } from "vitest";
import {
  candidateView,
  campaignActions,
  campaignStatusView,
  campaignPhaseView,
  suppressionLabel,
  recoveryRate,
  type CandidateRow,
  type CampaignRow,
} from "./historicalRecoveryViewModel";

// This is the surface an operator uses to decide whether to post public comments on
// 985 real people's posts. A label that overstates certainty is the failure mode.

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: "cand-1",
    campaignPhase: "unknown_read_pilot",
    username: "parent",
    igUserId: "person-1",
    keywordSnapshot: "SLEEP",
    commentAt: "2026-06-25T00:00:00.000Z",
    arm: "treatment",
    outcome: "pending",
    evidence: "gate_sent_no_read",
    suppressionReason: null,
    publicReplyId: null,
    reviewedAt: null,
    laterCompletedAt: null,
    audienceOrigin: "us_western",
    audienceOriginMethod: "llm_v1",
    audienceOriginConfidence: "low",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    phase: "unknown_read_pilot",
    state: "draft",
    selectionVersion: "selection-v2",
    copyVersion: "recovery-v2",
    sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    candidateCount: 985,
    holdoutPercent: 50,
    batchSize: 1,
    hourlyCap: 3,
    dailyCap: 10,
    approvedBy: null,
    approvedAt: null,
    pauseReason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    progress: {},
    ...overrides,
  };
}

describe("candidateView — the uncertain case", () => {
  // The most important label on the surface. The comment MAY be live and we cannot
  // establish which, so calling it sent or failed would be a claim we cannot support.
  it("never presents an uncertain send as sent or failed", () => {
    const view = candidateView(candidate({ outcome: "send_uncertain" }));

    expect(view.label).toBe("Unconfirmed—check Instagram");
    expect(view.label).not.toMatch(/sent|failed/i);
    expect(view.needsAttention).toBe(true);
    expect(view.tone).toBe("warning");
  });

  it("explains why an uncertain send is not retried", () => {
    const view = candidateView(candidate({ outcome: "send_uncertain" }));
    expect(view.description).toMatch(/second public comment/i);
  });
});

describe("candidateView — outcomes", () => {
  it("distinguishes a sent reminder from a recovered one", () => {
    const sent = candidateView(candidate({ outcome: "sent" }));
    expect(sent.label).toBe("Reminder sent");
    expect(sent.recovered).toBe(false);

    const recovered = candidateView(
      candidate({ outcome: "sent", laterCompletedAt: "2026-08-01T00:00:00.000Z" }),
    );
    expect(recovered.recovered).toBe(true);
    expect(recovered.tone).toBe("positive");
  });

  // A holdout is the control arm. Showing it as "waiting" would imply it will
  // eventually be contacted, which is the opposite of its purpose.
  it("labels a holdout as control regardless of outcome", () => {
    const view = candidateView(candidate({ arm: "holdout", outcome: "pending" }));
    expect(view.label).toBe("Held back as control");
    expect(view.needsAttention).toBe(false);
  });

  it("explains why a control row exists", () => {
    const view = candidateView(candidate({ arm: "holdout" }));
    expect(view.description).toMatch(/measure whether/i);
  });

  // QA-12. Every holdout previously reported recovered: false, so the control arm looked
  // like it never recovered and any treatment number read as pure lift. The baseline is
  // the whole reason the arm exists.
  it("counts a holdout that completed on its own as recovered", () => {
    const view = candidateView(
      candidate({ arm: "holdout", outcome: "holdout_withheld", laterCompletedAt: "2026-07-05T10:00:00Z" }),
    );

    expect(view.recovered).toBe(true);
    expect(view.label).toBe("Recovered on their own");
    // Neutral, not positive: nothing we did caused this.
    expect(view.tone).toBe("neutral");
  });

  it("does not count an untouched holdout as recovered", () => {
    const view = candidateView(candidate({ arm: "holdout", outcome: "holdout_withheld" }));

    expect(view.recovered).toBe(false);
    expect(view.label).toBe("Held back as control");
  });

  it("flags a failed send for attention", () => {
    const view = candidateView(candidate({ outcome: "send_failed", suppressionReason: "permanent" }));
    expect(view.needsAttention).toBe(true);
    expect(view.tone).toBe("danger");
  });

  it("reports a suppression using its reason as the label", () => {
    const view = candidateView(
      candidate({ outcome: "suppressed", suppressionReason: "source_comment_deleted" }),
    );
    expect(view.label).toBe("Original comment was deleted");
    expect(view.needsAttention).toBe(false);
  });
});

describe("suppressionLabel", () => {
  // Names the decision, not the person: a withheld row that reads as a fact about
  // the person cannot be audited or reversed.
  it("names the filter rather than judging the person", () => {
    expect(suppressionLabel("audience_out_of_market")).toBe("Withheld by the audience filter");
  });

  // Deleted and hidden are different problems. A hidden comment still exists, so a
  // reply would succeed while nobody could see it.
  it("keeps hidden distinct from deleted", () => {
    expect(suppressionLabel("source_comment_hidden")).not.toBe(
      suppressionLabel("source_comment_deleted"),
    );
  });

  it("degrades an unknown reason to something readable", () => {
    expect(suppressionLabel("some_new_reason")).toBe("some new reason");
  });

  it("says withheld when there is no reason at all", () => {
    expect(suppressionLabel(null)).toBe("Withheld");
  });
});

describe("campaignActions", () => {
  // Offering an action the server refuses teaches the operator not to trust the
  // controls, so these mirror recoveryCampaignControl's state conditions.
  it("offers approval only before it is running", () => {
    expect(campaignActions("draft").canApprove).toBe(true);
    expect(campaignActions("running").canApprove).toBe(false);
  });

  it("offers pause only while running, resume only while paused", () => {
    expect(campaignActions("running").canPause).toBe(true);
    expect(campaignActions("paused").canPause).toBe(false);
    expect(campaignActions("paused").canResume).toBe(true);
    expect(campaignActions("running").canResume).toBe(false);
  });

  it("offers nothing terminal on a finished campaign", () => {
    const done = campaignActions("completed");
    expect(done.canApprove).toBe(false);
    expect(done.canPause).toBe(false);
    expect(done.canCancel).toBe(false);
  });

  it("still allows cancelling a draft", () => {
    expect(campaignActions("draft").canCancel).toBe(true);
  });
});

describe("campaignStatusView", () => {
  it("makes clear nothing sends before approval", () => {
    const view = campaignStatusView(campaign({ state: "draft" }), true);
    expect(view.description).toMatch(/nothing is sent until you approve/i);
    expect(view.tone).toBe("pending");
  });

  // The most confusing possible state: approved, looks live, sends nothing. Called
  // out explicitly rather than shown as healthy.
  it("warns when an approved campaign cannot actually send", () => {
    const view = campaignStatusView(campaign({ state: "running" }), false);

    expect(view.label).toMatch(/sending is switched off/i);
    expect(view.tone).toBe("warning");
  });

  it("reads as healthy when running and sending is on", () => {
    const view = campaignStatusView(campaign({ state: "running" }), true);
    expect(view.tone).toBe("positive");
    expect(view.label).toBe("Sending");
  });

  it("carries the pause reason into the description", () => {
    const view = campaignStatusView(
      campaign({ state: "paused", pauseReason: "complaint received" }),
      true,
    );
    expect(view.description).toMatch(/complaint received/);
  });

  // Sent comments are live on Instagram. Implying cancellation undoes them would be
  // false.
  it("is honest that cancelling does not unpost anything", () => {
    const view = campaignStatusView(campaign({ state: "cancelled" }), true);
    expect(view.description).toMatch(/stay posted/i);
  });
});

describe("campaignPhaseView", () => {
  it("states confirmed delivery failure only for the confirmed phase", () => {
    expect(campaignPhaseView("confirmed_failure").description).toMatch(/could not be delivered/i);
  });

  it("describes unknown read evidence without claiming delivery failed", () => {
    const view = campaignPhaseView("unknown_read_pilot");
    expect(view.description).toMatch(/no read confirmation/i);
    expect(view.description).not.toMatch(/never received|failed/i);
  });
});

describe("recoveryRate", () => {
  it("is null before anything is sent, avoiding a 0% that reads as failure", () => {
    expect(recoveryRate({})).toBeNull();
    expect(recoveryRate({ pending: 40 })).toBeNull();
  });

  it("divides recoveries by sends, not by the whole campaign", () => {
    expect(recoveryRate({ sent: 20, recovered: 5, pending: 900 })).toBeCloseTo(0.25);
  });

  it("reports zero when sends produced no recoveries", () => {
    expect(recoveryRate({ sent: 10 })).toBe(0);
  });
});
