import { defineConfig } from "vitest/config";

/**
 * The runtime's own test config.
 *
 * Without this, `npm --prefix codex-runtime test` walked up and loaded the repo
 * root's config, whose `globalSetup` points at the API's contract-database
 * migration script. That path does not exist here, so every run died before a
 * single test loaded — the runtime's suite was only reachable through the root
 * runner, which is not what the release gate invokes.
 *
 * The runtime touches no database: it holds ChatGPT OAuth state on a volume and
 * speaks to app-server over stdio. So there is no global setup and no reason to
 * serialise files.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
