import { z } from "zod";

const runtimeEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CODEX_HOME: z.string().min(1).default("/tmp/tinysoho-codex-home"),
  CODEX_WORKSPACE: z.string().min(1).default("/tmp/tinysoho-codex-workspace"),
  RUNTIME_SHARED_SECRET: z.string().min(32),
});

export type RuntimeConfig = z.infer<typeof runtimeEnvSchema>;

export function parseRuntimeConfig(input: NodeJS.ProcessEnv): RuntimeConfig {
  return runtimeEnvSchema.parse(input);
}
