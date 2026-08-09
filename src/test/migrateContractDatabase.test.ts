import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({ execFileSync }));

const { assertLocalContractDatabase, default: setup } = await import(
  "./migrateContractDatabase.js"
);

const originalMigrationUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDisposableMarker = process.env.MIGRATION_TEST_DATABASE_DISPOSABLE;

function setTarget(databaseUrl: string, disposable = true): void {
  process.env.MIGRATION_TEST_DATABASE_URL = databaseUrl;
  process.env.DATABASE_URL = databaseUrl;
  if (disposable) process.env.MIGRATION_TEST_DATABASE_DISPOSABLE = "true";
  else delete process.env.MIGRATION_TEST_DATABASE_DISPOSABLE;
}

afterEach(() => {
  execFileSync.mockReset();
  if (originalMigrationUrl === undefined) {
    delete process.env.MIGRATION_TEST_DATABASE_URL;
  } else {
    process.env.MIGRATION_TEST_DATABASE_URL = originalMigrationUrl;
  }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDisposableMarker === undefined) {
    delete process.env.MIGRATION_TEST_DATABASE_DISPOSABLE;
  } else {
    process.env.MIGRATION_TEST_DATABASE_DISPOSABLE = originalDisposableMarker;
  }
});

describe("contract database migration guard", () => {
  it.each([
    "postgresql://postgres:postgres@127.0.0.1:5432/contracts",
    "postgres://postgres:postgres@localhost:5432/contracts",
    "postgresql://postgres:postgres@[::1]:5432/contracts",
  ])("accepts a disposable loopback database: %s", (databaseUrl) => {
    setTarget(databaseUrl);
    expect(() => assertLocalContractDatabase(databaseUrl)).not.toThrow();
  });

  it.each([
    "postgresql://postgres:postgres@db.example.com:5432/production",
    "postgresql://postgres:postgres@10.0.0.8:5432/production",
    "not-a-database-url",
  ])("rejects a non-local or malformed database before migration: %s", (databaseUrl) => {
    setTarget(databaseUrl);
    expect(() => assertLocalContractDatabase(databaseUrl)).toThrow(
      "MIGRATION_TEST_DATABASE_URL must point to a loopback PostgreSQL host",
    );
  });

  it("does not invoke Prisma when the configured migration database is remote", () => {
    setTarget("postgresql://postgres:postgres@db.example.com:5432/production");

    expect(() => setup()).toThrow(
      "MIGRATION_TEST_DATABASE_URL must point to a loopback PostgreSQL host",
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("requires the runtime database to match the guarded migration target", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/contracts";
    setTarget(databaseUrl);
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/other";

    expect(() => assertLocalContractDatabase(databaseUrl)).toThrow(
      "DATABASE_URL must exactly match MIGRATION_TEST_DATABASE_URL",
    );
  });

  it("requires an explicit disposable-database acknowledgement", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/contracts";
    setTarget(databaseUrl, false);

    expect(() => assertLocalContractDatabase(databaseUrl)).toThrow(
      "MIGRATION_TEST_DATABASE_DISPOSABLE=true is required",
    );
  });

  it("runs Prisma only after all target guards pass", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/contracts";
    setTarget(databaseUrl);

    expect(() => setup()).not.toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
