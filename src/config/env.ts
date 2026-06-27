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
  // Run the standard-DM experiment on aged/exhausted users (measures whether a
  // cold standard DM is ever accepted). Off by default.
  GATE_DM_EXPERIMENT: z.coerce.boolean().default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
