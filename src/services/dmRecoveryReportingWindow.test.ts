import { describe, expect, it } from "vitest";
import { resolveRecoveryReportingWindow } from "./dmRecoveryReportingWindow.js";

const COVERAGE = { from: "2026-07-01", to: "2026-08-16" };
const AS_OF = new Date("2026-08-17T03:00:00.000Z");
const NOW = new Date("2026-08-17T03:00:01.000Z");

describe("DM recovery Pacific reporting window", () => {
  it("defaults to the latest 30 inclusive Pacific days and reports maturity", () => {
    expect(
      resolveRecoveryReportingWindow({
        coverage: COVERAGE,
        requested: null,
        asOf: AS_OF,
        now: NOW,
      }),
    ).toMatchObject({
      coverage: COVERAGE,
      effectiveRange: { from: "2026-07-18", to: "2026-08-16" },
      resultsCompleteThrough: "2026-08-13",
      isFullCoverage: false,
      empty: false,
    });
  });

  it.each([
    ["7d", { from: "2026-08-10", to: "2026-08-16" }],
    ["14d", { from: "2026-08-03", to: "2026-08-16" }],
    ["30d", { from: "2026-07-18", to: "2026-08-16" }],
    ["all", COVERAGE],
  ] as const)("resolves the %s preset", (preset, effectiveRange) => {
    expect(
      resolveRecoveryReportingWindow({
        coverage: COVERAGE,
        requested: { preset },
        asOf: AS_OF,
        now: NOW,
      }).effectiveRange,
    ).toEqual(effectiveRange);
  });

  it("clamps an overlapping custom range to available v2 coverage", () => {
    const result = resolveRecoveryReportingWindow({
      coverage: COVERAGE,
      requested: { from: "2026-06-25", to: "2026-07-05" },
      asOf: AS_OF,
      now: NOW,
    });

    expect(result.requestedRange).toEqual({ from: "2026-06-25", to: "2026-07-05" });
    expect(result.effectiveRange).toEqual({ from: "2026-07-01", to: "2026-07-05" });
  });

  it("returns the half-open UTC acceptedAt predicate", () => {
    const result = resolveRecoveryReportingWindow({
      coverage: COVERAGE,
      requested: { from: "2026-08-01", to: "2026-08-16" },
      asOf: AS_OF,
      now: NOW,
    });

    expect(result.acceptedAt).toEqual({
      gte: new Date("2026-08-01T07:00:00.000Z"),
      lt: new Date("2026-08-17T07:00:00.000Z"),
    });
    expect(result.maturityCutoff).toEqual(new Date("2026-08-15T03:00:00.000Z"));
  });

  it("uses calendar boundaries across both daylight-saving transitions", () => {
    const spring = resolveRecoveryReportingWindow({
      coverage: { from: "2026-03-08", to: "2026-03-08" },
      requested: { preset: "all" },
      asOf: new Date("2026-03-12T08:00:00.000Z"),
      now: new Date("2026-03-12T08:00:01.000Z"),
    });
    expect(spring.acceptedAt!.lt.getTime() - spring.acceptedAt!.gte.getTime()).toBe(
      23 * 60 * 60 * 1_000,
    );

    const fall = resolveRecoveryReportingWindow({
      coverage: { from: "2026-11-01", to: "2026-11-01" },
      requested: { preset: "all" },
      asOf: new Date("2026-11-05T08:00:00.000Z"),
      now: new Date("2026-11-05T08:00:01.000Z"),
    });
    expect(fall.acceptedAt!.lt.getTime() - fall.acceptedAt!.gte.getTime()).toBe(
      25 * 60 * 60 * 1_000,
    );
  });

  it("rejects a custom range with no coverage overlap", () => {
    expect(() =>
      resolveRecoveryReportingWindow({
        coverage: COVERAGE,
        requested: { from: "2026-06-01", to: "2026-06-30" },
        asOf: AS_OF,
        now: NOW,
      }),
    ).toThrow("range_outside_coverage");
  });

  it.each([
    [{ from: "2026-08-02", to: "2026-08-01" }, "reversed dates"],
    [{ from: "2026-02-30", to: "2026-08-01" }, "an impossible day"],
    [{ from: "08/01/2026", to: "2026-08-02" }, "a malformed day"],
  ] as const)("rejects %s", (requested) => {
    expect(() =>
      resolveRecoveryReportingWindow({
        coverage: COVERAGE,
        requested,
        asOf: AS_OF,
        now: NOW,
      }),
    ).toThrow("invalid_date_range");
  });

  it("rejects an asOf boundary later than the server clock", () => {
    expect(() =>
      resolveRecoveryReportingWindow({
        coverage: COVERAGE,
        requested: null,
        asOf: new Date("2026-08-17T03:00:02.000Z"),
        now: NOW,
      }),
    ).toThrow("future_as_of");
  });

  it("returns an empty report without inventing dates when coverage is empty", () => {
    expect(
      resolveRecoveryReportingWindow({
        coverage: null,
        requested: null,
        asOf: AS_OF,
        now: NOW,
      }),
    ).toMatchObject({
      coverage: null,
      requestedRange: null,
      effectiveRange: null,
      acceptedAt: null,
      resultsCompleteThrough: null,
      empty: true,
    });
  });
});
