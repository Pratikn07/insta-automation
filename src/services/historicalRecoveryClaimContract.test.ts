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
let ticks: typeof import("./historicalRecoveryTickRepository.js");
let currentTickToken: string | null = null;

type Fixture = { resourceId: string; keywordId: string; igUserId: string; intentId: string; campaignId: string };
let fx: Fixture;
/** Campaigns created per-test for cap isolation; removed in afterAll. */
const campaignsToClean: string[] = [];

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
async function makeCandidate(campaignId: string = fx.campaignId): Promise<string> {
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

  const commentId = `claim-race-c-${randomUUID()}`;
  const row = await prisma.recoveryCandidate.create({
    data: {
      campaignId, campaignPhase: "unknown_read_pilot", intentId,
      igUserId, keywordId: fx.keywordId, commentId,
      commentAt: now, keywordSnapshot: "RACE", publicReplyText: "t",
      evidence: "gate_sent_no_read", arm: "treatment", eligibleAt: now,
      sources: {
        create: {
          position: 0,
          commentId,
          receivedAt: now,
          choiceReason: "newest_eligible_comment",
        },
      },
    },
  });
  return row.id;
}

async function approvedCommentId(candidateId: string): Promise<string> {
  const source = await prisma.recoveryCandidateSource.findFirstOrThrow({
    where: { candidateId },
    orderBy: { position: "asc" },
    select: { commentId: true },
  });
  return source.commentId;
}

async function openBatch(campaignId: string, now: Date): Promise<string> {
  if (currentTickToken) {
    await ticks.finishHistoricalTick(currentTickToken, now);
    currentTickToken = null;
  }
  const tick = await ticks.acquireHistoricalTick(now, new Date(now.getTime() + 60_000));
  if (!tick) throw new Error("expected tick lease");
  currentTickToken = tick.token;
  const batch = await ticks.openCampaignBatch(tick, campaignId, now);
  if (!batch) throw new Error("expected campaign batch");
  return batch.id;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = await import("./historicalRecoveryRepository.js");
  ticks = await import("./historicalRecoveryTickRepository.js");
  fx = await seed();
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.publicRecoveryDispatch.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaignBatchRun.deleteMany({
    where: { campaignId: { in: [fx.campaignId, ...campaignsToClean] } },
  });
  await prisma.recoveryCampaign.deleteMany({ where: { id: { in: [fx.campaignId, ...campaignsToClean] } } });
  await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
  await prisma.keyword.deleteMany({ where: { id: fx.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.dmRecoveryControl.updateMany({
    where: { id: 1 },
    data: { historicalTickToken: null, historicalTickExpiresAt: null },
  });
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
    const claimToken = randomUUID();
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
        claimToken,
        attempts: 1,
        lastAttemptAt: now,
      },
    });

    const repoPro = await import("./dmRecoveryRepository.js");
    const decision = await repoPro.authorizeClaimForSend(reminder.id, claimToken, new Date());
    return decision.kind === "suppress" ? `suppress:${decision.reason}` : decision.kind;
  }

  it("suppresses a prospective reminder when historical already posted", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    const reserved = await repo.reserveHistoricalDispatch({
      candidateId: id,
      claimToken: held!.claimToken,
      now,
      hourlyCap: 100,
      dailyCap: 100,
      globalHourlyCap: 200,
      globalDailyCap: 500,
      prospectiveCooldownHours: 24,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    await repo.startHistoricalDispatch({
      candidateId: id,
      commentId: await approvedCommentId(id),
      claimToken: held!.claimToken,
      batchRunId: await openBatch(fx.campaignId, now),
      ...reserved,
      now,
    });
    await repo.finalizeHistoricalDispatch({
      candidateId: id,
      claimToken: held!.claimToken,
      ...reserved,
      outcome: {
        kind: "sent",
        providerReplyId: `179${randomUUID().slice(0, 8)}`,
        at: now,
      },
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
    const reserved = await repo.reserveHistoricalDispatch({
      candidateId: id,
      claimToken: held!.claimToken,
      now,
      hourlyCap: 100,
      dailyCap: 100,
      globalHourlyCap: 200,
      globalDailyCap: 500,
      prospectiveCooldownHours: 24,
    });
    expect(reserved.kind).toBe("reserved");
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
    const claimToken = randomUUID();
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
    if (opts.linkIntent) {
      // The reminder source is the canonical owner in this scenario. Without this
      // authoritative pointer both linked conversations are aliases by definition, and
      // the correct result would be `reconciled_alias` before completion is considered.
      await prisma.journeyIntent.update({
        where: { id: intentId },
        data: { canonicalConversationId: source.id },
      });
    }

    const reminder = await prisma.dmRecoveryReminder.create({
      data: {
        conversationId: source.id, igUserId, keywordId: fx.keywordId,
        keywordSnapshot: "RACE", templateVersion: "v1", publicReplyText: "test",
        commentId: `qa06-c-${randomUUID()}`, triggerKind: "no_confirmed_read",
        instagramGateMessageId: `mid-${randomUUID()}`, status: "sending",
        cohort: "treatment", eligibleAt: new Date(now.getTime() - 60_000),
        claimedAt: now, claimExpiresAt: new Date(now.getTime() + 60_000),
        claimToken,
        attempts: 1, lastAttemptAt: now,
      },
    });

    const repoPro = await import("./dmRecoveryRepository.js");
    const decision = await repoPro.authorizeClaimForSend(reminder.id, claimToken, new Date());
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

// QA-08. The worker read the hour and day counts, then posted, with nothing holding the
// gap — so two workers could each read "2 of 3 this hour" and both post. And the caps
// were per-campaign only, so two running campaigns, or historical plus prospective, could
// each stay inside their own limit while the account posted far more public comments than
// any single number described.
//
// A mocked client cannot demonstrate either: the fix is a row lock, which only exists in
// a real database.
describeWithLocalDatabase("send capacity is reserved, not merely observed", () => {
  /** The shared lock row both systems serialise on. */
  async function ensureControlRow(): Promise<void> {
    await prisma.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1, circuitOpen: false },
      update: {},
    });
  }

  /**
   * A campaign of this test's own, plus the shared control row.
   *
   * Caps are counted per campaign over a rolling window, so reusing the fixture's
   * campaign made each test inherit every earlier test's sends — the first version of
   * these tests failed for exactly that reason, reporting `daily_cap_reached` on a
   * brand-new candidate. The GLOBAL cap is deliberately still shared, because that is
   * what it means, so global assertions set their own campaign caps wide open.
   */
  async function freshCampaign(): Promise<string> {
    await ensureControlRow();
    const id = randomUUID();
    const now = new Date();
    await prisma.recoveryCampaign.create({
      data: {
        id, phase: "unknown_read_pilot", selectionVersion: `cap-${id}`,
        sourceDataCutoff: now, copyVersion: "recovery-v2", state: "running",
        approvedBy: "test", approvedAt: now,
      },
    });
    campaignsToClean.push(id);
    return id;
  }

  async function reserveRaw(id: string, caps: { hourly: number; daily: number; global: number }) {
    const row = await prisma.recoveryCandidate.findUnique({ where: { id } });
    if (!row?.claimToken) throw new Error("candidate must be claimed before reservation");
    return repo.reserveHistoricalDispatch({
      candidateId: id,
      claimToken: row.claimToken,
      now: new Date(),
      hourlyCap: caps.hourly,
      dailyCap: caps.daily,
      globalHourlyCap: caps.global,
      globalDailyCap: 500,
      prospectiveCooldownHours: 24,
    });
  }

  async function reserveFor(id: string, caps: { hourly: number; daily: number; global: number }) {
    const result = await reserveRaw(id, caps);
    return result.kind === "reserved" ? null : result.reason;
  }

  // THE two-process race. With a cap of 1 and two workers reserving at once, exactly one
  // may proceed. Before the fix both read zero and both would have posted.
  it("gives exactly one of two simultaneous workers the last slot", async () => {
    const campaignId = await freshCampaign();
    const [a, b] = await Promise.all([makeCandidate(campaignId), makeCandidate(campaignId)]);
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    // Both hold their own claim, which is what the worker state looks like here.
    await Promise.all([
      repo.claimCandidate(a, now, lease),
      repo.claimCandidate(b, now, lease),
    ]);

    const results = await Promise.all([
      reserveFor(a, { hourly: 1, daily: 10, global: 50 }),
      reserveFor(b, { hourly: 1, daily: 10, global: 50 }),
    ]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "hourly_cap_reached")).toHaveLength(1);
  });

  // An uncertain post may be live on Instagram, so it consumes a slot. Excluding it let
  // an unknown number of real public comments escape the cap.
  it("counts an uncertain attempt against the cap", async () => {
    const campaignId = await freshCampaign();
    const spent = await makeCandidate(campaignId);
    const next = await makeCandidate(campaignId);
    const now = new Date();
    const held = await repo.claimCandidate(spent, now, new Date(now.getTime() + 60_000));
    await repo.claimCandidate(next, now, new Date(now.getTime() + 60_000));
    const reservation = await reserveRaw(spent, { hourly: 1, daily: 10, global: 50 });
    if (reservation.kind !== "reserved") throw new Error("expected reservation");
    await repo.startHistoricalDispatch({
      candidateId: spent,
      commentId: await approvedCommentId(spent),
      claimToken: held!.claimToken,
      batchRunId: await openBatch(campaignId, now),
      ...reservation,
      now,
    });
    await repo.finalizeHistoricalDispatch({
      candidateId: spent,
      claimToken: held!.claimToken,
      ...reservation,
      outcome: { kind: "uncertain", reason: "transport_uncertain" },
    });

    expect(await reserveFor(next, { hourly: 1, daily: 10, global: 50 })).toBe("hourly_cap_reached");
  });

  // The mirror image of the test above, and the one that was missing. `safe_retry` is
  // rate limiting ONLY — Meta rejects the request before creating anything, so the row
  // provably did not post. Handing it back has to free the slot it reserved.
  //
  // Otherwise a rate-limit burst spends the cap on comments that never existed: at
  // dailyCap 10, ten throttled attempts make every later reservation return
  // `daily_cap_reached` for 24 hours, and the worker breaks the tick on refusal. The
  // campaign goes silent for a day having posted nothing.
  it("frees the reserved slot when a rate-limited row is handed back", async () => {
    const campaignId = await freshCampaign();
    const throttled = await makeCandidate(campaignId);
    const next = await makeCandidate(campaignId);
    const now = new Date();
    const held = await repo.claimCandidate(throttled, now, new Date(now.getTime() + 60_000));

    const reservation = await reserveRaw(throttled, { hourly: 1, daily: 10, global: 50 });
    expect(reservation.kind).toBe("reserved");
    if (reservation.kind !== "reserved") throw new Error("expected reservation");

    // Exactly what the worker's safe_retry branch does: release with a backoff, and
    // write no outcome, because there is no outcome to write.
    await repo.finalizeHistoricalDispatch({
      candidateId: throttled,
      claimToken: held!.claimToken,
      ...reservation,
      outcome: {
        kind: "released",
        at: now,
        reason: "rate_limit",
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
      },
    });

    // Claimed first, because reserving stamps the dispatch and
    // chk_candidate_dispatch_needs_claim requires a claim to stamp it under. That is the
    // worker's order too: claim, recheck, reserve, send.
    await repo.claimCandidate(next, now, new Date(now.getTime() + 60_000));
    expect(await reserveFor(next, { hourly: 1, daily: 10, global: 50 })).toBeNull();
  });

  // QA-10's invariant, which the stale stamp broke: `dispatchStartedAt` set means "Meta
  // may have been called". A row handed back after a rate limit did NOT reach Meta, so a
  // later death while PREPARING that row must release it — not park it as
  // `send_uncertain`, which is terminal and never retried.
  it("does not park a re-claimed rate-limited row as uncertain", async () => {
    const campaignId = await freshCampaign();
    const id = await makeCandidate(campaignId);
    const now = new Date();
    const held = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    const reservation = await reserveRaw(id, { hourly: 5, daily: 50, global: 500 });
    if (reservation.kind !== "reserved") throw new Error("expected reservation");
    await repo.finalizeHistoricalDispatch({
      candidateId: id,
      claimToken: held!.claimToken,
      ...reservation,
      outcome: { kind: "released", at: now, reason: "rate_limit", nextAttemptAt: now },
    });

    // Claimed again, then the worker dies before reserving. The lease is short but
    // valid — chk_candidate_claim_ordering forbids an expiry before the claim — and the
    // sweep runs after it lapses.
    await repo.claimCandidate(id, now, new Date(now.getTime() + 1_000));
    await repo.reconcileExpiredCandidateLeases(new Date(now.getTime() + 60_000));

    const row = await prisma.recoveryCandidate.findUnique({ where: { id } });
    expect(row!.outcome).toBe("pending");
  });

  /**
   * How many sends the global cap currently sees.
   *
   * The global cap is global BY DESIGN, so it counts rows other tests created. Asserting
   * against an absolute number like 1 therefore fails for the wrong reason — the first
   * version of this test did exactly that. Measuring the live count and setting the cap
   * at it makes the NEXT send the one refused, which is the property under test.
   */
  async function globalSendsThisHour(): Promise<number> {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return prisma.publicRecoveryDispatch.count({
      where: {
        state: { in: ["reserved", "dispatch_started", "sent", "uncertain"] },
        reservedAt: { gt: hourAgo },
      },
    });
  }

  // The prospective feature posts under the same account name, so its sends have to
  // count. This is the cross-system ceiling the caps previously lacked entirely.
  it("counts prospective sends against the global cap", async () => {
    const campaignId = await freshCampaign();
    const id = await makeCandidate(campaignId);
    const row = await prisma.recoveryCandidate.findUnique({ where: { id } });
    const now = new Date();
    await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));

    const before = await globalSendsThisHour();

    const prospectivePerson = `${fx.igUserId}-pro-${randomUUID()}`;
    await prisma.igUser.create({ data: { id: prospectivePerson } });
    await prisma.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: prospectivePerson,
        sourceKind: "prospective",
        sourceId: randomUUID(),
        attemptNumber: 1,
        state: "sent",
        reservedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        dispatchStartedAt: now,
        sentAt: now,
        providerReplyId: `provider-${randomUUID()}`,
      },
    });

    // One prospective send arrived, so the count must have moved by exactly one — that
    // increment IS the cross-system visibility being tested.
    expect(await globalSendsThisHour()).toBe(before + 1);

    // Campaign caps wide open; the global ceiling set at the pre-existing total means the
    // prospective send is what pushes this candidate over.
    expect(await reserveFor(id, { hourly: 50, daily: 200, global: before + 1 })).toBe(
      "global_hourly_cap_reached",
    );
  });

  // The daily cap is checked as well as the hourly one: at 3/hour a "daily cap 10"
  // campaign would otherwise post 72 a day.
  it("refuses on the daily cap before the hourly one", async () => {
    const campaignId = await freshCampaign();
    const spent = await makeCandidate(campaignId);
    const next = await makeCandidate(campaignId);
    const now = new Date();
    const held = await repo.claimCandidate(spent, now, new Date(now.getTime() + 60_000));
    await repo.claimCandidate(next, now, new Date(now.getTime() + 60_000));
    const reservation = await reserveRaw(spent, { hourly: 50, daily: 1, global: 50 });
    if (reservation.kind !== "reserved") throw new Error("expected reservation");
    await repo.startHistoricalDispatch({
      candidateId: spent,
      commentId: await approvedCommentId(spent),
      claimToken: held!.claimToken,
      batchRunId: await openBatch(campaignId, now),
      ...reservation,
      now,
    });
    await repo.finalizeHistoricalDispatch({
      candidateId: spent,
      claimToken: held!.claimToken,
      ...reservation,
      outcome: {
        kind: "sent",
        providerReplyId: `179${randomUUID().slice(0, 8)}`,
        at: now,
      },
    });

    expect(await reserveFor(next, { hourly: 50, daily: 1, global: 50 })).toBe("daily_cap_reached");
  });

  // The reserving row must not count ITSELF: its own in-flight claim would otherwise
  // consume the slot it is asking for, and a cap of 1 would never send anything.
  it("does not let a candidate block its own reservation", async () => {
    const campaignId = await freshCampaign();
    const id = await makeCandidate(campaignId);
    const now = new Date();
    await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));

    // Campaign caps of 1: the row's own claim must not consume the slot it is asking
    // for, or a stage-0 campaign at batch 1 would never send anything. The global cap is
    // set above the live total so only the self-counting rule is under test.
    const global = (await globalSendsThisHour()) + 1;
    expect(await reserveFor(id, { hourly: 1, daily: 1, global })).toBeNull();
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

  // The other half of QA-02: a stale claimant must not be able to change pre-dispatch
  // source state. Ledger start/finalise fencing is covered by the shared dispatch contract.
  it("refuses to let a stale token finalise the winner's row", async () => {
    const id = await makeCandidate();
    const now = new Date();
    const winner = await repo.claimCandidate(id, now, new Date(now.getTime() + 60_000));
    expect(winner).not.toBeNull();

    const stale = randomUUID();
    expect(await repo.markCandidateSuppressed(id, stale, "nope")).toBe(false);
    expect(await repo.markCandidateFailed(id, stale, "nope")).toBe(false);
    expect(await repo.releaseCandidateClaim(id, stale)).toBe(false);

    // Still the winner's and still mutable by the rightful holder before reservation.
    expect(await repo.markCandidateFailed(id, winner!.claimToken, "source_read_exhausted"))
      .toBe(true);
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

});
