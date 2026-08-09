import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";

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
let lockClient: PrismaClient;
let control: typeof import("./recoveryCampaignControl.js");
let attribution: typeof import("./historicalRecoveryAttribution.js");
let snapshots: typeof import("./historicalRecoverySnapshot.js");

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
  lockClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  control = await import("./recoveryCampaignControl.js");
  attribution = await import("./historicalRecoveryAttribution.js");
  snapshots = await import("./historicalRecoverySnapshot.js");

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
  await prisma.publicRecoveryDispatch.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaignBatchRun.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: "life-" } } },
  });
  await prisma.recoveryCampaignHealthObservation.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: "life-" } } },
  });
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
  await lockClient.$disconnect();
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
      eligibilityPolicyVersion: "eligibility-v2",
      westernOnly: true,
      inboundWindowHours: 48,
      completionWindowHours: 48,
    },
  });
  return row.id;
}

/** One candidate, with its own person and intent. */
async function candidate(
  campaignId: string,
  opts: {
    arm: "treatment" | "holdout";
    keywordId?: string;
    outcome?: "pending" | "sent";
    audienceOriginMethod?: string | null;
  },
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
  const selectionPosition = await prisma.recoveryCandidate.count({ where: { campaignId } });
  const commentId = `life-c-${randomUUID()}`;
  const row = await prisma.recoveryCandidate.create({
    data: {
      campaignId,
      campaignPhase: "unknown_read_pilot",
      intentId: intent.id,
      igUserId,
      keywordId,
      commentId,
      commentAt: T0,
      keywordSnapshot: "SLEEP",
      publicReplyText: "t",
      evidence: "gate_sent_no_read",
      audienceOrigin: "us_western",
      audienceOriginMethod: opts.audienceOriginMethod === undefined
        ? CURRENT_ORIGIN_METHOD
        : opts.audienceOriginMethod,
      audienceOriginConfidence: "high",
      selectionPosition,
      sourceChoiceReason: "newest_eligible_comment",
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
  await prisma.recoveryCampaign.update({
    where: { id: campaignId },
    data: { candidateCount: { increment: 1 } },
  });
  await prisma.recoveryCandidateSource.create({
    data: {
      candidateId: row.id,
      position: 0,
      commentId,
      receivedAt: T0,
      choiceReason: "newest_eligible_comment",
    },
  });
  return { id: row.id, igUserId };
}

async function sealSnapshot(campaignId: string): Promise<void> {
  const campaign = await prisma.recoveryCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  const rows = await prisma.recoveryCandidate.findMany({
    where: { campaignId },
    orderBy: [{ selectionPosition: "asc" }, { id: "asc" }],
    include: { sources: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
  });
  const exclusions = await prisma.recoverySelectionExclusion.findMany({
    where: { campaignId },
    orderBy: [{ intentId: "asc" }, { id: "asc" }],
  });
  const configuration = {
    phase: campaign.phase,
    selectionVersion: campaign.selectionVersion,
    sourceDataCutoff: campaign.sourceDataCutoff.toISOString(),
    commentFrom: campaign.commentFrom?.toISOString() ?? null,
    commentTo: campaign.commentTo?.toISOString() ?? null,
    selectionLimit: campaign.selectionLimit,
    westernOnly: campaign.westernOnly!,
    holdoutPercent: campaign.holdoutPercent,
    copyVersion: campaign.copyVersion,
    eligibilityPolicyVersion: campaign.eligibilityPolicyVersion!,
    inboundWindowHours: campaign.inboundWindowHours,
    completionWindowHours: campaign.completionWindowHours,
  };
  const inclusions = rows.map((row) => ({
    position: row.selectionPosition!,
    intentId: row.intentId,
    igUserId: row.igUserId,
    conversationId: row.conversationId,
    keywordId: row.keywordId,
    commentId: row.commentId,
    mediaId: row.mediaId,
    commentAt: row.commentAt.toISOString(),
    keywordSnapshot: row.keywordSnapshot,
    publicReplyText: row.publicReplyText,
    evidence: row.evidence,
    audienceOrigin: row.audienceOrigin,
    audienceOriginMethod: row.audienceOriginMethod,
    audienceOriginConfidence: row.audienceOriginConfidence,
    arm: row.arm,
    sourceChoiceReason: row.sourceChoiceReason!,
    sources: row.sources.map((source) => ({
      position: source.position,
      commentId: source.commentId,
      mediaId: source.mediaId,
      receivedAt: source.receivedAt.toISOString(),
      choiceReason: source.choiceReason,
    })),
  }));
  const snapshotExclusions = exclusions.map(({ intentId, igUserId, keywordId, reason }) => ({
    intentId,
    igUserId,
    keywordId,
    reason,
  }));
  await prisma.recoveryCampaign.update({
    where: { id: campaignId },
    data: {
      selectionFingerprint: snapshots.buildSelectionFingerprint(configuration),
      decisionHash: snapshots.buildSelectionDecisionHash(
        configuration,
        inclusions,
        snapshotExclusions,
      ),
    },
  });
}

async function approve(campaignId: string): Promise<Awaited<ReturnType<typeof control.approveCampaign>>> {
  await sealSnapshot(campaignId);
  return control.approveCampaign(campaignId, "owner", T0);
}

async function stateOf(campaignId: string): Promise<string> {
  const row = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { state: true },
  });
  return row!.state;
}

describeWithLocalDatabase("holdout assignment is settled at approval", () => {
  it("serializes an approval against a source inserted after review", async () => {
    const campaignId = await draft();
    const selected = await candidate(campaignId, { arm: "treatment" });
    await sealSnapshot(campaignId);

    let release!: () => void;
    let acquired!: () => void;
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const acquiredSignal = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = lockClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${selected.id}::uuid FOR UPDATE`;
      acquired();
      await releaseSignal;
    });
    await acquiredSignal;

    const waitForBlockedApproval = async (): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%recovery_candidate%FOR UPDATE%'
        `;
        if (Number(row?.n ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("approval did not block on the candidate lock");
    };
    const waitForBlockedSourceInsert = async (): Promise<"blocked"> => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%recovery_candidate_source%'
        `;
        if (Number(row?.n ?? 0) >= 1) return "blocked";
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("source insert did not block on the campaign lock");
    };

    const approval = control.approveCampaign(campaignId, "owner", T0);
    await waitForBlockedApproval();
    const insertedCommentId = `life-unreviewed-${randomUUID()}`;
    const sourceInsert = prisma.recoveryCandidateSource.create({
      data: {
        candidateId: selected.id,
        position: 1,
        commentId: insertedCommentId,
        receivedAt: T0,
        choiceReason: "not_reviewed",
      },
    });
    const insertState = await Promise.race([
      sourceInsert.then(() => "completed" as const, () => "rejected" as const),
      waitForBlockedSourceInsert(),
    ]);
    release();

    try {
      expect(insertState).toBe("blocked");
      await expect(approval).resolves.toEqual({ ok: true, state: "running" });
      await expect(sourceInsert).rejects.toThrow(/reviewed campaign manifest is immutable/i);
      expect(await prisma.recoveryCandidateSource.count({
        where: { candidateId: selected.id },
      })).toBe(1);
    } finally {
      release();
      await blocker;
      await Promise.allSettled([approval, sourceInsert]);
    }
  });

  it("rejects every approval-defining manifest mutation after the campaign is sealed", async () => {
    const campaignId = await draft();
    const selected = await candidate(campaignId, { arm: "treatment" });
    await expect(approve(campaignId)).resolves.toEqual({ ok: true, state: "running" });

    await expect(prisma.recoveryCampaign.update({
      where: { id: campaignId },
      data: { westernOnly: false },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
    await expect(prisma.recoveryCandidate.update({
      where: { id: selected.id },
      data: { publicReplyText: "unreviewed replacement" },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
    await expect(prisma.recoveryCandidate.update({
      where: { id: selected.id },
      data: { audienceOriginMethod: "name" },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
    await expect(prisma.recoveryCandidate.update({
      where: { id: selected.id },
      data: { audienceOriginMethod: null },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
    await expect(prisma.recoveryCandidate.findUnique({
      where: { id: selected.id },
      select: { audienceOriginMethod: true },
    })).resolves.toEqual({ audienceOriginMethod: CURRENT_ORIGIN_METHOD });
    await expect(prisma.recoveryCandidateSource.updateMany({
      where: { candidateId: selected.id },
      data: { commentId: `life-unreviewed-${randomUUID()}` },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
    await expect(prisma.recoveryCandidate.delete({
      where: { id: selected.id },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);

    const excludedPerson = `${fx.igUserId}-${randomUUID()}`;
    await prisma.igUser.create({ data: { id: excludedPerson } });
    const excludedIntent = await prisma.journeyIntent.create({
      data: {
        igUserId: excludedPerson,
        keywordId: fx.keywordId,
        windowStartedAt: T0,
        lastTriggerAt: T0,
        windowExpiresAt: new Date(T0.getTime() + 48 * 3600_000),
      },
    });
    await expect(prisma.recoverySelectionExclusion.create({
      data: {
        campaignId,
        intentId: excludedIntent.id,
        igUserId: excludedPerson,
        keywordId: fx.keywordId,
        reason: "unreviewed",
      },
    })).rejects.toThrow(/reviewed campaign manifest is immutable/i);
  });

  it("refuses to approve an incomplete reviewed snapshot", async () => {
    const campaign = await prisma.recoveryCampaign.create({
      data: {
        phase: "unknown_read_pilot",
        selectionVersion: `life-${randomUUID()}`,
        sourceDataCutoff: T0,
        copyVersion: "recovery-v2",
        state: "draft",
      },
    });

    await expect(control.approveCampaign(campaign.id, "owner", T0)).resolves.toEqual({
      ok: false,
      reason: "snapshot_incomplete",
    });
    expect(await stateOf(campaign.id)).toBe("draft");
  });

  it("rolls campaign approval back when holdout settlement fails", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    const held = await candidate(campaignId, { arm: "holdout" });
    await sealSnapshot(campaignId);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION p1_reject_holdout_settlement()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.outcome = 'holdout_withheld' THEN
          RAISE EXCEPTION 'injected holdout settlement failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER p1_reject_holdout_settlement_trigger
      BEFORE UPDATE ON recovery_candidate
      FOR EACH ROW EXECUTE FUNCTION p1_reject_holdout_settlement()
    `);

    try {
      await expect(control.approveCampaign(campaignId, "owner", T0)).rejects.toThrow(
        /holdout settlement failure/,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS p1_reject_holdout_settlement_trigger ON recovery_candidate",
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS p1_reject_holdout_settlement() ");
    }

    expect(await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true, approvedAt: true, approvedBy: true, startedAt: true },
    })).toEqual({ state: "draft", approvedAt: null, approvedBy: null, startedAt: null });
    expect(await prisma.recoveryCandidate.findUnique({
      where: { id: held.id },
      select: { outcome: true },
    })).toEqual({ outcome: "pending" });
  });

  // THE reason a holdout campaign could never finish: holdout rows counted as pending
  // work that would never be done.
  it("marks holdout rows holdout_withheld so they are not pending work", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    const held = await candidate(campaignId, { arm: "holdout" });

    await approve(campaignId);

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

    await approve(campaignId);

    const row = await prisma.recoveryCandidate.findUnique({ where: { id: treat.id } });
    expect(row!.outcome).toBe("pending");
  });

  it("refuses approval after an assigned arm drifts from the reviewed hash", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await sealSnapshot(campaignId);
    await prisma.recoveryCandidate.update({
      where: { id: treat.id },
      data: { arm: "holdout" },
    });

    await expect(control.approveCampaign(campaignId, "owner", T0)).resolves.toEqual({
      ok: false,
      reason: "snapshot_hash_mismatch",
    });
    expect(await stateOf(campaignId)).toBe("draft");
  });

  it("refuses approval after normalized campaign configuration drifts", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await sealSnapshot(campaignId);
    await prisma.recoveryCampaign.update({
      where: { id: campaignId },
      data: { westernOnly: false },
    });

    await expect(control.approveCampaign(campaignId, "owner", T0)).resolves.toEqual({
      ok: false,
      reason: "snapshot_fingerprint_mismatch",
    });
    expect(await stateOf(campaignId)).toBe("draft");
  });

  it("refuses approval when an approved source row is missing", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await sealSnapshot(campaignId);
    await prisma.recoveryCandidateSource.deleteMany({ where: { candidateId: treat.id } });

    await expect(control.approveCampaign(campaignId, "owner", T0)).resolves.toEqual({
      ok: false,
      reason: "snapshot_incomplete",
    });
    expect(await stateOf(campaignId)).toBe("draft");
  });

  // A campaign whose every candidate is a holdout has nothing to do. Without this it
  // would sit `running` with no work, showing as active forever.
  it("completes immediately when every candidate is a holdout", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "holdout" });
    await candidate(campaignId, { arm: "holdout" });

    const result = await approve(campaignId);

    expect(result).toEqual({ ok: true, state: "completed" });
    expect(await stateOf(campaignId)).toBe("completed");
  });

  it("stays running while treatment work remains", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await candidate(campaignId, { arm: "holdout" });

    await approve(campaignId);

    expect(await stateOf(campaignId)).toBe("running");
  });
});

describeWithLocalDatabase("resumption verifies the sealed snapshot", () => {
  it("does not resume a pre-Task-4 paused campaign with a missing candidate method", async () => {
    const campaignId = await draft();
    const selected = await candidate(campaignId, { arm: "treatment", audienceOriginMethod: null });
    await sealSnapshot(campaignId);
    await prisma.recoveryCampaign.update({
      where: { id: campaignId },
      data: {
        state: "paused",
        approvedBy: "owner",
        approvedAt: T0,
        startedAt: T0,
        pausedAt: T0,
      },
    });

    await expect(prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: {
        state: true,
        selectionFingerprint: true,
        decisionHash: true,
        eligibilityPolicyVersion: true,
        inboundWindowHours: true,
        completionWindowHours: true,
      },
    })).resolves.toEqual({
      state: "paused",
      selectionFingerprint: expect.any(String),
      decisionHash: expect.any(String),
      eligibilityPolicyVersion: "eligibility-v2",
      inboundWindowHours: 48,
      completionWindowHours: 48,
    });
    await expect(prisma.recoveryCandidate.findUnique({
      where: { id: selected.id },
      select: { audienceOriginMethod: true },
    })).resolves.toEqual({ audienceOriginMethod: null });

    await expect(control.resumeCampaign(campaignId)).resolves.toEqual({
      ok: false,
      reason: "snapshot_incomplete",
    });
    expect(await stateOf(campaignId)).toBe("paused");
  });

  it("resumes a paused campaign with a complete current-method snapshot", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await approve(campaignId);
    await control.pauseCampaign(campaignId, "owner pause", T0);

    await expect(control.resumeCampaign(campaignId)).resolves.toEqual({
      ok: true,
      state: "running",
    });
    expect(await stateOf(campaignId)).toBe("running");
  });
});

describeWithLocalDatabase("a drained campaign completes", () => {
  // Drained is now "no actionable TREATMENT work", not "no pending rows".
  it("completes once the last treatment row is settled, despite holdout rows", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await candidate(campaignId, { arm: "holdout" });
    await approve(campaignId);
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
    await approve(campaignId);

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("running");
  });

  // A cancelled campaign is finished for a different reason and must not be relabelled:
  // `completed` means it did its job, `cancelled` means it was stopped.
  it("does not relabel a cancelled campaign as completed", async () => {
    const campaignId = await draft();
    await candidate(campaignId, { arm: "treatment" });
    await approve(campaignId);
    await control.cancelCampaign(campaignId, "changed my mind", T0);

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("cancelled");
  });

  it("does not relabel an auto-paused drained campaign as completed", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await approve(campaignId);
    await prisma.recoveryCandidate.update({
      where: { id: treat.id },
      data: { outcome: "send_failed", suppressionReason: "contract" },
    });
    await control.pauseCampaign(campaignId, "auto:public_failure_rate", T0);

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("paused");
  });

  it("reconciles a drained running campaign after a process restart", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await approve(campaignId);
    await prisma.recoveryCandidate.update({
      where: { id: treat.id },
      data: {
        outcome: "sent",
        sentAt: new Date(T0.getTime() + 1),
        publicReplyId: `provider-${randomUUID()}`,
      },
    });

    const reconcile = (
      control as typeof control & {
        reconcileDrainedCampaigns(now?: Date): Promise<string[]>;
      }
    ).reconcileDrainedCampaigns;
    await expect(reconcile(T0)).resolves.toEqual([campaignId]);
    expect(await stateOf(campaignId)).toBe("completed");
  });

  it("does not complete while the dispatch ledger is still active", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment" });
    await approve(campaignId);
    await prisma.recoveryCandidate.update({
      where: { id: treat.id },
      data: { outcome: "send_failed", suppressionReason: "contract" },
    });
    await prisma.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: treat.igUserId,
        sourceKind: "historical",
        sourceId: treat.id,
        attemptNumber: 1,
        campaignId,
        state: "dispatch_started",
        reservedAt: T0,
        leaseExpiresAt: new Date(T0.getTime() + 60_000),
        dispatchStartedAt: T0,
      },
    });

    expect(await control.completeCampaignIfDrained(campaignId, T0)).toBe(false);
    expect(await stateOf(campaignId)).toBe("running");
  });
});

describeWithLocalDatabase("outcomes are attributed to both arms", () => {
  // Without this the recovered view was empty and the recovery rate did not exist.
  it("records a completion on a treated candidate", async () => {
    const campaignId = await draft();
    const treat = await candidate(campaignId, { arm: "treatment", outcome: "sent" });
    await approve(campaignId);

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
    await approve(campaignId);

    // Holdout attribution is bounded from approval/start; the exact 48h edge counts.
    const at = new Date(T0.getTime() + 48 * 3600_000);
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
    await approve(campaignId);

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
    await approve(campaignId);

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
    await approve(campaignId);

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
    await approve(campaignId);

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
    await approve(campaignId);

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
