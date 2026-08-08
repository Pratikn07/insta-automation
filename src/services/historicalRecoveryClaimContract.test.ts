import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// QA-02 demanded a real-Postgres race: "two clients must return exactly one claim".
// A mocked client cannot show this — the defect was a WHERE clause that matched the
// same row twice, which only a real database can demonstrate.
//
// Reproduced before the fix: two concurrent claimCandidate calls on one row both
// returned the candidate, so both workers would have posted the same public comment.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let repo: typeof import("./historicalRecoveryRepository.js");

type Fixture = { resourceId: string; keywordId: string; igUserId: string; intentId: string; campaignId: string };
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `claim-race-${randomUUID()}`,
    intentId: randomUUID(),
    campaignId: randomUUID(),
  };
  const now = new Date();
  await prisma.resource.create({ data: { id: f.resourceId, name: "claim race" } });
  await prisma.keyword.create({
    data: { id: f.keywordId, keyword: `claim-race-${f.keywordId}`, resourceId: f.resourceId, publicReply: "x", gateMessage: "y" },
  });
  await prisma.igUser.create({ data: { id: f.igUserId } });
  await prisma.journeyIntent.create({
    data: { id: f.intentId, igUserId: f.igUserId, keywordId: f.keywordId, windowStartedAt: now, lastTriggerAt: now, windowExpiresAt: new Date(now.getTime() + 1e8) },
  });
  await prisma.recoveryCampaign.create({
    data: { id: f.campaignId, phase: "unknown_read_pilot", selectionVersion: `claim-race-${f.campaignId}`, sourceDataCutoff: now, copyVersion: "recovery-v2", state: "running", approvedBy: "test", approvedAt: now },
  });
  return f;
}

/**
 * One candidate, with its own intent and person.
 *
 * The (campaign, intent) and (campaign, person) unique indexes are the anti-duplicate
 * invariant working as designed, so each test row needs fresh identities rather than
 * reusing the fixture's.
 */
async function makeCandidate(): Promise<string> {
  const now = new Date();
  const igUserId = `${fx.igUserId}-${randomUUID()}`;
  const intentId = randomUUID();

  await prisma.igUser.create({ data: { id: igUserId } });
  await prisma.journeyIntent.create({
    data: {
      id: intentId, igUserId, keywordId: fx.keywordId,
      windowStartedAt: now, lastTriggerAt: now, windowExpiresAt: new Date(now.getTime() + 1e8),
    },
  });

  const row = await prisma.recoveryCandidate.create({
    data: {
      campaignId: fx.campaignId, campaignPhase: "unknown_read_pilot", intentId,
      igUserId, keywordId: fx.keywordId, commentId: `claim-race-c-${randomUUID()}`,
      commentAt: now, keywordSnapshot: "RACE", publicReplyText: "t",
      evidence: "gate_sent_no_read", arm: "treatment", eligibleAt: now,
    },
  });
  return row.id;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = await import("./historicalRecoveryRepository.js");
  fx = await seed();
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaign.deleteMany({ where: { id: fx.campaignId } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
  await prisma.keyword.deleteMany({ where: { id: fx.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

describeWithLocalDatabase("historical candidate claim exclusivity", () => {
  // THE test QA-02 asked for. Before the fix this returned 2.
  it("gives exactly one of two concurrent workers the claim", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);

    const [a, b] = await Promise.all([
      repo.claimCandidate(id, now, lease),
      repo.claimCandidate(id, now, lease),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("survives five simultaneous workers with one winner", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimCandidate(id, now, lease)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("issues a distinct token to each winner", async () => {
    const first = await makeCandidate();
    const second = await makeCandidate();
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);

    const a = await repo.claimCandidate(first, now, lease);
    const b = await repo.claimCandidate(second, now, lease);

    expect(a?.claimToken).toBeTruthy();
    expect(a?.claimToken).not.toBe(b?.claimToken);
  });

  // The other half of QA-02: a stale claimant must not be able to finalise or release
  // the winner's row. The old predicate was `id + outcome=pending`, which let it.
  it("refuses to let a stale token finalise the winner's row", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const winner = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    expect(winner).not.toBeNull();

    const stale = randomUUID();
    expect(await repo.markCandidateSent(id, stale, { publicReplyId: "179", sentAt: now })).toBe(false);
    expect(await repo.markCandidateSuppressed(id, stale, "nope")).toBe(false);
    expect(await repo.markCandidateFailed(id, stale, "nope")).toBe(false);
    expect(await repo.markCandidateUncertain(id, stale, "nope")).toBe(false);
    expect(await repo.releaseCandidateClaim(id, stale)).toBe(false);

    // Still the winner's, still pending, still sendable by the rightful holder.
    expect(await repo.markCandidateSent(id, winner!.claimToken, { publicReplyId: "179", sentAt: now })).toBe(true);
  });

  it("frees the row for a later tick when the holder releases it", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const first = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    expect(await repo.releaseCandidateClaim(id, first!.claimToken)).toBe(true);

    const second = await repo.claimCandidate(id, new Date(), new Date(Date.now() + 60_000));
    expect(second).not.toBeNull();
    expect(second!.claimToken).not.toBe(first!.claimToken);
  });

  // A backoff must actually keep the row out of the due list, or a rate-limited
  // candidate is retried on every tick regardless of the recorded delay.
  it("keeps a backed-off candidate out of the due list", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    await repo.releaseCandidateClaim(id, held!.claimToken, new Date(now.getTime() + 3_600_000));

    const due = await repo.listDueCandidateIds(new Date(), 50);
    expect(due).not.toContain(id);
  });

  it("counts attempts durably across claims", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const first = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    expect(first!.attempts).toBe(1);

    await repo.releaseCandidateClaim(id, first!.claimToken);
    const second = await repo.claimCandidate(id, new Date(), new Date(Date.now() + 60_000));
    expect(second!.attempts).toBe(2);
  });

  // QA-08: an uncertain attempt may be live on Instagram, so it must consume cap.
  // Excluding it let an unknown number of real public comments escape the limit.
  it("counts an uncertain attempt against the cap", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    await repo.markCandidateUncertain(id, held!.claimToken, "timeout");

    const counted = await repo.countCandidatesSentSince(fx.campaignId, new Date(now.getTime() - 60_000));
    expect(counted).toBeGreaterThan(0);
  });
});
