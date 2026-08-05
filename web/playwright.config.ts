import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys for the two AI surfaces that put text in front of a person.
 *
 * The dev server is used rather than a production build because the harness entry
 * (e2e/index.html) is deliberately outside the production entry graph.
 *
 * VITE_SUPABASE_* must be set for the bundle to contain application code at all:
 * src/lib/supabase.ts throws on import when they are missing, and everything
 * downstream is then tree-shaken away. The values are dummies — e2e/main.tsx stubs
 * every network call, including the auth session lookup.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      // The DM drawer must fit a phone without horizontal scrolling.
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5174 --strictPort",
    url: "http://localhost:5174/e2e/index.html?scenario=advisor",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: "https://e2e.supabase.co",
      VITE_SUPABASE_ANON_KEY: "e2e-anon-key",
      VITE_API_URL: "http://localhost:5174/api",
    },
  },
});
