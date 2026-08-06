import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

const baseEnv = {
  META_APP_SECRET: "mock_secret",
  META_VERIFY_TOKEN: "mock_verify",
  IG_ACCESS_TOKEN: "mock_access",
  IG_USER_ID: "12345",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
  SUPABASE_URL: "https://mock.supabase.co",
  SUPABASE_SERVICE_KEY: "mock_service_key",
};

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
});
