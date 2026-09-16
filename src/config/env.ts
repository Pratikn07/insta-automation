import "dotenv/config";
import { z } from "zod";
import { DM_RECOVERY_TIMING_EXPERIMENT_VERSION } from "../services/dmRecoveryTimingExperiment.js";
import { booleanFlag } from "./booleanFlag.js";
import { RECOVERY_TIMING_V2_CUTOVER_AT } from "./recoveryTimingSchedule.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_TIMING_EXPERIMENT_DAYS = 28;
const MAX_TIMING_EXPERIMENT_DAYS = 42;

/**
 * The one Graph signature that must never enter the settings-blocked allowlist.
 * Exported so the classifier's tests can name it rather than repeat the literal.
 */
export const FORBIDDEN_SETTINGS_SIGNATURE = "100:2534025";

/** Stable controlled-recipient input for the later mutually-exclusive owner selector. */
export function guideDeliveryCohortIgUserIds(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * Parses a comma-separated allowlist of exact identifiers. Feature-neutral on purpose:
 * several rollout fences keep their cohort as an unlogged source string in configuration
 * and turn it into a set only at the point of the decision.
 */
export function parseIdentifierSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /**
   * Background workers. Defaults TRUE so production is unchanged by its absence;
   * the only reason to set it false is a local server run for UI work.
   *
   * Seven of the workers start unconditionally, and the listen callback fires a
   * token refresh and a feed-follow snapshot immediately on boot. Since there is
   * one database and one Instagram account, a second local server means a second
   * gate-queue worker sending real private replies, a second token refresher
   * racing the deployed one, and duplicate Graph and Gemini spend — all against
   * production, alongside Railway doing the same work.
   *
   * booleanFlag, never z.coerce.boolean: coerce treats the STRING "false" as
   * true, so WORKERS_ENABLED=false would silently start every worker — the exact
   * failure this flag exists to prevent.
   */
  WORKERS_ENABLED: booleanFlag(true),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  // Optional on purpose. The live token lives in the `ig_token` table and rotates itself
  // every 6h, so this is only a SEED: it creates the row on a brand-new deploy, and it is
  // the manual rescue path when the stored token has actually died (paste a fresh one into
  // Railway). A local checkout needs neither, and keeping a copy here only invites a stale
  // credential — which is exactly what happened on 2026-08-25, when a seed dead since
  // 6 August was the value every one-off script authenticated with. See tokenStore.ts.
  IG_ACCESS_TOKEN: z.string().min(1).optional(),
  IG_USER_ID: z.string().min(1),

  DATABASE_URL: z.string().url(),
  /** Direct PostgreSQL session for schema migrations; runtime may use a transaction pool. */
  DIRECT_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_BUCKET: z.string().min(1).default("insta-resources"),
  GUIDE_COVER_MEDIA_BASE_URL: z.string().url().optional(),
  GUIDE_COVER_MEDIA_WRITE_TOKEN: z.string().min(32).optional(),

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

  // Instagram owns publication scheduling. When enabled, the one-minute worker
  // discovers newly published posts and binds locally prepared automations.
  UPCOMING_AUTOMATIONS_ENABLED: booleanFlag(false),

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
  // Creator-only cover drafting and publication. It never changes an existing
  // published cover when off; it only closes the authoring mutation surface.
  GUIDE_COVER_AUTHORING_ENABLED: booleanFlag(false),
  // Safety guard for free-text Instagram DMs. It evaluates every eligible DM,
  // but changes routing only when globally enabled or the sender is allowlisted.
  GUIDE_DM_INTENT_GUARD_ENABLED: booleanFlag(false),
  GUIDE_DM_INTENT_GUARD_IG_USER_IDS: z.string().default(""),
  // Parent-facing guide access is separately fenced from creator authoring.
  // Both switches default off. The strict flow additionally requires an exact
  // controlled account or resource match, so an empty pilot list reaches nobody.
  GUIDE_FOLLOW_GATE_V2_ENABLED: booleanFlag(false),
  /**
   * Applies the strict flow to EVERY guide, including guides created later.
   *
   * Defaults off, and requires `GUIDE_FOLLOW_GATE_V2_ENABLED` as well — two switches, so this
   * one cannot broaden a flow that is itself turned off. `booleanFlag` rather than
   * `z.coerce.boolean`, which parses the string "false" as true.
   */
  GUIDE_FOLLOW_GATE_V2_ALL: booleanFlag(false),
  GUIDE_RICH_GATE_ENABLED: booleanFlag(false),
  // The V1 comment gate, sent as a card instead of plain text. Ships off with a 0% share so
  // the first parent only sees it after someone deliberately sets both.
  GUIDE_GATE_CARD_ENABLED: booleanFlag(false),
  GUIDE_GATE_CARD_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  GUIDE_FOLLOW_GATE_V2_COHORT_IG_USER_IDS: z.string().default(""),
  GUIDE_FOLLOW_GATE_V2_RESOURCE_IDS: z.string().default(""),
  GUIDE_COVER_DELIVERY_ENABLED: booleanFlag(false),
  GUIDE_COVER_DELIVERY_RESOURCE_IDS: z.string().default(""),
  GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  GUIDE_COVER_ORPHAN_BATCH: z.coerce.number().int().min(1).max(50).default(10),
  GUIDE_COVER_ORPHAN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(15 * 60_000),
  AI_BRAND_VOICE: z
    .string()
    .max(4000)
    .default("Warm, practical, concise, and supportive. Never diagnose or shame a parent."),
  AI_DRAFT_INTERVAL_MS: z.coerce.number().int().min(5_000).default(15_000),

  // --- Durable guide-delivery recovery ---------------------------------------
  // Off until a deliberately selected cohort is configured. This controls only
  // the ledger worker; Task 9 owns mutually exclusive assignment of new work.
  GUIDE_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  GUIDE_DELIVERY_LEASE_MS: z.coerce.number().int().min(60_000).default(5 * 60_000),
  GUIDE_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  GUIDE_DELIVERY_RETRY_BASE_MS: z.coerce.number().int().min(10_000).default(60_000),
  GUIDE_DELIVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  GUIDE_DELIVERY_ENABLED: booleanFlag(false),
  GUIDE_DELIVERY_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  // Kept as an unlogged source string. The Task 9 selector turns it into a
  // trimmed set; config validates the enablement precondition without exposing
  // recipient identifiers in startup logs.
  GUIDE_DELIVERY_COHORT_IG_USER_IDS: z.string().default(""),

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
  // Legacy read-recovery-v1 inputs. V2 uses code-frozen 2h/6h schedules and a
  // 45/45/10 allocation, so neither value is consulted for a randomized v2 row.
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
  if (Boolean(value.GUIDE_COVER_MEDIA_BASE_URL) !== Boolean(value.GUIDE_COVER_MEDIA_WRITE_TOKEN)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.GUIDE_COVER_MEDIA_BASE_URL ? "GUIDE_COVER_MEDIA_WRITE_TOKEN" : "GUIDE_COVER_MEDIA_BASE_URL"],
      message: "GUIDE_COVER_MEDIA_BASE_URL and GUIDE_COVER_MEDIA_WRITE_TOKEN must both be set or both unset",
    });
  }
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
    } else if (
      value.DM_RECOVERY_EXPERIMENT_VERSION ===
      DM_RECOVERY_TIMING_EXPERIMENT_VERSION
    ) {
      if (startTime !== new Date(RECOVERY_TIMING_V2_CUTOVER_AT).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DM_RECOVERY_EXPERIMENT_START_AT"],
          message:
            `${DM_RECOVERY_TIMING_EXPERIMENT_VERSION} must start at the approved cutover ` +
            RECOVERY_TIMING_V2_CUTOVER_AT,
        });
      }
      const durationDays = (endTime - startTime) / DAY_MS;
      if (
        durationDays < MIN_TIMING_EXPERIMENT_DAYS ||
        durationDays > MAX_TIMING_EXPERIMENT_DAYS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DM_RECOVERY_EXPERIMENT_END_AT"],
          message:
            `${DM_RECOVERY_TIMING_EXPERIMENT_VERSION} must enroll for ` +
            `${MIN_TIMING_EXPERIMENT_DAYS} to ${MAX_TIMING_EXPERIMENT_DAYS} days`,
        });
      }
    }
  }

  if (
    value.DM_RECOVERY_EXPERIMENT_VERSION ===
      DM_RECOVERY_TIMING_EXPERIMENT_VERSION &&
    value.DM_RECOVERY_POST_EXPERIMENT_ENABLED
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DM_RECOVERY_POST_EXPERIMENT_ENABLED"],
      message:
        `${DM_RECOVERY_TIMING_EXPERIMENT_VERSION} does not assign followers ` +
        "after its enrollment window",
    });
  }

  if (value.DM_RECOVERY_ENABLED && (!hasStart || !hasEnd)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DM_RECOVERY_ENABLED"],
      message: "DM_RECOVERY_ENABLED requires experiment start and end dates to be configured",
    });
  }

  const guideCohortConfigured = guideDeliveryCohortIgUserIds(
    value.GUIDE_DELIVERY_COHORT_IG_USER_IDS,
  ).size > 0;
  if (
    value.GUIDE_DELIVERY_ENABLED &&
    !guideCohortConfigured &&
    value.GUIDE_DELIVERY_ROLLOUT_PERCENT === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GUIDE_DELIVERY_ENABLED"],
      message: "GUIDE_DELIVERY_ENABLED requires a cohort or rollout percentage",
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
