import { describe, expect, it } from "vitest";
import {
  envSchema,
  FORBIDDEN_SETTINGS_SIGNATURE,
  guideDeliveryCohortIgUserIds,
  parseIdentifierSet,
} from "./env.js";

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
  it("keeps NVIDIA guide-audience enforcement disabled unless explicitly configured", () => {
    expect(envSchema.parse(baseEnv)).not.toHaveProperty("NVIDIA_API_KEY");
    expect(envSchema.parse(baseEnv)).toMatchObject({
      NVIDIA_AUDIENCE_MODEL: "nvidia/nemotron-3.5-lightning-30b-a3b",
      NVIDIA_AUDIENCE_TIMEOUT_MS: 8_000,
      NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS: 30_000,
      GUIDE_AUDIENCE_BLOCK_ENABLED: false,
    });
    expect(
      envSchema.parse({
        ...baseEnv,
        NVIDIA_API_KEY: "test-key",
        NVIDIA_AUDIENCE_TIMEOUT_MS: "9000",
        NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS: "12000",
        GUIDE_AUDIENCE_BLOCK_ENABLED: "true",
      }),
    ).toMatchObject({
      NVIDIA_API_KEY: "test-key",
      NVIDIA_AUDIENCE_TIMEOUT_MS: 9_000,
      NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS: 12_000,
      GUIDE_AUDIENCE_BLOCK_ENABLED: true,
    });
  });

  it("defaults the DM intent guard off with an empty controlled-recipient allowlist", () => {
    expect(envSchema.parse(baseEnv)).toMatchObject({
      GUIDE_DM_INTENT_GUARD_ENABLED: false,
      GUIDE_DM_INTENT_GUARD_IG_USER_IDS: "",
    });
  });

  it("parses the DM intent guard with strict boolean semantics", () => {
    expect(
      envSchema.parse({
        ...baseEnv,
        GUIDE_DM_INTENT_GUARD_ENABLED: "true",
        GUIDE_DM_INTENT_GUARD_IG_USER_IDS: " account-1, account-2 ",
      }),
    ).toMatchObject({
      GUIDE_DM_INTENT_GUARD_ENABLED: true,
      GUIDE_DM_INTENT_GUARD_IG_USER_IDS: " account-1, account-2 ",
    });
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_DM_INTENT_GUARD_ENABLED: "flase" }).success,
    ).toBe(false);
  });

  it("defaults the strict follower and rich-message gates off with empty allowlists", () => {
    expect(envSchema.parse(baseEnv)).toMatchObject({
      GUIDE_FOLLOW_GATE_V2_ENABLED: false,
      GUIDE_RICH_GATE_ENABLED: false,
      GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS: "",
      GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS: "",
    });
  });

  it("parses strict-gate allowlists as exact, trimmed, de-duplicated IDs", () => {
    expect([...parseIdentifierSet(" account-1, , account-2,account-1 ")]).toEqual([
      "account-1",
      "account-2",
    ]);
  });

  it("keeps an enabled strict gate inert when neither account nor guide is allowlisted", () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      GUIDE_FOLLOW_GATE_V2_ENABLED: "true",
    });

    expect(parsed.GUIDE_FOLLOW_GATE_V2_ENABLED).toBe(true);
    expect(parseIdentifierSet(parsed.GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS)).toHaveProperty(
      "size",
      0,
    );
    expect(parseIdentifierSet(parsed.GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS)).toHaveProperty(
      "size",
      0,
    );
  });

  it("parses both strict-gate switches with booleanFlag semantics", () => {
    expect(
      envSchema.parse({
        ...baseEnv,
        GUIDE_FOLLOW_GATE_V2_ENABLED: "true",
        GUIDE_RICH_GATE_ENABLED: "true",
      }),
    ).toMatchObject({
      GUIDE_FOLLOW_GATE_V2_ENABLED: true,
      GUIDE_RICH_GATE_ENABLED: true,
    });
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_FOLLOW_GATE_V2_ENABLED: "flase" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_RICH_GATE_ENABLED: "maybe" }).success,
    ).toBe(false);
  });

  it("keeps guide cover authoring disabled unless explicitly enabled", () => {
    expect(envSchema.parse(baseEnv).GUIDE_COVER_AUTHORING_ENABLED).toBe(false);
    expect(
      envSchema.parse({
        ...baseEnv,
        GUIDE_COVER_AUTHORING_ENABLED: "true",
      }).GUIDE_COVER_AUTHORING_ENABLED,
    ).toBe(true);
  });

  it("requires both settings for the external guide-cover media gateway", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        GUIDE_COVER_MEDIA_BASE_URL: "https://media.example.test",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...baseEnv,
        GUIDE_COVER_MEDIA_WRITE_TOKEN: "a".repeat(32),
      }).success,
    ).toBe(false);
    expect(
      envSchema.parse({
        ...baseEnv,
        GUIDE_COVER_MEDIA_BASE_URL: "https://media.example.test",
        GUIDE_COVER_MEDIA_WRITE_TOKEN: "a".repeat(32),
      }),
    ).toMatchObject({
      GUIDE_COVER_MEDIA_BASE_URL: "https://media.example.test",
      GUIDE_COVER_MEDIA_WRITE_TOKEN: "a".repeat(32),
    });
  });

  it("uses conservative bounded guide-cover orphan cleanup settings", () => {
    expect(envSchema.parse(baseEnv)).toMatchObject({
      GUIDE_COVER_ORPHAN_BATCH: 10,
      GUIDE_COVER_ORPHAN_INTERVAL_MS: 900_000,
    });
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_COVER_ORPHAN_BATCH: "0" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_COVER_ORPHAN_BATCH: "51" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...baseEnv, GUIDE_COVER_ORPHAN_INTERVAL_MS: "59999" })
        .success,
    ).toBe(false);
  });

  it("defaults guide delivery to a disabled, bounded rollout", () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed).toMatchObject({
      GUIDE_DELIVERY_BATCH_SIZE: 10,
      GUIDE_DELIVERY_LEASE_MS: 300_000,
      GUIDE_DELIVERY_MAX_ATTEMPTS: 3,
      GUIDE_DELIVERY_RETRY_BASE_MS: 60_000,
      GUIDE_DELIVERY_WORKER_INTERVAL_MS: 60_000,
      GUIDE_DELIVERY_ENABLED: false,
      GUIDE_DELIVERY_ROLLOUT_PERCENT: 0,
      GUIDE_DELIVERY_COHORT_IG_USER_IDS: "",
    });
  });

  it("requires an explicit cohort or percentage before guide delivery can be enabled", () => {
    expect(envSchema.safeParse({ ...baseEnv, GUIDE_DELIVERY_ENABLED: "true" }).success).toBe(false);
    expect(
      envSchema.safeParse({
        ...baseEnv,
        GUIDE_DELIVERY_ENABLED: "true",
        GUIDE_DELIVERY_COHORT_IG_USER_IDS: " 123, , 456 ",
      }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({
        ...baseEnv,
        GUIDE_DELIVERY_ENABLED: "true",
        GUIDE_DELIVERY_ROLLOUT_PERCENT: "1",
      }).success,
    ).toBe(true);
  });

  it("parses controlled guide recipients as trimmed, non-empty stable IDs", () => {
    expect([...guideDeliveryCohortIgUserIds(" 123, , 456, 123 ")]).toEqual(["123", "456"]);
  });

  it.each([
    ["GUIDE_DELIVERY_BATCH_SIZE", "0"],
    ["GUIDE_DELIVERY_BATCH_SIZE", "51"],
    ["GUIDE_DELIVERY_LEASE_MS", "59999"],
    ["GUIDE_DELIVERY_MAX_ATTEMPTS", "0"],
    ["GUIDE_DELIVERY_MAX_ATTEMPTS", "11"],
    ["GUIDE_DELIVERY_RETRY_BASE_MS", "9999"],
    ["GUIDE_DELIVERY_WORKER_INTERVAL_MS", "9999"],
    ["GUIDE_DELIVERY_ROLLOUT_PERCENT", "-1"],
    ["GUIDE_DELIVERY_ROLLOUT_PERCENT", "101"],
  ])("rejects invalid guide delivery setting %s=%s", (key, value) => {
    expect(envSchema.safeParse({ ...baseEnv, [key]: value }).success).toBe(false);
  });

  it("keeps upcoming automation discovery off unless explicitly enabled", () => {
    expect(envSchema.parse(baseEnv).UPCOMING_AUTOMATIONS_ENABLED).toBe(false);
    expect(
      envSchema.parse({ ...baseEnv, UPCOMING_AUTOMATIONS_ENABLED: "true" })
        .UPCOMING_AUTOMATIONS_ENABLED,
    ).toBe(true);
  });

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

  describe("read-recovery-timing-v2 guardrails", () => {
    const v2Base = {
      ...baseEnv,
      DM_RECOVERY_ENABLED: "true",
      DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-timing-v2",
      DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-21T12:00:00.000Z",
      DM_RECOVERY_POST_EXPERIMENT_ENABLED: "false",
    };

    it.each([
      ["28 days", "2026-09-18T12:00:00.000Z"],
      ["42 days", "2026-10-02T12:00:00.000Z"],
    ])("accepts an enrollment window lasting %s", (_label, endAt) => {
      expect(
        envSchema.safeParse({
          ...v2Base,
          DM_RECOVERY_EXPERIMENT_END_AT: endAt,
        }).success,
      ).toBe(true);
    });

    it.each([
      ["27 days", "2026-09-17T12:00:00.000Z"],
      ["43 days", "2026-10-03T12:00:00.000Z"],
    ])("rejects an enrollment window lasting %s", (_label, endAt) => {
      expect(
        envSchema.safeParse({
          ...v2Base,
          DM_RECOVERY_EXPERIMENT_END_AT: endAt,
        }).success,
      ).toBe(false);
    });

    it("rejects post-experiment assignment", () => {
      const result = envSchema.safeParse({
        ...v2Base,
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-10-02T12:00:00.000Z",
        DM_RECOVERY_POST_EXPERIMENT_ENABLED: "true",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ["DM_RECOVERY_POST_EXPERIMENT_ENABLED"] }),
          ]),
        );
      }
    });

    it("rejects a V2 start that differs from the approved cutover", () => {
      const result = envSchema.safeParse({
        ...v2Base,
        DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-22T16:00:00.000Z",
        DM_RECOVERY_EXPERIMENT_END_AT: "2026-10-03T16:00:00.000Z",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ["DM_RECOVERY_EXPERIMENT_START_AT"] }),
          ]),
        );
      }
    });

    it("does not apply v2 duration limits to the legacy experiment", () => {
      expect(
        envSchema.safeParse({
          ...baseEnv,
          DM_RECOVERY_ENABLED: "true",
          DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-v1",
          DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-17T07:00:00.000Z",
          DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-31T07:00:00.000Z",
        }).success,
      ).toBe(true);
    });
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
