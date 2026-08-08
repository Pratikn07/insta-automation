import { execFileSync } from "node:child_process";
import path from "node:path";

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

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}
