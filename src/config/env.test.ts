import { describe, expect, it } from "vitest";
import { envSchema, FORBIDDEN_SETTINGS_SIGNATURE } from "./env.js";

const baseEnv = {
  META_APP_SECRET: "mock_secret",
  META_VERIFY_TOKEN: "mock_verify",
  IG_ACCESS_TOKEN: "mock_access",
  IG_USER_ID: "12345",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
  SUPABASE_URL: "https://mock.supabase.co",
  SUPABASE_SERVICE_KEY: "mock_service_key",
};

describe("env configuration schema for guide delivery", () => {
  it("uses the safe worker policy defaults", () => {
    expect(envSchema.parse(baseEnv)).toMatchObject({
      GUIDE_DELIVERY_BATCH_SIZE: 10,
      GUIDE_DELIVERY_LEASE_MS: 300_000,
      GUIDE_DELIVERY_MAX_ATTEMPTS: 3,
      GUIDE_DELIVERY_RETRY_BASE_MS: 60_000,
      GUIDE_DELIVERY_WORKER_INTERVAL_MS: 60_000,
    });
  });

  it.each([
    ["GUIDE_DELIVERY_BATCH_SIZE", "0"],
    ["GUIDE_DELIVERY_BATCH_SIZE", "51"],
    ["GUIDE_DELIVERY_LEASE_MS", "59999"],
    ["GUIDE_DELIVERY_MAX_ATTEMPTS", "0"],
    ["GUIDE_DELIVERY_MAX_ATTEMPTS", "11"],
    ["GUIDE_DELIVERY_RETRY_BASE_MS", "9999"],
    ["GUIDE_DELIVERY_WORKER_INTERVAL_MS", "9999"],
  ])("rejects unsafe %s=%s", (name, value) => {
    expect(envSchema.safeParse({ ...baseEnv, [name]: value }).success).toBe(false);
  });

  it.each([
    ["GUIDE_DELIVERY_BATCH_SIZE", "50", 50],
    ["GUIDE_DELIVERY_LEASE_MS", "60000", 60_000],
    ["GUIDE_DELIVERY_MAX_ATTEMPTS", "10", 10],
    ["GUIDE_DELIVERY_RETRY_BASE_MS", "10000", 10_000],
    ["GUIDE_DELIVERY_WORKER_INTERVAL_MS", "10000", 10_000],
  ])("coerces the valid %s boundary", (name, value, expected) => {
    expect(envSchema.parse({ ...baseEnv, [name]: value })[name]).toBe(expected);
  });
});

describe("env configuration schema for DM recovery", () => {
  it("parses default DM recovery configuration correctly", () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed).toMatchObject({
      DM_RECOVERY_ENABLED: false,
      DM_RECOVERY_DELAY_HOURS: 10,
      DM_RECOVERY_COOLDOWN_HOURS: 24,
      DM_RECOVERY_WORKER_INTERVAL_MS: 60000,
      DM_RECOVERY_BATCH_SIZE: 5,
      DM_RECOVERY_HOURLY_CAP: 30,
      DM_RECOVERY_GLOBAL_DAILY_CAP: 100,
      DM_RECOVERY_LEASE_MS: 900000,
      DM_RECOVERY_MAX_ATTEMPTS: 3,
      DM_RECOVERY_RETRY_BASE_MS: 300000,
      DM_RECOVERY_HOLDOUT_PERCENT: 10,
      DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-v1",
      DM_RECOVERY_POST_EXPERIMENT_ENABLED: false,
      DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: "",
      DM_RECOVERY_HEALTH_SAMPLE_SIZE: 50,
      DM_RECOVERY_FAILURE_RATE_PERCENT: 50,
      DM_RECOVERY_BACKLOG_ALERT_THRESHOLD: 500,
      DM_RECOVERY_DB_FAILURE_THRESHOLD: 3,
      DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE: 20,
    });
  });

  it("accepts a positive global daily public-recovery cap", () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      DM_RECOVERY_GLOBAL_DAILY_CAP: "250",
    });

    expect(parsed.DM_RECOVERY_GLOBAL_DAILY_CAP).toBe(250);
  });

  it("rejects a zero global daily public-recovery cap", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_GLOBAL_DAILY_CAP: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects when only one of experiment start or end is provided", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-06T08:00:00Z",
      }).success,
    ).toBe(false);

    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-20T08:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("rejects when experiment end is not after start", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-20T08:00:00Z",
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-06T08:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("accepts valid experiment start and end dates", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-06T08:00:00Z",
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-20T08:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid boolean flag strings", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_ENABLED: "flase",
      }).success,
    ).toBe(false);
  });

  it("requires experiment start/end dates when DM_RECOVERY_ENABLED is true", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_ENABLED: "true",
      }).success,
    ).toBe(false);

    expect(
      envSchema.safeParse({
        ...baseEnv,
        DM_RECOVERY_ENABLED: "true",
        DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-06T08:00:00Z",
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-20T08:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("normalizes empty string experiment dates to undefined", () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      DM_RECOVERY_EXPERIMENT_START_AT: "",
      DM_RECOVERY_EXPERIMENT_END_AT: "",
    });
    expect(parsed.DM_RECOVERY_EXPERIMENT_START_AT).toBeUndefined();
    expect(parsed.DM_RECOVERY_EXPERIMENT_END_AT).toBeUndefined();
  });

  // A malformed signature is dropped silently by the parser, which would leave
  // the settings fallback disarmed while looking configured. Fail at startup.
  it.each([
    ["empty (the shipped default)", "", true],
    ["one valid pair", "10:12345", true],
    ["several valid pairs with spacing", "10:12345, 25:9876", true],
    ["a wrong separator", "100;2534025", false],
    ["a missing subcode", "100:", false],
    ["one bad pair among good ones", "10:12345, oops", false],
  ])("accepts settings signatures that are %s", (_label, value, valid) => {
    expect(
      envSchema.safeParse({ ...baseEnv, DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: value }).success,
    ).toBe(valid);
  });

  // 100:2534025 is "the comment is invalid for a private reply" — the
  // invalid-comment family, not a settings rejection — and 1,347 of the 1,356
  // dm_failed events in production history. Allowlisting it would publicly tell
  // over a thousand people their message-request settings blocked a DM those
  // settings never touched. The docs forbid it; this makes the refusal real.
  it.each([
    ["alone", FORBIDDEN_SETTINGS_SIGNATURE],
    ["among valid pairs", `10:12345, ${FORBIDDEN_SETTINGS_SIGNATURE}`],
    ["with surrounding whitespace", `  ${FORBIDDEN_SETTINGS_SIGNATURE}  `],
  ])("refuses the invalid-comment signature %s", (_label, value) => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: value,
    });

    expect(result.success).toBe(false);
    // The message must explain WHY, not just reject: whoever hits this is
    // reading the docs cold and reaching for the obvious pair.
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(" ");
      expect(message).toContain("not a settings rejection");
      expect(message).toContain("docs/meta-verification.md");
    }
  });
});
