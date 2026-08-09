import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const PR2_FIRST_MIGRATION = "20260809040000_p1_selection_attribution";
const prismaBinary = path.resolve("node_modules/.bin/prisma");
let admin: InstanceType<typeof pg.Client> | undefined;
let fixtureRoot: string | undefined;
let fixtureDatabase: string | undefined;

function databaseUrlFor(name: string): string {
  const parsed = new URL(databaseUrl!);
  parsed.pathname = `/${name}`;
  parsed.searchParams.set("schema", "public");
  return parsed.toString();
}

function deploy(schemaFile: string, database: string): void {
  execFileSync(prismaBinary, ["migrate", "deploy", "--schema", schemaFile], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrlFor(database) },
    stdio: "pipe",
  });
}

afterAll(async () => {
  if (admin && fixtureDatabase) {
    await admin.query(`DROP DATABASE IF EXISTS "${fixtureDatabase}" WITH (FORCE)`);
  }
  await admin?.end();
  if (fixtureRoot?.startsWith(path.join(tmpdir(), "insta-p1-legacy-"))) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describeWithDatabase("pre-PR2 campaign migration", () => {
  it("normalizes the 24-hour window and pauses an unreviewed running campaign", async () => {
    const parsed = new URL(databaseUrl!);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
    parsed.searchParams.delete("schema");
    admin = new pg.Client({ connectionString: parsed.toString() });
    await admin.connect();
    fixtureDatabase = `insta_p1_legacy_${randomUUID().replaceAll("-", "")}`;
    expect(fixtureDatabase).toMatch(/^insta_p1_legacy_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE "${fixtureDatabase}"`);

    fixtureRoot = mkdtempSync(path.join(tmpdir(), "insta-p1-legacy-"));
    const fixturePrisma = path.join(fixtureRoot, "prisma");
    const fixtureMigrations = path.join(fixturePrisma, "migrations");
    mkdirSync(fixtureMigrations, { recursive: true });
    cpSync("prisma/schema.prisma", path.join(fixturePrisma, "schema.prisma"));
    cpSync("prisma/migrations/migration_lock.toml", path.join(fixtureMigrations, "migration_lock.toml"));
    const migrations = readdirSync("prisma/migrations", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations.filter((name) => name < PR2_FIRST_MIGRATION)) {
      cpSync(
        path.join("prisma/migrations", migration),
        path.join(fixtureMigrations, migration),
        { recursive: true },
      );
    }
    const schemaFile = path.join(fixturePrisma, "schema.prisma");
    deploy(schemaFile, fixtureDatabase);

    const clientUrl = new URL(databaseUrlFor(fixtureDatabase));
    clientUrl.searchParams.delete("schema");
    const client = new pg.Client({ connectionString: clientUrl.toString() });
    await client.connect();
    const campaignId = randomUUID();
    try {
      await client.query(
        `INSERT INTO recovery_campaign (
           id, phase, state, selection_version, source_data_cutoff, copy_version,
           approved_by, approved_at, started_at
         ) VALUES ($1::uuid, 'unknown_read_pilot', 'running', $2,
           '2026-07-01T00:00:00Z', 'legacy-v1', 'legacy-owner',
           '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
        [campaignId, `legacy-${randomUUID()}`],
      );

      for (const migration of migrations.filter((name) => name >= PR2_FIRST_MIGRATION)) {
        cpSync(
          path.join("prisma/migrations", migration),
          path.join(fixtureMigrations, migration),
          { recursive: true },
        );
      }
      deploy(schemaFile, fixtureDatabase);

      const migrated = await client.query<{
        state: string;
        inbound_window_hours: number;
        pause_reason: string | null;
        selection_fingerprint: string | null;
      }>(
        `SELECT state::text, inbound_window_hours, pause_reason, selection_fingerprint
         FROM recovery_campaign WHERE id = $1::uuid`,
        [campaignId],
      );
      expect(migrated.rows).toEqual([{
        state: "paused",
        inbound_window_hours: 24,
        pause_reason: "migration:legacy_unverified_snapshot",
        selection_fingerprint: null,
      }]);
    } finally {
      await client.end();
    }
  });
});
