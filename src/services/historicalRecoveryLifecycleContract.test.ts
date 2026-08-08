import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// QA-12. Three gaps that together made the campaign unmeasurable and unfinishable:
//
//   1. `completeCampaignIfDrained` existed with NO production caller, so a campaign that
//      had sent everything stayed `running` forever.
//   2. Holdout rows stayed `outcome = pending` for good. The worker skipped them by arm,
//      but the completion check counted them, so a campaign WITH a holdout could never
//      drain. `holdout_withheld` was in the enum and never written, so nothing recorded
//      that withholding was deliberate.
//   3. `laterInboundAt` and `laterCompletedAt` had no writer at all — only reads in the
//      API and the dashboard. The "recovered" view was permanently empty and the
//      recovery rate, the single number that says whether the campaign was worth
//      running, could not be computed.
//
// Real Postgres: this is a lifecycle across recovery_campaign, recovery_candidate,
// conversations and journey_intent, with enum and CHECK constraints that only exist in
// the database.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let control: typeof import("./recoveryCampaignControl.js");
let attribution: typeof import("./historicalRecoveryAttribution.js");

type Fixture = { resourceId: string; keywordId: string; otherKeywordId: string; igUserId: string };
let fx: Fixture;

const T0 = new Date("2026-07-01T10:00:00Z");

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  control = await import("./recoveryCampaignControl.js");
  attribution = await import("./historicalRecoveryAttribution.js");

  fx = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    otherKeywordId: randomUUID(),
    igUserId: `life-${randomUUID()}`,
  };
  await prisma.resource.create({ data: { id: fx.resourceId, name: "lifecycle" } });
  for (const [id, word] of [
    [fx.keywordId, "SLEEP"],
    [fx.otherKeywordId, "POTTY"],
  ] as const) {
    await prisma.keyword.create({
      data: {
        id,
        keyword: `${word}-${id}`,
        resourceId: fx.resourceId,
        publicReply: "x",
        gateMessage: "y",
      },
    });
  }
});

async function wipe(): Promise<void> {
  await prisma.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: "life-" } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
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
  await prisma.keyword.deleteMany({ where: { id: { in: [fx.keywordId, fx.otherKeywordId] } } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

/** A draft campaign. */
async function draft(): Promise<string> {
  const row = await prisma.recoveryCampaign.create({
    data: {
      phase: "unknown_read_pilot",
      selectionVersion: `life-${randomUUID()}`,
      sourceDataCutoff: T0,
      copyVersion: "recovery-v2",
      state: "draft",
    },
  });
  return row.id;
}

/** One candidate, with its own person and intent. */
async function candidate(
  campaignId: string,
  opts: { arm: "treatment" | "holdout"; keywordId?: string; outcome?: "pending" | "sent" },
): Promise<{ id: string; igUserId: string }> {
  const igUserId = `${fx.igUserId}-${randomUUID()}`;
  const keywordId = opts.keywordId ?? fx.keywordId;
  await prisma.igUser.create({ data: { id: igUserId } });
  const intent = await prisma.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: T0,
      lastTriggerAt: T0,
      windowExpiresAt: new Date(T0.getTime() + 48 * 3600_000),
    },
  });
  const sent = opts.outcome === "sent";
  const row = await prisma.recoveryCandidate.create({
    data: {
      campaignId,
      campaignPhase: "unknown_read_pilot",
      intentId: intent.id,
      igUserId,
      keywordId,
      commentId: `life-c-${randomUUID()}`,
      commentAt: T0,
      keywordSnapshot: "SLEEP",
      publicReplyText: "t",
      evidence: "gate_sent_no_read",
      arm: opts.arm,
      eligibleAt: T0,
      outcome: opts.outcome ?? "pending",
      ...(sent
        ? {
            sentAt: new Date(T0.getTime() + 3600_000),
            // Required by chk_candidate_sent_has_reply_id.
            publicReplyId: `179${randomUUID().slice(0, 8)}`,
          }
        : {}),
    },
  });
  return { id: row.id, igUserId };
}

async function stateOf(campaignId: string): Promise<string> {
  const row = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { state: true },
  });
  return row!.state;
}

describeWithLocalDatabase("holdout assignment is settled at approval", () => {
  // THE reason a holdout campaign could never finish: holdout rows counted as pending
  // work that would never be done.
  it("marks holdout rows holdout_withheld so they are not pending work", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    const held = await candidate(campaignId, { arm: "holdout" });

    await control.approveCampaign(campaignId, "owner", T0);

    const row = await prisma.recoveryCandidate.findUnique({ where: { id: held.id } });
    expect(row!.outcome).toBe("holdout_withheld");
    expect(row!.suppressionReason).toBe("holdout_arm");
    // Never contacted. That is the whole point of the arm.
    expect(row!.sentAt).toBeNull();
    expect(row!.publicReplyId).toBeNull();
  });

  it("leaves treatment rows pending so they can still be sent", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });

    await control.approveCampaign(campaignId, "owner", T0);

    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.outcome).toBe("pending");
  });

  // A campaign whose every candidate is a holdout has nothing to do. Without this it
  // would sit `running` with no work, showing as active forever.
  it("completes immediately when every candidate is a holdout", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "holdout" });
    await candidate(campaignId, { arm: "holdout" });

    await control.approveCampaign(campaignId, "owner", T0);

    expect(await stateOf(campaignId)).toBe("completed");
  });

  it("stays running while treatment work remains", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await candidate(campaignId, { arm: "holdout" });

    await control.approveCampaign(campaignId, "owner", T0);

    expect(await stateOf(campaignId)).toBe("running");
  });
});

describeWithLocalDatabase("a drained campaign completes", () => {
  // Drained is now "no actionable TREATMENT work", not "no pending rows".
  it("completes once the last treatment row is settled, despite holdout rows", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await candidate(campaignId, { arm: "holdout" });
    await control.approveCampaign(campaignId, "owner", T0);
    expect(await stateOf(campaignId)).toBe("running");

    await prisma.recoveryCandidate.update({
      where: { id: treat.id },
      data: {
        outcome: "sent",
        sentAt: new Date(T0.getTime() + 3600_000),
        publicReplyId: `179${randomUUID().slice(0, 8)}`,
      },
    });

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(true);
    expect(await stateOf(campaignId)).toBe("completed");
  });

  it("refuses while a treatment row is still pending", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await control.approveCampaign(campaignId, "owner", T0);

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("running");
  });

  // A cancelled campaign is finished for a different reason and must not be relabelled:
  // `completed` means it did its job, `cancelled` means it was stopped.
  it("does not relabel a cancelled campaign as completed", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await control.approveCampaign(campaignId, "owner", T0);
    await control.cancelCampaign(campaignId, "changed my mind", T0);

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("cancelled");
  });
});

describeWithLocalDatabase("outcomes are attributed to both arms", () => {
  // Without this the recovered view was empty and the recovery rate did not exist.
  it("records a completion on a treated candidate", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await control.approveCampaign(campaignId, "owner", T0);

    const at = new Date(T0.getTime() + 2 * 24 * 3600_000);
    const n = await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId,
      keywordId: fx.keywordId,
      at,
      kind: "completed",
    });

    expect(n).toBe(1);
    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.laterCompletedAt).toEqual(at);
  });

  // The baseline. A holdout who returns on their own is what the lift is measured
  // AGAINST — attributing only treatment would make every recovery look like a success.
  it("records a completion on a holdout that recovered on its own", async () => {
    const campaignId = await draft();
    const held = await candidate(campaignId, { arm: "holdout" });
    await control.approveCampaign(campaignId, "owner", T0);

    const at = new Date(T0.getTime() + 3 * 24 * 3600_000);
    await attribution.attributeRecoveryOutcome({
      igUserId: held.igUserId,
      keywordId: fx.keywordId,
      at,
      kind: "completed",
    });

    const row = await prisma.recoveryCandidate.findUnique({ where: { id: held.id } });
    expect(row!.laterCompletedAt).toEqual(at);
  });

  // Earliest-wins. The question is "did they come back", so the FIRST return answers it;
  // letting a later one overwrite would inflate the measured delay.
  it("keeps the earliest timestamp and ignores a replay", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await control.approveCampaign(campaignId, "owner", T0);

    const first = new Date(T0.getTime() + 2 * 24 * 3600_000);
    const later = new Date(T0.getTime() + 5 * 24 * 3600_000);
    await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId, keywordId: fx.keywordId, at: first, kind: "completed",
    });
    const second = await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId, keywordId: fx.keywordId, at: later, kind: "completed",
    });

    expect(second).toBe(0);
    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.laterCompletedAt).toEqual(first);
  });

  // Same scoping as QA-11: a candidate is a request for one guide, so completing a
  // different one is not a recovery of this one.
  it("does not attribute a completion of another keyword", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await control.approveCampaign(campaignId, "owner", T0);

    const n = await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId,
      keywordId: fx.otherKeywordId,
      at: new Date(T0.getTime() + 2 * 24 * 3600_000),
      kind: "completed",
    });

    expect(n).toBe(0);
    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.laterCompletedAt).toBeNull();
  });

  // An inbound DM names no keyword — 608 of 683 measured are a bare "DONE" — so it is
  // person-level evidence and must not require one.
  it("attributes an inbound without a keyword", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await control.approveCampaign(campaignId, "owner", T0);

    const at = new Date(T0.getTime() + 2 * 24 * 3600_000);
    await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId,
      at,
      kind: "inbound",
    });

    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.laterInboundAt).toEqual(at);
    // Distinct columns: the inbound is the leading indicator, not the outcome.
    expect(row!.laterCompletedAt).toBeNull();
  });

  // A pending row has not been acted on, so a return cannot be a response to it.
  it("does not attribute to a candidate that was never settled", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await control.approveCampaign(campaignId, "owner", T0);

    const n = await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId,
      keywordId: fx.keywordId,
      at: new Date(T0.getTime() + 2 * 24 * 3600_000),
      kind: "completed",
    });

    expect(n).toBe(0);
  });

  // Evidence that predates the send is not a response to it.
  it("does not attribute a completion that predates the send", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await control.approveCampaign(campaignId, "owner", T0);

    const n = await attribution.attributeRecoveryOutcome({
      igUserId: treat.igUserId,
      keywordId: fx.keywordId,
      // Before sentAt, which is T0 + 1h.
      at: new Date(T0.getTime() + 60_000),
      kind: "completed",
    });

    expect(n).toBe(0);
  });

  // Attribution can be the last thing a campaign was waiting on.
  it("never throws when there is nothing to attribute", async () => {
    await expect(
      attribution.attributeRecoveryOutcome({
        igUserId: `${fx.igUserId}-nobody`,
        keywordId: fx.keywordId,
        at: T0,
        kind: "completed",
      }),
    ).resolves.toBe(0);
  });
});
