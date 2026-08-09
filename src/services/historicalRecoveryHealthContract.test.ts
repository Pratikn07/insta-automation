import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// QA-13. The shared circuit reads only dm_recovery_reminder, so a historical campaign
// could be failing on real people's public comments while it stayed closed.
//
// Two properties need a real database:
//
//   1. A tripped stop condition PAUSES that campaign and nothing else. Pausing the shared
//      circuit would stop the healthy prospective feature too.
//   2. An automatic pause LATCHES. If any resume clears it, the stop is a suggestion — a
//      resume click, or a script sweeping paused campaigns, silently restarts sending
//      into whatever went wrong.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let health: typeof import("./historicalRecoveryHealth.js");
let control: typeof import("./recoveryCampaignControl.js");

type Fixture = { resourceId: string; keywordId: string; igUserId: string };
let fx: Fixture;

const T0 = new Date("2026-07-01T10:00:00Z");

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  health = await import("./historicalRecoveryHealth.js");
  control = await import("./recoveryCampaignControl.js");

  fx = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `hlth-${randomUUID()}`,
  };
  await prisma.resource.create({ data: { id: fx.resourceId, name: "campaign health" } });
  await prisma.keyword.create({
    data: {
      id: fx.keywordId,
      keyword: `SLEEP-${fx.keywordId}`,
      resourceId: fx.resourceId,
      publicReply: "x",
      gateMessage: "y",
    },
  });
});

async function wipe(): Promise<void> {
  await prisma.publicRecoveryDispatch.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaignBatchRun.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: "hlth-" } } },
  });
  await prisma.recoveryCampaignHealthObservation.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: "hlth-" } } },
  });
  // Delete the parent so PostgreSQL cascades through sealed manifest rows. Direct
  // candidate deletion is intentionally rejected once a campaign is approved.
  await prisma.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: "hlth-" } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
}

beforeEach(async () => {
  if (!prisma) return;
  await wipe();
});

afterAll(async () => {
  if (!prisma) return;
  await wipe();
  await prisma.keyword.deleteMany({ where: { id: fx.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

/** A running, approved campaign. */
async function runningCampaign(): Promise<string> {
  const row = await prisma.recoveryCampaign.create({
    data: {
      phase: "unknown_read_pilot",
      selectionVersion: `hlth-${randomUUID()}`,
      sourceDataCutoff: T0,
      copyVersion: "recovery-v2",
      decisionHash: "a".repeat(64),
      eligibilityPolicyVersion: "health-contract-v1",
      westernOnly: false,
      state: "running",
      approvedBy: "owner",
      approvedAt: T0,
      startedAt: T0,
    },
  });
  return row.id;
}

async function sealCampaignForResume(campaignId: string): Promise<void> {
  await prisma.recoveryCampaign.update({
    where: { id: campaignId },
    data: { selectionFingerprint: `hlth-fingerprint-${randomUUID()}` },
  });
}

/** `count` candidates in the given terminal state. */
async function candidates(
  campaignId: string,
  count: number,
  spec: { outcome: "sent" | "send_failed" | "send_uncertain" | "suppressed"; suppressionReason?: string },
): Promise<string[]> {
  const people: string[] = [];
  for (let i = 0; i < count; i++) {
    const igUserId = `${fx.igUserId}-${randomUUID()}`;
    people.push(igUserId);
    await prisma.igUser.create({ data: { id: igUserId } });
    const intent = await prisma.journeyIntent.create({
      data: {
        igUserId,
        keywordId: fx.keywordId,
        windowStartedAt: T0,
        lastTriggerAt: T0,
        windowExpiresAt: new Date(T0.getTime() + 48 * 3600_000),
      },
    });
    await prisma.recoveryCandidate.create({
      data: {
        campaignId,
        campaignPhase: "unknown_read_pilot",
        intentId: intent.id,
        igUserId,
        keywordId: fx.keywordId,
        commentId: `hlth-c-${randomUUID()}`,
        commentAt: T0,
        keywordSnapshot: "SLEEP",
        publicReplyText: "t",
        evidence: "gate_sent_no_read",
        arm: "treatment",
        eligibleAt: T0,
        outcome: spec.outcome,
        ...(spec.suppressionReason ? { suppressionReason: spec.suppressionReason } : {}),
        ...(spec.outcome === "sent"
          ? {
              sentAt: new Date(T0.getTime() + 3600_000),
              // Required by chk_candidate_sent_has_reply_id.
              publicReplyId: `179${randomUUID().slice(0, 8)}`,
            }
          : {}),
        ...(spec.outcome === "send_uncertain" ? { lastAttemptAt: new Date(T0.getTime() + 3600_000) } : {}),
      },
    });
  }
  return people;
}

async function campaignRow(id: string) {
  return prisma.recoveryCampaign.findUnique({
    where: { id },
    select: { state: true, pauseReason: true },
  });
}

describeWithLocalDatabase("campaign health reads recovery_candidate", () => {
  // The reading the shared circuit could never produce: it counts dm_recovery_reminder
  // rows only, so every one of these numbers was invisible to it.
  it("counts this campaign's own outcomes", async () => {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 6, { outcome: "sent" });
    await candidates(campaignId, 1, { outcome: "send_failed" });
    await candidates(campaignId, 1, { outcome: "send_uncertain" });
    await candidates(campaignId, 2, {
      outcome: "suppressed",
      suppressionReason: "source_comment_deleted",
    });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.sent).toBe(6);
    expect(reading.failed).toBe(1);
    expect(reading.uncertain).toBe(1);
    expect(reading.sourceUnavailable).toBe(2);
    expect(reading.settled).toBe(8);
  });

  // Scoped to the campaign: one campaign going wrong must not read as another failing.
  it("does not count another campaign's failures", async () => {
    const good = await runningCampaign();
    const bad = await runningCampaign();
    await candidates(good, 10, { outcome: "sent" });
    await candidates(bad, 10, { outcome: "send_failed" });

    const reading = await health.evaluateCampaignHealth(good, T0);

    expect(reading.failed).toBe(0);
    expect(reading.stopReason).toBeNull();
    expect((await campaignRow(good))!.state).toBe("running");
  });
});

describeWithLocalDatabase("a tripped stop condition pauses only that campaign", () => {
  it.each([
    "complaint",
    "opt_out",
    "block",
    "negative_reply",
    "classifier_anomaly",
  ] as const)("pauses immediately for a durable %s observation", async (kind) => {
    const campaignId = await runningCampaign();
    await prisma.recoveryCampaignHealthObservation.create({
      data: {
        campaignId,
        kind,
        sourceKey: `${kind}:${randomUUID()}`,
        observedAt: T0,
      },
    });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.stopReason).toBe(kind);
    expect(await campaignRow(campaignId)).toEqual({ state: "paused", pauseReason: `auto:${kind}` });
  });

  it("detects duplicate terminal contact from the shared dispatch ledger", async () => {
    const campaignId = await runningCampaign();
    const [igUserId] = await candidates(campaignId, 1, { outcome: "sent" });
    const dispatchStartedAt = new Date(T0.getTime() + 1_000);
    await prisma.publicRecoveryDispatch.createMany({
      data: [
        {
          reservationToken: randomUUID(),
          igUserId: igUserId!,
          sourceKind: "historical" as const,
          sourceId: randomUUID(),
          attemptNumber: 1,
          campaignId,
          state: "sent" as const,
          reservedAt: T0,
          leaseExpiresAt: new Date(T0.getTime() + 60_000),
          dispatchStartedAt,
          sentAt: dispatchStartedAt,
          providerReplyId: `provider-${randomUUID()}`,
        },
        {
          reservationToken: randomUUID(),
          igUserId: igUserId!,
          sourceKind: "historical" as const,
          sourceId: randomUUID(),
          attemptNumber: 1,
          campaignId,
          state: "uncertain" as const,
          reservedAt: T0,
          leaseExpiresAt: new Date(T0.getTime() + 60_000),
          dispatchStartedAt,
          terminalReason: "contract",
        },
      ],
    });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.duplicatePeople).toBe(1);
    expect(reading.stopReason).toBe("duplicate_public_reply");
    expect(await campaignRow(campaignId)).toEqual({
      state: "paused",
      pauseReason: "auto:duplicate_public_reply",
    });
  });

  it("pauses the failing campaign", async () => {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 5, { outcome: "sent" });
    await candidates(campaignId, 5, { outcome: "send_failed" });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.stopReason).toBe("public_failure_rate");
    const row = await campaignRow(campaignId);
    expect(row!.state).toBe("paused");
    // Prefixed so the latch can tell an automatic stop from an owner's pause.
    expect(row!.pauseReason).toBe("auto:public_failure_rate");
  });

  // The shared circuit stays reserved for genuinely shared faults, like a broken token.
  // A bad campaign must not stop the prospective feature.
  it("leaves the shared circuit closed", async () => {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 5, { outcome: "sent" });
    await candidates(campaignId, 5, { outcome: "send_failed" });
    await prisma.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1, circuitOpen: false },
      update: { circuitOpen: false, reason: null },
    });

    await health.evaluateCampaignHealth(campaignId, T0);

    const circuit = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });
    expect(circuit!.circuitOpen).toBe(false);
  });

  it("leaves a healthy sibling campaign running", async () => {
    const healthy = await runningCampaign();
    const failing = await runningCampaign();
    await candidates(healthy, 10, { outcome: "sent" });
    await candidates(failing, 5, { outcome: "sent" });
    await candidates(failing, 5, { outcome: "send_failed" });

    await health.evaluateCampaignHealth(failing, T0);

    expect((await campaignRow(failing))!.state).toBe("paused");
    expect((await campaignRow(healthy))!.state).toBe("running");
  });

  it("does not pause a campaign that is sending cleanly", async () => {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 10, { outcome: "sent" });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.stopReason).toBeNull();
    expect((await campaignRow(campaignId))!.state).toBe("running");
  });

  // A cohort whose comments have all gone sends nothing, so `settled` stays 0. Without
  // its own sample floor this campaign would grind through suppressions forever without
  // reporting why.
  it("pauses a decayed cohort that has sent nothing", async () => {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 8, {
      outcome: "suppressed",
      suppressionReason: "source_comment_hidden",
    });

    const reading = await health.evaluateCampaignHealth(campaignId, T0);

    expect(reading.stopReason).toBe("source_unavailable_rate");
    expect((await campaignRow(campaignId))!.state).toBe("paused");
  });
});

describeWithLocalDatabase("an automatic pause latches", () => {
  async function autoPause(): Promise<string> {
    const campaignId = await runningCampaign();
    await candidates(campaignId, 5, { outcome: "sent" });
    await candidates(campaignId, 5, { outcome: "send_failed" });
    await sealCampaignForResume(campaignId);
    await health.evaluateCampaignHealth(campaignId, T0);
    return campaignId;
  }

  // THE property. An automatic stop any resume could undo is a suggestion, not a stop.
  it("refuses a plain resume after an automatic pause", async () => {
    const campaignId = await autoPause();

    const result = await control.resumeCampaign(campaignId);

    expect(result.ok).toBe(false);
    // Carries the reason, so the caller can show the owner what they would override.
    expect(result.ok === false && result.reason).toContain("auto_pause_requires_review");
    expect(result.ok === false && result.reason).toContain("public_failure_rate");
    expect((await campaignRow(campaignId))!.state).toBe("paused");
  });

  it("resumes once the owner acknowledges the stop", async () => {
    const campaignId = await autoPause();

    const result = await control.resumeCampaign(campaignId, {
      acknowledgeAutoPause: "reviewed by pratik, copy fixed",
    });

    expect(result.ok).toBe(true);
    const row = await campaignRow(campaignId);
    expect(row!.state).toBe("running");
    expect(row!.pauseReason).toBeNull();
  });

  it("rejects a blank acknowledgement", async () => {
    const campaignId = await autoPause();

    const result = await control.resumeCampaign(campaignId, { acknowledgeAutoPause: "   " });

    expect(result.ok).toBe(false);
    expect((await campaignRow(campaignId))!.state).toBe("paused");
  });

  // An ordinary owner pause is not a fault finding, so it must stay resumable with one
  // click. Latching everything would make the distinction useless.
  it("still resumes an ordinary owner pause without ceremony", async () => {
    const campaignId = await runningCampaign();
    await sealCampaignForResume(campaignId);
    await control.pauseCampaign(campaignId, "lunch", T0);

    const result = await control.resumeCampaign(campaignId);

    expect(result.ok).toBe(true);
    expect((await campaignRow(campaignId))!.state).toBe("running");
  });

  // Re-evaluating an already-paused campaign must not churn: pauseCampaign only matches
  // `running`, so the second call is a no-op rather than an error.
  it("is idempotent when the campaign is already paused", async () => {
    const campaignId = await autoPause();

    const again = await health.evaluateCampaignHealth(campaignId, T0);

    expect(again.stopReason).toBe("public_failure_rate");
    expect((await campaignRow(campaignId))!.pauseReason).toBe("auto:public_failure_rate");
  });
});
