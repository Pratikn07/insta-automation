import { describe, expect, it } from "vitest";
import { migrationDatabaseUrl } from "./migrationDatabaseUrl.js";

describe("migration database URL", () => {
  it("uses a direct connection for migrations when one is configured", () => {
    expect(
      migrationDatabaseUrl({
        DATABASE_URL: "postgresql://runtime-pool",
        DIRECT_URL: "postgresql://direct-database",
      }),
    ).toBe("postgresql://direct-database");
  });

  it("keeps existing local and test workflows when no direct URL is configured", () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgresql://local-database" })).toBe(
      "postgresql://local-database",
    );
  });

  it("fails clearly when neither connection is configured", () => {
    expect(() => migrationDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});
