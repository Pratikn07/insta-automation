import { z } from "zod";

const runtimeEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CODEX_HOME: z.string().min(1).default("/tmp/tinysoho-codex-home"),
  CODEX_WORKSPACE: z.string().min(1).default("/tmp/tinysoho-codex-workspace"),
  RUNTIME_SHARED_SECRET: z.string().min(32),
  // Where the advisor's three read-only tools call back to, and the service token
  // it presents. Optional so the DM drafter (Milestone 2) runs without them — the
  // advisor endpoints answer advisor_not_configured when they are absent.
  TINY_SOHO_API_URL: z.string().url().optional(),
  TINY_SOHO_INTERNAL_TOKEN: z.string().min(32).optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeEnvSchema>;

export function parseRuntimeConfig(input: NodeJS.ProcessEnv): RuntimeConfig {
  return runtimeEnvSchema.parse(input);
}
