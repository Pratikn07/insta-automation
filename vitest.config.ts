import { defineConfig } from "vitest/config";

// Backend tests only — web/ has its own vitest with the "@" alias config.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
