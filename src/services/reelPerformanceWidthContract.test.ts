import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// video_view_total_time is CUMULATIVE watch time in milliseconds over a reel's
// whole life, so it only ever grows. Stored as INT4 it crossed 2,147,483,647 on
// this account's biggest reels in about seven weeks — and because every metric
// for a reel shares one INSERT, the overflow did not lose a column, it lost the
// whole ROW. Those reels stopped being measured entirely: views, reach, likes,
// interactions, all of it, for 25-47 days, which also starved spikeService of
// the reach it reads to name the reels behind a follower spike.
//
// Two guards, because they fail in different places. The schema assertion runs
// everywhere including a machine with no database, so a regression is caught in
// ordinary CI. The database contract proves Postgres actually accepts the value,
// which is the part a type declaration alone cannot promise.

const INT4_CEILING = 2_147_483_647;

describe("reel performance column widths", () => {
  it("declares video_view_total_time as BigInt, not Int", () => {
    const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const model = schema.match(/model ReelPerformanceSnapshot \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(model).toMatch(/videoViewTotalTime\s+BigInt\?/);
    expect(model).not.toMatch(/videoViewTotalTime\s+Int\?/);
  });
});

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
const mediaId = `perf-width-${randomUUID()}`;

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.reelMeta.create({ data: { mediaId } });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await prisma.reelMeta.delete({ where: { mediaId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describeWithDatabase("reel_performance_snapshot width contract", () => {
  it("stores a watch time past the INT4 ceiling without losing the row", async () => {
    // The real value that failed on 2026-08-19, from a reel at ~140k reach.
    const observed = 13_560_020_033;
    expect(observed).toBeGreaterThan(INT4_CEILING);

    const written = await prisma.reelPerformanceSnapshot.create({
      data: { mediaId, views: 357_744, reach: 175_164, videoViewTotalTime: observed },
    });

    // The whole row has to survive — the bug's real cost was the sibling
    // metrics going missing alongside the one that overflowed.
    expect(written.videoViewTotalTime).toBe(BigInt(observed));
    expect(written.reach).toBe(175_164);
    expect(written.views).toBe(357_744);

    await prisma.reelPerformanceSnapshot.delete({ where: { id: written.id } });
  });
});
