import "dotenv/config";
import { z } from "zod";
import { booleanFlag } from "./booleanFlag.js";

/**
 * The one Graph signature that must never enter the settings-blocked allowlist.
 * Exported so the classifier's tests can name it rather than repeat the literal.
 */
export const FORBIDDEN_SETTINGS_SIGNATURE = "100:2534025";

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  IG_ACCESS_TOKEN: z.string().min(1),
  IG_USER_ID: z.string().min(1),

  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_BUCKET: z.string().min(1).default("insta-resources"),

  // Comma-separated allowlist of one or more admin emails. Each entry must be a
  // valid email so a typo can't silently widen access. Parsed into a list in
  // requireAdmin (src/api/auth.ts).
  ADMIN_EMAIL: z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
          .every((e) => z.string().email().safeParse(e).success),
      { message: "Must be a comma-separated list of valid emails" },
    ),
  WEB_ORIGIN: z.string().optional(),

  // Gate retry worker pacing. Defaults are conservative; can be tuned without a
  // code change. GATE_RETRY_BATCH = max private replies attempted per worker tick.
  GATE_RETRY_BATCH: z.coerce.number().int().min(1).max(100).default(8),
  // Max send attempts per queued gate. Successful sends land on attempt 1 in
  // practice; the cap bounds the delivered-but-API-errored case where Meta
  // returns an error for a private reply it actually delivered (real inboxes
  // received 30+ copies before this existed). Mirrors Gemini's MAX_ATTEMPTS.
  GATE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  // Run the standard-DM experiment on aged/exhausted users (measures whether a
  // cold standard DM is ever accepted). Off by default.
  GATE_DM_EXPERIMENT: booleanFlag(false),

  // --- Insights (reel analysis) ---
  // Newer Graph version for insights/demographics/media_audio_type calls. Kept
  // separate from the v21.0 messaging client so the rate-limit-sensitive
  // comment/gate flow is never disturbed by a version bump.
  INSIGHTS_GRAPH_VERSION: z.string().default("v23.0"),
  // Gemini watches each reel and returns a US-cultural-fit content profile.
  // Optional: when unset, Gemini features degrade (queue worker no-ops, scores
  // fall back to low-confidence) but the app still boots and serves everything else.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  // Max Gemini spend per UTC day (USD). The queue worker stops for the day once
  // summed cost crosses this — a hard guard against runaway analysis cost.
  GEMINI_DAILY_BUDGET_USD: z.coerce.number().min(0).default(5),
  // Reels analyzed per Gemini worker tick.
  GEMINI_BATCH: z.coerce.number().int().min(1).max(50).default(5),
  // Worker pacing (ms). Snapshot self-throttles on the newest snapshot age so a
  // small dev interval can't spam the Graph API.
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(60_000).default(6 * 60 * 60 * 1000),
  // Regular FEED-post follow attribution. The worker can retry throughout the
  // day, while its composite key keeps storage to one latest row per Pacific analytics day.
  FEED_FOLLOW_SNAPSHOT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60 * 1000),
  GEMINI_QUEUE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(2 * 60 * 1000),

  // --- Follow-recheck worker (fix #11: funnel follower yield) ---
  // Days after a guide is delivered before we re-read the recipient's follow
  // status (gives them time to follow). Single pass; a lower bound on yield.
  FOLLOW_RECHECK_DELAY_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  // Stop chasing conversations older than this (keeps the due-set bounded).
  FOLLOW_RECHECK_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Distinct convertible users re-read per worker tick (each = one Graph call).
  FOLLOW_RECHECK_BATCH: z.coerce.number().int().min(1).max(100).default(20),
  FOLLOW_RECHECK_INTERVAL_MS: z.coerce.number().int().min(60_000).default(30 * 60 * 1000),

  // --- AI (private Codex runtime) ---------------------------------------------
  // All optional at boot: the runtime is a separate Railway service, so an API
  // deploy must keep serving webhooks, gates and guides when it is absent or
  // still starting. Owner-facing AI routes answer 503 ai_not_configured instead.
  CODEX_RUNTIME_URL: z.string().url().optional(),
  CODEX_RUNTIME_TOKEN: z.string().min(32).optional(),
  // Sent BY the runtime when calling back into this API for advisor tools
  // (Task 9/10). Distinct from CODEX_RUNTIME_TOKEN so the two directions can be
  // rotated independently and neither grants the other's access.
  TINY_SOHO_INTERNAL_TOKEN: z.string().min(32).optional(),
  // Every AI capability ships OFF. Each phase is enabled deliberately, and
  // turning one off must never disable existing automation.
  AI_DRAFTS_ENABLED: booleanFlag(false),
  AI_FOLLOW_UPS_ENABLED: booleanFlag(false),
  AI_SEND_ENABLED: booleanFlag(false),
  AI_ADVISOR_ENABLED: booleanFlag(false),
  AI_BRAND_VOICE: z
    .string()
    .max(4000)
    .default("Warm, practical, concise, and supportive. Never diagnose or shame a parent."),
  AI_DRAFT_INTERVAL_MS: z.coerce.number().int().min(5_000).default(15_000),

  // --- Resumable guide delivery ---
  // This worker is always on: an expired send claim may represent an ambiguous
  // provider outcome and must be reconciled even when no new guides are sent.
  GUIDE_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  GUIDE_DELIVERY_LEASE_MS: z.coerce.number().int().min(60_000).default(5 * 60_000),
  GUIDE_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  GUIDE_DELIVERY_RETRY_BASE_MS: z.coerce.number().int().min(10_000).default(60_000),
  GUIDE_DELIVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),

  // --- DM Recovery Reminders ---
  DM_RECOVERY_ENABLED: booleanFlag(false),
  /**
   * Historical recovery (Feature 4) sending. Separate from DM_RECOVERY_ENABLED so
   * the prospective feature can run without the historical campaigns, which contact
   * people about requests that are weeks old.
   *
   * booleanFlag, never z.coerce.boolean: coerce treats the STRING "false" as true,
   * so `DM_RECOVERY_HISTORICAL_ENABLED=false` would enable public sending.
   */
  DM_RECOVERY_HISTORICAL_ENABLED: booleanFlag(false),
  DM_RECOVERY_HISTORICAL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  DM_RECOVERY_DELAY_HOURS: z.coerce.number().int().min(1).max(168).default(10),
  DM_RECOVERY_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  DM_RECOVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  DM_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  DM_RECOVERY_HOURLY_CAP: z.coerce.number().int().min(1).max(200).default(30),
  DM_RECOVERY_GLOBAL_DAILY_CAP: z.coerce.number().int().min(1).default(100),
  DM_RECOVERY_LEASE_MS: z.coerce.number().int().min(60_000).default(900_000),
  DM_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  DM_RECOVERY_RETRY_BASE_MS: z.coerce.number().int().min(60_000).default(300_000),
  DM_RECOVERY_HOLDOUT_PERCENT: z.coerce.number().int().min(0).max(50).default(10),
  // The recovery reminder is a PUBLIC comment on the person's own comment, so
  // it is visible to that person's followers, not just to them. The account
  // sells to a Western audience; a public nudge under a South-Asian follower's
  // comment spends reach on people who will not convert and makes the feed read
  // as an Indian-market account to the US audience the algorithm is being
  // trained on. Off by default so enabling it is a deliberate act.
  DM_RECOVERY_WESTERN_ONLY: booleanFlag(false),
  // Upgrade the name-token origin guess with a Gemini pass. Measured on 50 real
  // gate users: the token list caught 3, the model caught 22, with no Western
  // false positives. Independent of DM_RECOVERY_WESTERN_ONLY so the column can
  // be populated and audited before it gates anything.
  DM_RECOVERY_ORIGIN_LLM_ENABLED: booleanFlag(false),
  DM_RECOVERY_ORIGIN_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(25),
  DM_RECOVERY_ORIGIN_INTERVAL_MS: z.coerce.number().int().min(30_000).default(120_000),
  DM_RECOVERY_EXPERIMENT_VERSION: z.string().min(1).default("read-recovery-v1"),
  DM_RECOVERY_EXPERIMENT_START_AT: z.preprocess((val) => (val === "" ? undefined : val), z.string().datetime().optional()),
  DM_RECOVERY_EXPERIMENT_END_AT: z.preprocess((val) => (val === "" ? undefined : val), z.string().datetime().optional()),
  DM_RECOVERY_POST_EXPERIMENT_ENABLED: booleanFlag(false),
  // Comma-separated Graph `code:subcode` pairs. Parsing silently discards
  // anything malformed, so a typo would leave the operator believing the public
  // fallback is armed when it is not. Reject it at startup instead.
  DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: z
    .string()
    .default("")
    .refine(
      (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .every((part) => /^\d+:\d+$/.test(part)),
      {
        // Deliberately a placeholder shape rather than a real pair. The obvious
        // real example — 100:2534025 — is the one pair docs/meta-verification.md
        // says never to allowlist, and an error message is a copy-paste target.
        message: 'must be comma-separated code:subcode pairs, e.g. "123:456"',
      },
    )
    // `100:2534025` means "the comment is invalid for a private reply" — a
    // per-comment failure, NOT a recipient settings rejection. It is also 1,347
    // of the 1,356 dm_failed events in production history, so allowlisting it
    // would publicly tell over a thousand people that their message-request
    // settings blocked a DM the settings had nothing to do with.
    //
    // Both the design (§9) and docs/meta-verification.md already forbid it, but
    // a prose prohibition is not a guard: it is the obvious pair to reach for,
    // and Feature 1 is dormant, so whoever arms it will be reading those docs
    // cold months from now. Refuse it here instead.
    .refine(
      (value) =>
        !value
          .split(",")
          .map((part) => part.trim())
          .includes(FORBIDDEN_SETTINGS_SIGNATURE),
      {
        message:
          `${FORBIDDEN_SETTINGS_SIGNATURE} is not a settings rejection — it is the invalid-comment ` +
          "family, and the most common failure in this account's history. See the signature " +
          "verification process in docs/meta-verification.md before allowlisting any pair.",
      },
    ),
  DM_RECOVERY_HEALTH_SAMPLE_SIZE: z.coerce.number().int().min(10).max(500).default(50),
  DM_RECOVERY_FAILURE_RATE_PERCENT: z.coerce.number().int().min(1).max(100).default(50),
  DM_RECOVERY_BACKLOG_ALERT_THRESHOLD: z.coerce.number().int().min(1).default(500),
  DM_RECOVERY_DB_FAILURE_THRESHOLD: z.coerce.number().int().min(2).max(20).default(3),
  DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE: z.coerce.number().int().min(5).max(500).default(20),
}).superRefine((value, ctx) => {
  if (value.AI_FOLLOW_UPS_ENABLED && !value.AI_DRAFTS_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_FOLLOW_UPS_ENABLED"],
      message: "AI_FOLLOW_UPS_ENABLED requires AI_DRAFTS_ENABLED",
    });
  }

  const hasStart = Boolean(value.DM_RECOVERY_EXPERIMENT_START_AT);
  const hasEnd = Boolean(value.DM_RECOVERY_EXPERIMENT_END_AT);

  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasStart ? "DM_RECOVERY_EXPERIMENT_END_AT" : "DM_RECOVERY_EXPERIMENT_START_AT"],
      message: "DM_RECOVERY_EXPERIMENT_START_AT and DM_RECOVERY_EXPERIMENT_END_AT must both be set or both unset",
    });
  } else if (hasStart && hasEnd) {
    const startTime = new Date(value.DM_RECOVERY_EXPERIMENT_START_AT!).getTime();
    const endTime = new Date(value.DM_RECOVERY_EXPERIMENT_END_AT!).getTime();
    if (endTime <= startTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DM_RECOVERY_EXPERIMENT_END_AT"],
        message: "DM_RECOVERY_EXPERIMENT_END_AT must be strictly after DM_RECOVERY_EXPERIMENT_START_AT",
      });
    }
  }

  if (value.DM_RECOVERY_ENABLED && (!hasStart || !hasEnd)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DM_RECOVERY_ENABLED"],
      message: "DM_RECOVERY_ENABLED requires experiment start and end dates to be configured",
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
