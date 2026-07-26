import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
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
  GATE_DM_EXPERIMENT: z.coerce.boolean().default(false),

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
