import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The square rendition's storage constraints, asserted against a real PostgreSQL.
 *
 * These cannot be unit-tested: the guarantees live in CHECK constraints, so the only thing
 * that can confirm them is a database rejecting an INSERT. And two of them are guarantees
 * about being REJECTED, which a mock cannot express at all.
 *
 * The pairing is the subtle part. `guide_cover_orphan_storage_path_check` derives the
 * filename with a CASE that has no ELSE, so an unrecognised rendition yields NULL — and a
 * NULL CHECK expression PASSES in PostgreSQL. On its own that constraint is therefore weaker
 * than the one it replaced, not stricter. It is sound only because
 * `guide_cover_orphan_rendition_check` enumerates exactly the three values the CASE covers.
 * The `bogus_card` case below is what proves the pair still closes; delete the rendition
 * CHECK and that case starts passing while everything else stays green.
 */

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

// Fixed ids so the run is idempotent, and distinctive so afterAll can only ever delete rows
// this test created. Not random: a failed run would otherwise leave undeletable litter.
const RESOURCE_ID = "5c0f0a1e-0000-4000-8000-000000000001";
const VERSION_ID = "5c0f0a1e-0000-4000-8000-000000000003";
// Borrowed at runtime, never created. Inserting a category here polluted the registry that
// guideCoverMigrationContract asserts is EXACTLY the four approved ones — and because vitest
// runs files in parallel, that showed up as a failure in the other file, on a row this one
// created. Reusing a seeded category means this test cannot be the reason another fails.
let categoryId: string;
const CONTENT_HASH = "7386b2c11a10cfe7d57483c8775a1a9fb11bbf70b17a6aea3f39ebba2ddadca6";

let prisma: PrismaClient;

function orphanPath(filename: string): string {
  return `guide-cover/${RESOURCE_ID}/${VERSION_ID}/${CONTENT_HASH}/${filename}.png`;
}

/**
 * Attempts one orphan INSERT and reports WHICH constraint rejected it, not merely that
 * something did.
 *
 * Returning a bare "rejected" made this file lie. `storage_path` carries a UNIQUE index, so
 * a second row at an already-used path is refused by that index — and an earlier version of
 * the unrecognised-rendition case reused `square.png`, so it was rejected by the unique index
 * while claiming to prove the rendition CHECK. Dropping the rendition CHECK entirely left all
 * seven tests green. Naming the constraint is what makes a pass mean the thing it says.
 */
async function insertOrphan(
  rendition: string,
  filename: string,
): Promise<"accepted" | string> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO guide_cover_orphan
         (id, resource_id, cover_version_id, content_hash, rendition, storage_path)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5)`,
      RESOURCE_ID,
      VERSION_ID,
      CONTENT_HASH,
      rendition,
      orphanPath(filename),
    );
    return "accepted";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      /guide_cover_orphan_[a-z_]+/.exec(message)?.[0] ?? `unrecognised rejection: ${message}`
    );
  }
}

async function setSquarePath(path: string | null): Promise<"accepted" | "rejected"> {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE resource_cover_version
          SET render_status = 'ready', content_hash = $1,
              dm_storage_path = $2, square_storage_path = $3
        WHERE id = $4::uuid`,
      CONTENT_HASH,
      orphanPath("dm"),
      path,
      VERSION_ID,
    );
    return "accepted";
  } catch {
    return "rejected";
  }
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(LOOPBACK_HOSTS).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  // The orphan table has foreign keys to both resources and resource_cover_version, so the
  // rows have to exist before a constraint can be the thing that rejects anything. An early
  // version of this probe "proved" all six cases by tripping a foreign key instead.
  await prisma.$executeRawUnsafe(
    `INSERT INTO resources (id, name) VALUES ($1::uuid, 'square rendition contract')
     ON CONFLICT (id) DO NOTHING`,
    RESOURCE_ID,
  );
  const [seeded] = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM presentation_category WHERE slug = 'bedtime' LIMIT 1
  `;
  if (!seeded) throw new Error("expected the migration to seed the bedtime category");
  categoryId = seeded.id;

  await prisma.$executeRawUnsafe(
    `INSERT INTO resource_cover_version
       (id, resource_id, category_id, revision, template_key, palette_key, illustration_key,
        kicker, collection_label, headline, supporting_line, closing_line, alternative_description)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'warm_editorial_corner_v1', 'dusk_bloom_v1',
             'bedtime_window_house_v1', 'K', 'L', 'H', 'S', 'C', 'A')
     ON CONFLICT (id) DO NOTHING`,
    VERSION_ID,
    RESOURCE_ID,
    categoryId,
  );
});

afterAll(async () => {
  if (!databaseUrl || !prisma) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM guide_cover_orphan WHERE resource_id = $1::uuid`,
    RESOURCE_ID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM resource_cover_version WHERE id = $1::uuid`,
    VERSION_ID,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM resources WHERE id = $1::uuid`, RESOURCE_ID);
  await prisma.$disconnect();
});

describeWithDatabase("square cover rendition storage constraints", () => {
  it("accepts a square_card orphan at square.png", async () => {
    await expect(insertOrphan("square_card", "square")).resolves.toBe("accepted");
  });

  it("keeps accepting dm_cover and the retired generic_card", async () => {
    // generic_card is retired but historical rows may reference it, so widening the list
    // must not have narrowed it.
    await expect(insertOrphan("dm_cover", "dm")).resolves.toBe("accepted");
    await expect(insertOrphan("generic_card", "generic")).resolves.toBe("accepted");
  });

  it.each([
    ["generic-mismatch", "the filename the old CASE's ELSE would have chosen"],
    ["dm-mismatch", "another rendition's filename"],
  ])("rejects a square_card orphan at %s.png — %s", async (filename) => {
    await expect(insertOrphan("square_card", filename)).resolves.toBe(
      "guide_cover_orphan_storage_path_check",
    );
  });

  it("rejects an unrecognised rendition, which is what makes the CASE safe", async () => {
    // Load-bearing, and the reason it names the constraint. The path CASE has no ELSE, so an
    // unknown rendition resolves to NULL and a NULL CHECK expression passes — the rendition
    // CHECK is the only thing that stops this row. The filename is unique to this case so a
    // UNIQUE-index collision cannot pose as a CHECK rejection, which is exactly how the first
    // version of this test passed with the rendition CHECK dropped.
    await expect(insertOrphan("bogus_card", "unique-to-this-case")).resolves.toBe(
      "guide_cover_orphan_rendition_check",
    );
  });

  it("allows a published cover to carry no square at all", async () => {
    // Every cover published before this migration is in exactly this state.
    await expect(setSquarePath(null)).resolves.toBe("accepted");
  });

  it("pins a published square path to this cover's own square.png", async () => {
    await expect(setSquarePath(orphanPath("square"))).resolves.toBe("accepted");
    await expect(setSquarePath(orphanPath("generic"))).resolves.toBe("rejected");
    await expect(
      setSquarePath(`guide-cover/${RESOURCE_ID}/${VERSION_ID}/deadbeef/square.png`),
    ).resolves.toBe("rejected");
  });
});
