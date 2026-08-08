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
  await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
  await prisma.keyword.deleteMany({ where: { id: fx.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

// QA-04. The prospective path read only its own table, so it could not see that a
// historical campaign had already posted publicly on the same person. Measured at the
// time: 23 people had a waiting prospective reminder AND sat in the historical eligible
// pool, so both systems could post days apart, each seeing no contact in the table it
// knew about. Protection was one-way — historical checked prospective, never the
// reverse.
describeWithLocalDatabase("cross-system person cooldown", () => {
  /**
   * Drive the REAL prospective authorization, not a re-implementation of its query.
   * `authorizeClaimForSend` is the single point that decides whether a public comment
   * is posted, so a test that rebuilt the WHERE clause would pass even if the worker
   * never consulted it.
   */
  async function authorizeProspectiveFor(igUserId: string): Promise<string> {
    const now = new Date();
    const convo = await prisma.conversation.create({
      data: { igUserId, keywordId: fx.keywordId, state: "expired" },
    });
    const reminder = await prisma.dmRecoveryReminder.create({
      data: {
        conversationId: convo.id,
        igUserId,
        keywordId: fx.keywordId,
        keywordSnapshot: "RACE",
        templateVersion: "v1",
        publicReplyText: "test",
        commentId: `pro-c-${randomUUID()}`,
        triggerKind: "no_confirmed_read",
        instagramGateMessageId: `mid-${randomUUID()}`,
        status: "sending",
        cohort: "treatment",
        eligibleAt: new Date(now.getTime() - 60_000),
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + 60_000),
        attempts: 1,
        lastAttemptAt: now,
      },
    });

    const repoPro = await import("./dmRecoveryRepository.js");
    const decision = await repoPro.authorizeClaimForSend(reminder.id, new Date());
    return decision.kind === "suppress" ? `suppress:${decision.reason}` : decision.kind;
  }

  it("suppresses a prospective reminder when historical already posted", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    await repo.markCandidateSent(id, held!.claimToken, {
      publicReplyId: `179${randomUUID().slice(0, 8)}`,
      sentAt: now,
    });
    const row = await prisma.recoveryCandidate.findUnique({ where: { id } });

    // Before this fix the prospective path never read recovery_candidate, so this
    // returned a send decision and posted a second public comment.
    expect(await authorizeProspectiveFor(row!.igUserId)).toBe("suppress:person_cooldown");
  });

  // An in-flight claim may post within seconds, so it blocks too.
  it("suppresses while a historical claim is in flight", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    expect(held).not.toBeNull();
    const row = await prisma.recoveryCandidate.findUnique({ where: { id } });

    expect(await authorizeProspectiveFor(row!.igUserId)).toBe("suppress:person_cooldown");
  });

  // Someone with no historical contact must still be reachable, or this fix would
  // silently disable the prospective feature entirely.
  it("still authorizes someone historical never contacted", async () => {
    const untouched = `${fx.igUserId}-clean-${randomUUID()}`;
    await prisma.igUser.create({ data: { id: untouched } });

    expect(await authorizeProspectiveFor(untouched)).not.toBe("suppress:person_cooldown");
  });
});

// QA-06. `suppressRecoveriesForCompletionSafely` swallows database errors on purpose so
// a completion webhook is never lost to a suppression failure. That makes the
// denormalised `conversation.completedAt` stamp a speed optimisation, not a safety
// authority — if the stamp fails, the row's own conversation stays open and the final
// gate before a public post sees no completion.
//
// These tests never call the suppression helper, which reproduces exactly the state a
// swallowed failure leaves behind: the guide was delivered on a sibling journey, and the
// recovery row's own conversation is still open.
//
// Measured before the fix: 0 live and 0 historical instances, so this closes a latent
// hole rather than repairing damage.
describeWithLocalDatabase("final send check sees journey completion", () => {
  /**
   * A prospective reminder whose OWN conversation is open, plus a sibling conversation
   * for the same person and keyword.
   *
   * `linkIntent` decides which authority proves delivery: with it, both conversations
   * point at a completed intent (the post-Feature-3 shape); without it, only the
   * sibling's own `completedAt` exists (anything predating Feature 3).
   */
  async function authorizeWithSibling(opts: {
    siblingCompleted: boolean;
    linkIntent: boolean;
  }): Promise<string> {
    const now = new Date();
    const igUserId = `${fx.igUserId}-qa06-${randomUUID()}`;
    const intentId = randomUUID();
    await prisma.igUser.create({ data: { id: igUserId } });
    await prisma.journeyIntent.create({
      data: {
        id: intentId, igUserId, keywordId: fx.keywordId,
        windowStartedAt: now, lastTriggerAt: now,
        windowExpiresAt: new Date(now.getTime() + 1e8),
        // Only stamped when the intent is the authority under test.
        completedAt: opts.linkIntent && opts.siblingCompleted ? now : null,
      },
    });

    // The guide actually arrived here.
    await prisma.conversation.create({
      data: {
        igUserId, keywordId: fx.keywordId,
        state: opts.siblingCompleted ? "completed" : "awaiting_done",
        completedAt: opts.siblingCompleted ? now : null,
        canonicalIntentId: opts.linkIntent ? intentId : null,
      },
    });

    // The recovery row's own conversation: still open, which is the whole point.
    const source = await prisma.conversation.create({
      data: {
        igUserId, keywordId: fx.keywordId, state: "expired",
        canonicalIntentId: opts.linkIntent ? intentId : null,
      },
    });

    const reminder = await prisma.dmRecoveryReminder.create({
      data: {
        conversationId: source.id, igUserId, keywordId: fx.keywordId,
        keywordSnapshot: "RACE", templateVersion: "v1", publicReplyText: "test",
        commentId: `qa06-c-${randomUUID()}`, triggerKind: "no_confirmed_read",
        instagramGateMessageId: `mid-${randomUUID()}`, status: "sending",
        cohort: "treatment", eligibleAt: new Date(now.getTime() - 60_000),
        claimedAt: now, claimExpiresAt: new Date(now.getTime() + 60_000),
        attempts: 1, lastAttemptAt: now,
      },
    });

    const repoPro = await import("./dmRecoveryRepository.js");
    const decision = await repoPro.authorizeClaimForSend(reminder.id, new Date());
    return decision.kind === "suppress" ? `suppress:${decision.reason}` : decision.kind;
  }

  it("suppresses when the canonical intent is already complete", async () => {
    expect(await authorizeWithSibling({ siblingCompleted: true, linkIntent: true })).toBe(
      "suppress:completed",
    );
  });

  // No intent at all: the sibling's own completion must still be found, or every
  // pre-Feature-3 journey stays exposed.
  it("suppresses on a sibling completion with no intent link", async () => {
    expect(await authorizeWithSibling({ siblingCompleted: false, linkIntent: false })).not.toBe(
      "suppress:completed",
    );
    expect(await authorizeWithSibling({ siblingCompleted: true, linkIntent: false })).toBe(
      "suppress:completed",
    );
  });

  // The control. An open sibling must NOT suppress, or this fix would disable
  // prospective recovery for anyone who ever asked twice.
  it("still authorizes when nothing in the journey completed", async () => {
    expect(await authorizeWithSibling({ siblingCompleted: false, linkIntent: true })).not.toBe(
      "suppress:completed",
    );
  });
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
