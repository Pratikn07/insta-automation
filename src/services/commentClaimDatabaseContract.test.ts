import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimComment } from "./commentClaimService.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

describeWithLocalDatabase("comment claim database contract", () => {
  it("enables row level security with no permissive policies", async () => {
    const [rls] = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'processed_comment'
    `;
    expect(rls?.relrowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<Array<{ policyname: string }>>`
      SELECT policyname FROM pg_policies WHERE tablename = 'processed_comment'
    `;
    expect(policies).toEqual([]);
  });

  it("stores created_at with time zone", async () => {
    const [column] = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'processed_comment'
        AND column_name = 'created_at'
    `;
    expect(column?.data_type).toBe("timestamp with time zone");
  });

  // The property the whole change rests on. A check-then-act guard would let
  // both of these through; the primary key does not.
  it("lets exactly one of two concurrent deliveries claim a comment", async () => {
    const commentId = `claim-race-${randomUUID()}`;
    try {
      const results = await Promise.all([
        claimComment(commentId, "ig-1"),
        claimComment(commentId, "ig-1"),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await prisma.processedComment.count({ where: { commentId } });
      expect(stored).toBe(1);
    } finally {
      await prisma.processedComment.deleteMany({ where: { commentId } });
    }
  });

  it("declines a comment already claimed by an earlier delivery", async () => {
    const commentId = `claim-replay-${randomUUID()}`;
    try {
      await expect(claimComment(commentId, "ig-1")).resolves.toBe(true);
      await expect(claimComment(commentId, "ig-1")).resolves.toBe(false);
    } finally {
      await prisma.processedComment.deleteMany({ where: { commentId } });
    }
  });
});
