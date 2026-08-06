import "dotenv/config";
import { z } from "zod";
import { booleanFlag } from "./booleanFlag.js";

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
}).superRefine((value, ctx) => {
  if (value.AI_FOLLOW_UPS_ENABLED && !value.AI_DRAFTS_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_FOLLOW_UPS_ENABLED"],
      message: "AI_FOLLOW_UPS_ENABLED requires AI_DRAFTS_ENABLED",
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
