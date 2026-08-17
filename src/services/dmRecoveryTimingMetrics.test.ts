import { describe, expect, it } from "vitest";
import {
  calculateRecoveryTimingMetrics,
  compareProportions,
  completedWithin,
  isMatured,
  type TimingMetricRow,
} from "./dmRecoveryTimingMetrics.js";

const HOUR_MS = 60 * 60 * 1_000;
const ACCEPTED = new Date("2026-08-01T08:00:00.000Z");
const AS_OF = new Date("2026-08-10T08:00:00.000Z");
const CLOSED_AT = new Date("2026-08-07T08:00:00.000Z");

function metricRow(
  id: string,
  arm: TimingMetricRow["timingArm"],
  overrides: Partial<TimingMetricRow> = {},
): TimingMetricRow {
  const acceptedAt = overrides.acceptedAt ?? ACCEPTED;
  const delayHours = arm === "two_hour" ? 2 : arm === "six_hour" ? 6 : 0;
  return {
    id,
    igUserId: `ig-${id}`,
    keywordId: "keyword-protein",
    timingArm: arm,
    acceptedAt,
    eligibleAt: new Date(acceptedAt.getTime() + delayHours * HOUR_MS),
    status: arm === "no_reminder" ? "control" : "waiting",
    attempts: 0,
    lastAttemptAt: null,
    sentAt: null,
    repliedAt: null,
    seenAt: null,
    seenReceivedAt: null,
    engagedAt: null,
    engagedReceivedAt: null,
    suppressionReason: null,
    suppressedAt: null,
    completionCandidates: [],
    confirmedDuplicateSend: false,
    ...overrides,
  };
}

function finalContext(overrides: Record<string, unknown> = {}) {
  return {
    isFullExperimentRange: true,
    enrollmentClosedAt: CLOSED_AT,
    minimumMaturedPerTimingArm: 100,
    ...overrides,
  };
}

function population(
  arm: TimingMetricRow["timingArm"],
  assigned: number,
  completed: number,
  options: { attempted?: boolean; failed?: number; uncertain?: number } = {},
): TimingMetricRow[] {
  return Array.from({ length: assigned }, (_, index) => {
    const completionCandidates =
      index < completed
        ? [{ keywordId: "keyword-protein", completedAt: new Date(ACCEPTED.getTime() + 24 * HOUR_MS) }]
        : [];
    const failed = index < (options.failed ?? 0);
    const uncertain = !failed && index < (options.failed ?? 0) + (options.uncertain ?? 0);
    return metricRow(`${arm}-${index}`, arm, {
      acceptedAt: new Date(ACCEPTED.getTime() + index),
      completionCandidates,
      attempts: options.attempted ? 1 : 0,
      lastAttemptAt: options.attempted
        ? new Date(ACCEPTED.getTime() + 2 * HOUR_MS)
        : null,
      status: failed ? "send_failed" : uncertain ? "send_uncertain" : arm === "no_reminder" ? "control" : "sent",
      sentAt:
        options.attempted && !failed && !uncertain
          ? new Date(ACCEPTED.getTime() + 3 * HOUR_MS)
          : null,
    });
  });
}

function reportFor(
  rows: TimingMetricRow[],
  context = finalContext(),
  asOf = AS_OF,
) {
  return calculateRecoveryTimingMetrics({ rows, asOf, analysis: context });
}

describe("timing outcome boundaries", () => {
  it("treats exact 48-hour maturity and completion boundaries as inclusive", () => {
    const boundary = new Date(ACCEPTED.getTime() + 48 * HOUR_MS);
    expect(isMatured(ACCEPTED, boundary)).toBe(true);
    expect(completedWithin(ACCEPTED, boundary, 48)).toBe(true);
    expect(completedWithin(ACCEPTED, new Date(boundary.getTime() + 1), 48)).toBe(false);
  });

  it("anchors outcomes to acceptance, so a six-hour follower can complete first", () => {
    const row = metricRow("early-six", "six_hour", {
      completionCandidates: [
        {
          keywordId: "keyword-protein",
          completedAt: new Date(ACCEPTED.getTime() + 5 * HOUR_MS),
        },
      ],
    });

    const report = reportFor([row]);
    expect(report.arms.six_hour.completedWithin24h).toBe(1);
    expect(row.completionCandidates[0]!.completedAt < row.eligibleAt).toBe(true);
  });
});

describe("unique follower and completion evidence", () => {
  it("selects the earliest accepted journey, with id as the stable tie-break", () => {
    const rows = [
      metricRow("later", "two_hour", {
        igUserId: "same-follower",
        acceptedAt: new Date(ACCEPTED.getTime() + HOUR_MS),
        completionCandidates: [
          { keywordId: "keyword-protein", completedAt: new Date(ACCEPTED.getTime() + 2 * HOUR_MS) },
        ],
      }),
      metricRow("b", "two_hour", { igUserId: "same-follower" }),
      metricRow("a", "two_hour", { igUserId: "same-follower" }),
    ];

    const report = reportFor(rows);
    expect(report.indexFollowers).toBe(1);
    expect(report.arms.two_hour.assigned).toBe(1);
    expect(report.arms.two_hour.completedWithin48h).toBe(0);
  });

  it("counts the earliest same-keyword sibling completion once and ignores another keyword", () => {
    const row = metricRow("sibling", "two_hour", {
      completionCandidates: [
        { keywordId: "keyword-sleep", completedAt: new Date(ACCEPTED.getTime() + HOUR_MS) },
        { keywordId: "keyword-protein", completedAt: new Date(ACCEPTED.getTime() + 8 * HOUR_MS) },
        { keywordId: "keyword-protein", completedAt: new Date(ACCEPTED.getTime() + 12 * HOUR_MS) },
      ],
    });

    const report = reportFor([row]);
    expect(report.arms.two_hour.completedWithin24h).toBe(1);
    expect(report.arms.two_hour.completedWithin48h).toBe(1);
  });

  it("uses a completed suppression stamp as trustworthy completion evidence", () => {
    const report = reportFor([
      metricRow("suppressed-complete", "two_hour", {
        status: "suppressed",
        suppressionReason: "completed_elsewhere",
        suppressedAt: new Date(ACCEPTED.getTime() + 10 * HOUR_MS),
      }),
    ]);
    expect(report.arms.two_hour.completedWithin48h).toBe(1);
  });

  it("reports followers persisted under multiple arms and forces safety review", () => {
    const rows = [
      metricRow("first", "two_hour", { igUserId: "drifted" }),
      metricRow("second", "six_hour", {
        igUserId: "drifted",
        acceptedAt: new Date(ACCEPTED.getTime() + 1),
      }),
    ];

    const report = reportFor(rows);
    expect(report.assignmentDriftFollowers).toBe(1);
    expect(report.decision).toBe("safety_review");
  });
});

describe("arm operational summary", () => {
  it("reports maturity, outcomes, safety rates, suppression, allocation, and latency", () => {
    const attemptedAt = new Date(ACCEPTED.getTime() + 2 * HOUR_MS);
    const rows = [
      metricRow("rich", "two_hour", {
        status: "sent",
        attempts: 2,
        lastAttemptAt: attemptedAt,
        sentAt: new Date(ACCEPTED.getTime() + 2 * HOUR_MS + 5 * 60_000),
        repliedAt: new Date(ACCEPTED.getTime() + 48 * HOUR_MS),
        seenAt: new Date(ACCEPTED.getTime() + HOUR_MS),
        seenReceivedAt: new Date(ACCEPTED.getTime() + 3 * HOUR_MS),
        completionCandidates: [
          { keywordId: "keyword-protein", completedAt: new Date(ACCEPTED.getTime() + 24 * HOUR_MS) },
        ],
        confirmedDuplicateSend: true,
      }),
      metricRow("cooldown", "two_hour", {
        status: "suppressed",
        suppressionReason: "person_cooldown",
        suppressedAt: new Date(ACCEPTED.getTime() + 2 * HOUR_MS),
      }),
      metricRow("failed", "two_hour", {
        status: "send_failed",
        attempts: 1,
        lastAttemptAt: attemptedAt,
      }),
      metricRow("uncertain", "two_hour", {
        status: "send_uncertain",
        attempts: 1,
        lastAttemptAt: attemptedAt,
      }),
      metricRow("immature", "two_hour", {
        acceptedAt: new Date(AS_OF.getTime() - 24 * HOUR_MS),
      }),
      metricRow("six", "six_hour"),
      metricRow("control", "no_reminder"),
    ];

    const report = reportFor(rows);
    expect(report.arms.two_hour).toMatchObject({
      assigned: 5,
      matured: 4,
      immature: 1,
      completedWithin24h: 1,
      completedWithin48h: 1,
      repliedWithin24h: 0,
      repliedWithin48h: 1,
      seenBeforeEligibility: 1,
      sent: 1,
      attempted: 3,
      suppressed: 1,
      sendFailed: 1,
      sendUncertain: 1,
      delayedSignalFalsePositives: 1,
      lateSendCount: 1,
      cooldownSuppressions: 1,
      duplicateAttemptCount: 1,
      confirmedDuplicateSends: 1,
      suppressionReasons: { person_cooldown: 1 },
    });
    expect(report.arms.two_hour.completionRate48h).toBe(25);
    expect(report.arms.two_hour.sendExceptionRate).toBeCloseTo(66.6667, 3);
    expect(report.arms.two_hour.delayedSignalFalsePositiveRate).toBeCloseTo(33.3333, 3);
    expect(report.arms.two_hour.readEventCoveragePercent).toBe(20);
    expect(report.arms.two_hour.allocationPercent).toBeCloseTo((5 / 7) * 100, 8);
    expect(report.arms.two_hour.latenessMs).toEqual({
      p50: 5 * 60_000,
      p95: 5 * 60_000,
      max: 5 * 60_000,
    });
    expect(report.arms.two_hour.reminderToReplyMinutesMedian).toBe(2_755);
    expect(report.duplicateSafetyEvent).toBe(true);
  });

  it("returns null attempt rates and latency summaries when denominators are empty", () => {
    const summary = reportFor([metricRow("control", "no_reminder")]).arms.no_reminder;
    expect(summary.sendExceptionRate).toBeNull();
    expect(summary.delayedSignalFalsePositiveRate).toBeNull();
    expect(summary.reminderToReplyMinutesMedian).toBeNull();
    expect(summary.latenessMs).toEqual({ p50: null, p95: null, max: null });
  });

  it("reports p50, p95, and maximum lateness across sent index followers", () => {
    const delays = [2, 10, 20];
    const rows = delays.map((minutes, index) =>
      metricRow(`late-${index}`, "two_hour", {
        status: "sent",
        attempts: 1,
        lastAttemptAt: new Date(ACCEPTED.getTime() + 2 * HOUR_MS),
        sentAt: new Date(ACCEPTED.getTime() + 2 * HOUR_MS + minutes * 60_000),
      }),
    );

    expect(reportFor(rows).arms.two_hour.latenessMs).toEqual({
      p50: 10 * 60_000,
      p95: 19 * 60_000,
      max: 20 * 60_000,
    });
  });
});

describe("two-proportion statistics", () => {
  it("uses pooled p-values and unpooled 95% confidence intervals", () => {
    const comparison = compareProportions(600, 1_000, 550, 1_000);
    expect(comparison.differencePercentagePoints).toBeCloseTo(5, 8);
    expect(comparison.zScore).toBeGreaterThan(2);
    expect(comparison.pValue).toBeLessThan(0.05);
    expect(comparison.confidenceInterval95!.low).toBeGreaterThan(0);
  });

  it("returns null statistics when either denominator is zero", () => {
    expect(compareProportions(0, 0, 1, 10)).toEqual({
      differencePercentagePoints: null,
      confidenceInterval95: null,
      zScore: null,
      pValue: null,
    });
  });
});

describe("experiment decision", () => {
  function decisionPopulation(
    two: [number, number],
    six: [number, number],
    control: [number, number] = [200, 84],
    options: { twoFailures?: number; duplicate?: boolean } = {},
  ): TimingMetricRow[] {
    const rows = [
      ...population("two_hour", two[0], two[1], {
        attempted: true,
        failed: options.twoFailures,
      }),
      ...population("six_hour", six[0], six[1], { attempted: true }),
      ...population("no_reminder", control[0], control[1]),
    ];
    if (options.duplicate) rows[0]!.confirmedDuplicateSend = true;
    return rows;
  }

  it("declares a two-hour winner only with practical and statistical evidence", () => {
    const report = reportFor(decisionPopulation([1_000, 450], [1_000, 400]));
    expect(report.comparison.differencePercentagePoints).toBeCloseTo(5, 8);
    expect(report.comparison.pValue).toBeLessThan(0.05);
    expect(report.decision).toBe("two_hour_wins");
  });

  it("declares a six-hour winner under the same rule", () => {
    const report = reportFor(decisionPopulation([1_000, 400], [1_000, 450]));
    expect(report.decision).toBe("six_hour_wins");
  });

  it("keeps a statistically significant difference below two points inconclusive", () => {
    const report = reportFor(
      decisionPopulation([10_000, 5_100], [10_000, 4_910], [500, 250]),
    );
    expect(report.comparison.pValue).toBeLessThan(0.05);
    expect(report.comparison.differencePercentagePoints).toBeCloseTo(1.9, 8);
    expect(report.decision).toBe("inconclusive");
  });

  it("keeps a practical but non-significant difference inconclusive", () => {
    const report = reportFor(decisionPopulation([100, 55], [100, 50], [100, 52]));
    expect(report.comparison.differencePercentagePoints).toBeCloseTo(5, 8);
    expect(report.comparison.pValue).toBeGreaterThanOrEqual(0.05);
    expect(report.decision).toBe("inconclusive");
  });

  it("blocks an apparent winner whose send-exception rate is materially worse", () => {
    const report = reportFor(
      decisionPopulation([1_000, 450], [1_000, 400], [200, 84], {
        twoFailures: 30,
      }),
    );
    expect(report.safety.twoHourMateriallyWorse).toBe(true);
    expect(report.decision).toBe("safety_review");
  });

  it("blocks an apparent winner whose delayed-signal rate is materially worse", () => {
    const rows = decisionPopulation([1_000, 450], [1_000, 400]);
    for (const row of rows.filter((candidate) => candidate.timingArm === "two_hour").slice(0, 30)) {
      row.seenAt = new Date(ACCEPTED.getTime() + HOUR_MS);
      row.seenReceivedAt = new Date(ACCEPTED.getTime() + 3 * HOUR_MS);
    }

    const report = reportFor(rows);
    expect(report.arms.two_hour.delayedSignalFalsePositiveRate).toBe(3);
    expect(report.safety.twoHourMateriallyWorse).toBe(true);
    expect(report.decision).toBe("safety_review");
  });

  it("blocks rollout for any confirmed duplicate", () => {
    const report = reportFor(
      decisionPopulation([1_000, 450], [1_000, 400], [200, 84], {
        duplicate: true,
      }),
    );
    expect(report.duplicateSafetyEvent).toBe(true);
    expect(report.decision).toBe("safety_review");
  });

  it("triggers harm review when both treatments are at least two points below control", () => {
    const report = reportFor(decisionPopulation([1_000, 450], [1_000, 440], [1_000, 500]));
    expect(report.safety.controlPointEstimateHarm).toBe(true);
    expect(report.decision).toBe("safety_review");
  });

  it("triggers harm review when a treatment-control CI is wholly below zero", () => {
    const report = reportFor(decisionPopulation([1_000, 400], [1_000, 500], [1_000, 500]));
    expect(report.safety.treatmentControlConfidenceHarm).toBe(true);
    expect(report.decision).toBe("safety_review");
  });

  it("labels a partial date range exploratory even when numbers look decisive", () => {
    const report = reportFor(
      decisionPopulation([1_000, 450], [1_000, 400]),
      finalContext({ isFullExperimentRange: false }),
    );
    expect(report.decision).toBe("exploratory");
  });

  it("keeps an open enrollment collecting", () => {
    const report = reportFor(
      decisionPopulation([1_000, 450], [1_000, 400]),
      finalContext({ enrollmentClosedAt: null }),
    );
    expect(report.decision).toBe("collecting");
  });

  it("keeps final analysis collecting until 48 hours after enrollment closes", () => {
    const report = reportFor(
      decisionPopulation([1_000, 450], [1_000, 400]),
      finalContext({ enrollmentClosedAt: new Date(AS_OF.getTime() - 47 * HOUR_MS) }),
    );
    expect(report.decision).toBe("collecting");
  });

  it("is inconclusive below the default 1,700 matured timing followers", () => {
    const rows = decisionPopulation([1_699, 760], [1_699, 680]);
    const report = reportFor(rows, {
      isFullExperimentRange: true,
      enrollmentClosedAt: CLOSED_AT,
    });
    expect(report.decision).toBe("inconclusive");
  });
});
