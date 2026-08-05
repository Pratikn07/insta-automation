import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Vitest owns `src/`. The Playwright specs in `e2e/` supply their own test() and
 * expect(), so vitest must not load them — it throws "did not expect test() to be
 * called here" if it does.
 *
 * This lives in its own file rather than vite.config.ts because `tsc -b` type-checks
 * that file against Vite's own UserConfig, which has no `test` key.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);
