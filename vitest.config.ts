import { defineConfig } from "vitest/config";

// Backend tests only — web/ has its own vitest with the "@" alias config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "shared/**/*.test.ts"],
    // Contract tests share one disposable Postgres database. Most fixtures use unique
    // prefixes, but production reconcilers intentionally scan all running campaigns
    // and expired leases. Running database files in parallel therefore lets one test
    // consume another file's work and makes exact safety assertions nondeterministic.
    // Unit-only runs keep Vitest's normal file parallelism.
    fileParallelism: !process.env.MIGRATION_TEST_DATABASE_URL,
    // Migrate the contract database ONCE, before any worker starts.
    //
    // Ten contract suites each ran `prisma migrate deploy` in their own beforeAll,
    // against one shared database, from parallel workers. Nine were no-ops, but
    // `migrate deploy` holds an advisory lock and rewrites _prisma_migrations, so a
    // concurrent suite's catalog query could observe a table mid-transition. The symptom
    // was an RLS or timestamp assertion failing on a DIFFERENT suite each run.
    globalSetup: ["src/test/migrateContractDatabase.ts"],
  },
});
