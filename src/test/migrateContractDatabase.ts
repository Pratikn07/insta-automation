import { execFileSync } from "node:child_process";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOCAL_DATABASE_ERROR =
  "MIGRATION_TEST_DATABASE_URL must point to a loopback PostgreSQL host";

/**
 * Refuse every migration target except an explicitly acknowledged local disposable DB.
 *
 * This guard lives in global setup itself because suite-level `beforeAll` hooks execute
 * after global setup. Keeping the check in contract files alone would allow Prisma to
 * migrate a mistaken remote target before the tests got a chance to reject it.
 */
export function assertLocalContractDatabase(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(LOCAL_DATABASE_ERROR);
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    throw new Error(LOCAL_DATABASE_ERROR);
  }

  if (process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match MIGRATION_TEST_DATABASE_URL");
  }
  if (process.env.MIGRATION_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("MIGRATION_TEST_DATABASE_DISPOSABLE=true is required");
  }
}

/**
 * Apply migrations to the contract database exactly ONCE per test run.
 *
 * Vitest `globalSetup`: runs in the main process, before any test file, so the schema is
 * settled before a single worker starts.
 *
 * Ten contract suites each ran `prisma migrate deploy` in their own `beforeAll`, against
 * one shared database, from parallel worker processes. Nine of the ten were no-ops, so
 * mostly this was only wasteful — but it also raced. `migrate deploy` takes an advisory
 * lock and rewrites `_prisma_migrations`, and while it holds that lock a concurrent
 * suite's catalog query can observe a table mid-transition. The symptom was an RLS or
 * timestamp assertion failing on a DIFFERENT suite each run, which reads like flakiness
 * and is actually contention.
 *
 * A per-worker module cache would not have fixed it: each test file gets its own worker,
 * so there was nothing to cache. Migrating once, before the workers exist, is what
 * removes the race rather than narrowing it.
 *
 * No-op when MIGRATION_TEST_DATABASE_URL is unset — the contract suites skip themselves
 * in that case, so there is nothing to migrate.
 */
export default function setup(): void {
  const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
  if (!databaseUrl) return;

  assertLocalContractDatabase(databaseUrl);

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}
