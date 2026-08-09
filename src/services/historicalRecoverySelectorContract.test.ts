import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// QA-11. Four defects in the selector's evidence, all measured against production first:
//
//   1. It picked the OLDEST trigger. After QA-16 restored alias history, 15 eligible
//      intents carry more than one trigger and for all 15 the reply target changes. An
//      older comment is likelier to be deleted, and the newest ask is the one the person
//      remembers.
//   2. hasEngagementEvidence counted ANY lifetime inbound. 4 intents were excluded on a
//      DM that predated the request they were being excluded from. It also missed read
//      receipts and reactions entirely, which live on dm_recovery_reminder rather than
//      arriving as messages — 16 people would have been told "I don't think you saw it"
//      when we hold direct proof they did.
//   3. priorPublicRecovery read only the prospective table, so a historical campaign's
//      own sends were invisible to the next selection.
//   4. Completion was not bounded by the cutoff, so a rerun of a fixed selection version
//      could disagree with the reviewed dry run.
//
// Real Postgres: every one of these is a WHERE clause in one large raw query, and a
// mocked client would reproduce whatever the test itself wrote.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let selector: typeof import("./historicalRecoverySelector.js");

type Fixture = { resourceId: string; keywordId: string; otherKeywordId: string; igUserId: string };
let fx: Fixture;

/** Well inside the 7-day minimum age the selector applies. */
const COMMENT_AT = new Date("2026-06-01T10:00:00Z");
const NOW = new Date("2026-07-15T10:00:00Z");

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  selector = await import("./historicalRecoverySelector.js");

  fx = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    otherKeywordId: randomUUID(),
    igUserId: `sel-${randomUUID()}`,
  };
  await prisma.resource.create({ data: { id: fx.resourceId, name: "selector contract" } });
  for (const [id, word] of [
    [fx.keywordId, "SLEEP"],
    [fx.otherKeywordId, "POTTY"],
  ] as const) {
    await prisma.keyword.create({
      data: {
        id,
        keyword: `${word}-${id}`,
        resourceId: fx.resourceId,
        publicReply: `Sent! Check your DMs for ${word} 💛`,
        gateMessage: "y",
        active: true,
      },
    });
  }
  await prisma.$executeRaw`
    CREATE OR REPLACE FUNCTION "raise_p1_snapshot_contract_failure"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected snapshot contract failure';
    END
    $$
  `;
});

async function wipe(): Promise<void> {
  await prisma.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: "sel-test-" } } });
  await prisma.journeyTrigger.deleteMany({ where: { intent: { igUserId: { startsWith: fx.igUserId } } } });
  await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.gateQueue.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.dmMessage.deleteMany({ where: { thread: { igUserId: { startsWith: fx.igUserId } } } });
  await prisma.dmThread.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
  // Keywords outlive the per-test wipe, so a case that deactivates one to force an
  // exclusion would silently pre-exclude every later case. Restored rather than
  // recreated, because the fixture ids are referenced throughout.
  await prisma.keyword.updateMany({
    where: { id: { in: [fx.keywordId, fx.otherKeywordId] } },
    data: { active: true },
  });
}

beforeEach(async () => {
  if (!prisma) return;
  await wipe();
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_selection_exclusion"`;
  await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_candidate"`;
  await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_candidate_source"`;
  await prisma.$executeRaw`DROP FUNCTION IF EXISTS "raise_p1_snapshot_contract_failure"()`;
  await wipe();
  await prisma.keyword.deleteMany({ where: { id: { in: [fx.keywordId, fx.otherKeywordId] } } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

/**
 * One eligible `gate_sent_no_read` journey.
 *
 * Eligible means: a gate Meta accepted (a `dm_sent` event), no read receipt, an
 * in-market origin, an active keyword, and at least one comment trigger old enough to
 * clear the age window. Each trigger in `triggers` becomes its own comment.
 */
async function seedEligible(opts: {
  triggers: Array<{ at: Date; kind?: string; commentId?: string }>;
  person?: string;
  keywordId?: string;
}): Promise<{ intentId: string; igUserId: string; commentIds: string[] }> {
  const igUserId = opts.person ?? `${fx.igUserId}-${randomUUID()}`;
  const keywordId = opts.keywordId ?? fx.keywordId;

  await prisma.igUser.upsert({
    where: { id: igUserId },
    create: { id: igUserId, inferredOrigin: "us_western", originConfidence: "high" },
    update: {},
  });

  const intent = await prisma.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: COMMENT_AT,
      lastTriggerAt: COMMENT_AT,
      windowExpiresAt: new Date(COMMENT_AT.getTime() + 48 * 3600_000),
    },
  });
  const convo = await prisma.conversation.create({
    data: { igUserId, keywordId, state: "awaiting_done", createdAt: COMMENT_AT },
  });
  await prisma.journeyIntent.update({
    where: { id: intent.id },
    data: { canonicalConversationId: convo.id },
  });

  // The gate Meta accepted. Without this the row reads as `no_gate_evidence`.
  await prisma.eventLog.create({
    data: {
      kind: "dm_sent",
      payload: { conversationId: convo.id },
      createdAt: COMMENT_AT,
    },
  });

  const commentIds: string[] = [];
  for (const t of opts.triggers) {
    const commentId = t.commentId ?? `sel-c-${randomUUID()}`;
    commentIds.push(commentId);
    await prisma.journeyTrigger.create({
      data: {
        intentId: intent.id,
        conversationId: convo.id,
        commentId,
        receivedAt: t.at,
        triggerKind: t.kind ?? "comment",
        disposition: "new_journey",
      },
    });
  }

  return { intentId: intent.id, igUserId, commentIds };
}

/** Run the real selector as a dry run and return its report. */
async function select() {
  return selector.selectHistoricalCandidates({
    phase: "unknown_read_pilot",
    selectionVersion: `sel-test-${randomUUID()}`,
    copyVersion: "recovery-v2",
    westernOnly: true,
    // No holdout: one seeded candidate cannot split into two arms, and the split
    // validator rightly refuses (QA-07). These cases test evidence, not assignment.
    holdoutPercent: 0,
    persist: false,
    now: NOW,
  });
}

/** Run it for real and return the candidate rows it wrote. */
async function selectAndRead() {
  await selector.selectHistoricalCandidates({
    phase: "unknown_read_pilot",
    selectionVersion: `sel-test-${randomUUID()}`,
    copyVersion: "recovery-v2",
    westernOnly: true,
    holdoutPercent: 0,
    persist: true,
    now: NOW,
  });
  return prisma.recoveryCandidate.findMany({
    where: { igUserId: { startsWith: fx.igUserId } },
    select: { commentId: true, keywordId: true, igUserId: true },
  });
}

describeWithLocalDatabase("selector picks the newest available comment", () => {
  // THE defect. Replying to the oldest ask targets the comment likeliest to have been
  // deleted, and not the one the person remembers writing.
  it("replies to the newest comment, not the oldest", async () => {
    const { commentIds } = await seedEligible({
      triggers: [
        { at: COMMENT_AT },
        { at: new Date(COMMENT_AT.getTime() + 3600_000) },
        { at: new Date(COMMENT_AT.getTime() + 7200_000) },
      ],
    });

    const rows = await selectAndRead();

    expect(rows).toHaveLength(1);
    expect(rows[0].commentId).toBe(commentIds[2]);
    expect(rows[0].commentId).not.toBe(commentIds[0]);
  });

  // A DM has no comment to reply to. Preferring a newer DM over an older comment would
  // leave an eligible person with no target and turn them into a silent exclusion.
  it("ignores a newer DM trigger and keeps the comment", async () => {
    const { commentIds } = await seedEligible({
      triggers: [
        { at: COMMENT_AT, kind: "comment" },
        { at: new Date(COMMENT_AT.getTime() + 7200_000), kind: "dm" },
      ],
    });

    const rows = await selectAndRead();

    expect(rows).toHaveLength(1);
    expect(rows[0].commentId).toBe(commentIds[0]);
  });

  // A journey whose ONLY trigger is a DM must still be reported as dm_origin_no_comment
  // rather than no_source_comment: the two exclusions mean different things, and the
  // campaign report is what the owner reads (§37).
  // A DM-only journey must be reported as dm_origin_no_comment, NOT no_source_comment.
  // The two mean different things — "they asked by DM, there is nothing to reply to"
  // versus "we lost the comment id" — and the campaign report is what the owner reads
  // when deciding whether a cohort is worth pursuing (§37).
  //
  // Asserted through the classifier directly rather than through the selector's report.
  // The report is a count over the WHOLE table, and five other contract suites create
  // journey intents in the same database concurrently — a delta between two calls picked
  // up their rows and failed on every run. The selector's own SQL is covered by the
  // sibling cases above; what needs pinning here is that a DM trigger reaches the
  // classifier as `dm` rather than as a missing comment.
  it("still classifies a DM-only journey as dm_origin_no_comment", async () => {
    const { decideEligibility } = await import("./historicalRecoveryEligibility.js");

    // What loadRows produces for a journey whose only trigger is a DM: the comment
    // lateral finds nothing, and triggerKind falls back to the any-trigger read.
    const facts = {
      triggerKind: "dm",
      commentId: null,
      recipientUnreachable: false,
      hasEngagementEvidence: false,
      completedSameKeyword: false,
      priorPublicRecovery: false,
      supersededByNewerJourney: false,
      ambiguousPriorSend: false,
      gateAccepted: true,
      gateExhausted: false,
      keywordActive: true,
      audienceOrigin: "us_western",
      audienceOriginConfidence: "high",
      westernOnly: true,
      commentAt: COMMENT_AT,
      commentFrom: null,
      commentTo: NOW,
    };

    expect(decideEligibility(facts as never)).toEqual({
      kind: "exclude",
      reason: "dm_origin_no_comment",
    });

    // And with a comment id absent for any OTHER reason, the label differs — which is
    // the distinction the fallback exists to preserve.
    expect(decideEligibility({ ...facts, triggerKind: "unknown" } as never)).toEqual({
      kind: "exclude",
      reason: "no_source_comment",
    });
  });
});

describeWithLocalDatabase("selector scopes engagement evidence to after the request", () => {
  /** An inbound DM at a given time. */
  async function inbound(igUserId: string, at: Date): Promise<void> {
    const thread = await prisma.dmThread.create({
      data: { igUserId, igAccountId: "acct-1", lastMessageAt: at },
    });
    await prisma.dmMessage.create({
      data: {
        threadId: thread.id,
        direction: "inbound",
        type: "text",
        // A real message from the person, not one our automation sent.
        source: "instagram_user",
        text: "hi",
        instagramTimestamp: at,
        createdAt: at,
      },
    });
  }

  // Measured: 4 eligible intents were excluded on evidence older than the ask.
  it("does not exclude on an inbound that predates the request", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await inbound(igUserId, new Date(COMMENT_AT.getTime() - 30 * 24 * 3600_000));

    const report = await select();

    expect(report.eligible).toBe(1);
    expect(report.excludedByReason.has_engagement_evidence ?? 0).toBe(0);
  });

  // The control: an inbound AFTER the ask genuinely falsifies "you never saw this".
  it("excludes on an inbound after the request", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await inbound(igUserId, new Date(COMMENT_AT.getTime() + 3600_000));

    const report = await select();

    expect(report.eligible).toBe(0);
    expect(report.excludedByReason.has_engagement_evidence).toBe(1);
  });

  // Read receipts and reactions do NOT arrive as messages: the webhook writes them onto
  // dm_recovery_reminder. Checking messages alone missed the strongest evidence there is.
  // Measured: 16 people would have been told "I don't think you saw it" while we held a
  // read receipt proving otherwise.
  it("excludes on a read receipt, which is not a message", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const convo = await prisma.conversation.findFirst({ where: { igUserId } });
    await prisma.dmRecoveryReminder.create({
      data: {
        conversationId: convo!.id,
        igUserId,
        keywordId: fx.keywordId,
        keywordSnapshot: "SLEEP",
        templateVersion: "v1",
        publicReplyText: "t",
        commentId: `read-c-${randomUUID()}`,
        triggerKind: "no_confirmed_read",
        // Cancelled on purpose: the read receipt is the evidence, not the reminder's own
        // status. A cancelled reminder must still count as proof they opened the DM.
        status: "cancelled",
        // Required by chk_cancelled_has_cancelled_at.
        cancelledAt: new Date(COMMENT_AT.getTime() + 120_000),
        cohort: "treatment",
        eligibleAt: COMMENT_AT,
        // The proof: they opened the gate DM.
        seenAt: new Date(COMMENT_AT.getTime() + 60_000),
      },
    });

    const report = await select();

    expect(report.eligible).toBe(0);
    expect(report.excludedByReason.has_engagement_evidence).toBe(1);
  });

  it("does not suppress this intent for reminder engagement on another keyword", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const otherConversation = await prisma.conversation.create({
      data: {
        igUserId,
        keywordId: fx.otherKeywordId,
        state: "awaiting_done",
        createdAt: COMMENT_AT,
      },
    });
    await prisma.dmRecoveryReminder.create({
      data: {
        conversationId: otherConversation.id,
        igUserId,
        keywordId: fx.otherKeywordId,
        keywordSnapshot: "POTTY",
        templateVersion: "v1",
        publicReplyText: "t",
        commentId: `other-read-${randomUUID()}`,
        triggerKind: "no_confirmed_read",
        status: "cancelled",
        cancelledAt: new Date(COMMENT_AT.getTime() + 120_000),
        cohort: "treatment",
        eligibleAt: COMMENT_AT,
        seenAt: new Date(COMMENT_AT.getTime() + 60_000),
      },
    });

    const report = await select();

    expect(report.eligible).toBe(1);
    expect(report.excludedByReason.has_engagement_evidence ?? 0).toBe(0);
  });
});

describeWithLocalDatabase("selector sees both recovery systems", () => {
  // priorPublicRecovery read only dm_recovery_reminder, so a historical campaign's own
  // sends were invisible to the next selection. Zero instances today only because no
  // historical campaign has sent yet — the first one would have created them.
  it("excludes someone a historical campaign already contacted", async () => {
    const { igUserId, intentId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const campaign = await prisma.recoveryCampaign.create({
      data: {
        phase: "unknown_read_pilot",
        selectionVersion: `sel-test-prior-${randomUUID()}`,
        sourceDataCutoff: COMMENT_AT,
        copyVersion: "recovery-v2",
        state: "cancelled",
      },
    });
    await prisma.recoveryCandidate.create({
      data: {
        campaignId: campaign.id,
        campaignPhase: "unknown_read_pilot",
        intentId,
        igUserId,
        keywordId: fx.keywordId,
        commentId: `prior-${randomUUID()}`,
        commentAt: COMMENT_AT,
        keywordSnapshot: "SLEEP",
        publicReplyText: "t",
        evidence: "gate_sent_no_read",
        arm: "treatment",
        eligibleAt: COMMENT_AT,
        outcome: "sent",
        sentAt: new Date(COMMENT_AT.getTime() + 3600_000),
        // Required by chk_candidate_sent_has_reply_id: without Meta's id there is no
        // evidence the comment posted.
        publicReplyId: `179${randomUUID().slice(0, 8)}`,
      },
    });

    const report = await select();

    expect(report.eligible).toBe(0);
    expect(report.excludedByReason.prior_public_recovery).toBe(1);
  });
});

describeWithLocalDatabase("selector bounds completion by the cutoff", () => {
  // Unbounded completion made a rerun of a fixed selection version disagree with the
  // reviewed dry run, which is what reproducibility (QA-14) rests on.
  it("ignores a completion that happened after the cutoff", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    // A completion AFTER `now`, i.e. after the cutoff this selection uses.
    await prisma.conversation.create({
      data: {
        igUserId,
        keywordId: fx.keywordId,
        state: "completed",
        completedAt: new Date(NOW.getTime() + 24 * 3600_000),
        createdAt: COMMENT_AT,
      },
    });

    const report = await select();

    expect(report.eligible).toBe(1);
  });

  // The control: a completion before the cutoff is real evidence and must exclude.
  it("excludes on a completion before the cutoff", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await prisma.conversation.create({
      data: {
        igUserId,
        keywordId: fx.keywordId,
        state: "completed",
        completedAt: new Date(COMMENT_AT.getTime() + 3600_000),
        createdAt: COMMENT_AT,
      },
    });

    const report = await select();

    expect(report.eligible).toBe(0);
    expect(report.excludedByReason.already_completed_keyword).toBe(1);
  });

  // Completion of a DIFFERENT guide does not falsify a reminder about this one.
  it("ignores a completion on another keyword", async () => {
    const { igUserId } = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await prisma.conversation.create({
      data: {
        igUserId,
        keywordId: fx.otherKeywordId,
        state: "completed",
        completedAt: new Date(COMMENT_AT.getTime() + 3600_000),
        createdAt: COMMENT_AT,
      },
    });

    const report = await select();

    expect(report.eligible).toBe(1);
  });
});

// QA-14. Selection ran twice: once for the dry run the owner read, and again for
// `--write`, which is what actually created the campaign. Every predicate in between is
// live — gate_queue status, the keyword's text and active flag, inferred_origin, a
// conversation completing — so the reviewed list and the written list could differ with
// nothing detecting it. Exclusions survived only as counts in an in-memory report, so
// "why was this cohort this size?" had no answer in the record at all.
describeWithLocalDatabase("selection records the decision it made", () => {
  async function injectFailureAt(
    stage: "exclusion" | "candidate" | "source",
  ): Promise<void> {
    if (stage === "exclusion") {
      await prisma.$executeRaw`
        CREATE TRIGGER "p1_snapshot_contract_failure"
        BEFORE INSERT ON "recovery_selection_exclusion"
        FOR EACH ROW EXECUTE FUNCTION "raise_p1_snapshot_contract_failure"()
      `;
    } else if (stage === "candidate") {
      await prisma.$executeRaw`
        CREATE TRIGGER "p1_snapshot_contract_failure"
        BEFORE INSERT ON "recovery_candidate"
        FOR EACH ROW EXECUTE FUNCTION "raise_p1_snapshot_contract_failure"()
      `;
    } else {
      await prisma.$executeRaw`
        CREATE TRIGGER "p1_snapshot_contract_failure"
        BEFORE INSERT ON "recovery_candidate_source"
        FOR EACH ROW EXECUTE FUNCTION "raise_p1_snapshot_contract_failure"()
      `;
    }
  }

  async function removeFailureAt(stage: "exclusion" | "candidate" | "source"): Promise<void> {
    if (stage === "exclusion") {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_selection_exclusion"`;
    } else if (stage === "candidate") {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_candidate"`;
    } else {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "p1_snapshot_contract_failure" ON "recovery_candidate_source"`;
    }
  }

  /** Persist a selection and hand back the campaign row it wrote. */
  async function selectAndPersist(version?: string) {
    const report = await selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot",
      selectionVersion: version ?? `sel-test-${randomUUID()}`,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      persist: true,
      now: NOW,
    });
    const campaign = await prisma.recoveryCampaign.findUniqueOrThrow({
      where: { id: report.campaignId! },
    });
    return { report, campaign };
  }

  // The audit the review depends on: an aggregate count cannot tell you WHICH person was
  // dropped, so a wrong predicate is invisible until someone notices the cohort is small.
  it("records every excluded intent with its reason", async () => {
    const eligible = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    // A second journey that is excluded for a reason we can name: its keyword is off.
    const excluded = await seedEligible({
      triggers: [{ at: COMMENT_AT }],
      keywordId: fx.otherKeywordId,
    });
    await prisma.keyword.update({ where: { id: fx.otherKeywordId }, data: { active: false } });

    const { campaign } = await selectAndPersist();

    const rows = await prisma.recoverySelectionExclusion.findMany({
      where: { campaignId: campaign.id },
    });
    expect(rows.map((r) => r.intentId)).toContain(excluded.intentId);
    expect(rows.map((r) => r.intentId)).not.toContain(eligible.intentId);
    expect(rows.find((r) => r.intentId === excluded.intentId)!.reason).toBeTruthy();
  });

  // Reproducibility, stated as something the record can prove rather than something we
  // assert in a comment.
  it("hashes the same configuration and decision set identically across dry runs", async () => {
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const selectionVersion = `sel-test-stable-${randomUUID()}`;
    const run = () => selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot" as const,
      selectionVersion,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      persist: false,
      now: NOW,
    });

    const first = await run();
    const second = await run();

    expect(first.decisionHash).toBeTruthy();
    expect(second.decisionHash).toBe(first.decisionHash);
    expect(second.selectionFingerprint).toBe(first.selectionFingerprint);
  });

  it("persists the complete approved source order and normalized identity", async () => {
    const { commentIds } = await seedEligible({
      triggers: [
        { at: COMMENT_AT },
        { at: new Date(COMMENT_AT.getTime() + 3600_000) },
      ],
    });

    const { campaign } = await selectAndPersist();
    const candidate = await prisma.recoveryCandidate.findFirstOrThrow({
      where: { campaignId: campaign.id },
      include: { sources: { orderBy: { position: "asc" } } },
    });

    expect(campaign.selectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(campaign.eligibilityPolicyVersion).toBeTruthy();
    expect(candidate.sourceChoiceReason).toBe("newest_eligible_comment");
    expect(candidate.sources.map((source) => source.commentId)).toEqual([
      commentIds[1],
      commentIds[0],
    ]);
  });

  it("keeps every approved fallback inside the reviewed comment-age window", async () => {
    const old = new Date(NOW.getTime() - 90 * 24 * 3600_000);
    const recent = new Date(NOW.getTime() - 10 * 24 * 3600_000);
    const { commentIds } = await seedEligible({ triggers: [{ at: old }, { at: recent }] });

    const report = await selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot",
      selectionVersion: `sel-test-bounded-sources-${randomUUID()}`,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      commentFrom: new Date(NOW.getTime() - 30 * 24 * 3600_000),
      commentTo: new Date(NOW.getTime() - 7 * 24 * 3600_000),
      persist: true,
      now: NOW,
    });
    const sources = await prisma.recoveryCandidateSource.findMany({
      where: { candidate: { campaignId: report.campaignId! } },
      orderBy: { position: "asc" },
      select: { commentId: true },
    });

    expect(sources).toEqual([{ commentId: commentIds[1] }]);
    expect(sources).not.toContainEqual({ commentId: commentIds[0] });
  });

  it("fingerprints distinct staged selection limits independently", async () => {
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const selectionVersion = `sel-test-limit-${randomUUID()}`;
    const run = (limit: number) => selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot" as const,
      selectionVersion,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      limit,
      persist: false,
      now: NOW,
    });

    const [one, two] = await Promise.all([run(1), run(2)]);
    expect(one.selectionFingerprint).not.toBe(two.selectionFingerprint);
    expect(one.decisionHash).not.toBe(two.decisionHash);
  });

  it("rejects a duplicate normalized selection identity", async () => {
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const version = `sel-test-duplicate-${randomUUID()}`;
    await selectAndPersist(version);

    await expect(selectAndPersist(version)).rejects.toMatchObject({ code: "P2002" });
  });

  it("writes no campaign when the realized arm split is unusable", async () => {
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    const version = `sel-test-invalid-arm-${randomUUID()}`;

    await expect(
      selector.selectHistoricalCandidates({
        phase: "unknown_read_pilot",
        selectionVersion: version,
        copyVersion: "recovery-v2",
        westernOnly: true,
        holdoutPercent: 100,
        persist: true,
        now: NOW,
      }),
    ).rejects.toThrow("unusable arm split");
    await expect(
      prisma.recoveryCampaign.count({ where: { selectionVersion: version } }),
    ).resolves.toBe(0);
  });

  for (const stage of ["exclusion", "candidate", "source"] as const) {
    it(`rolls back the complete snapshot when the ${stage} write fails`, async () => {
      const eligible = await seedEligible({ triggers: [{ at: COMMENT_AT }] });
      if (stage === "exclusion") {
        await seedEligible({
          triggers: [{ at: COMMENT_AT }],
          keywordId: fx.otherKeywordId,
        });
        await prisma.keyword.update({
          where: { id: fx.otherKeywordId },
          data: { active: false },
        });
      }
      const version = `sel-test-rollback-${stage}-${randomUUID()}`;
      await injectFailureAt(stage);
      try {
        await expect(
          selector.selectHistoricalCandidates({
            phase: "unknown_read_pilot",
            selectionVersion: version,
            copyVersion: "recovery-v2",
            westernOnly: true,
            holdoutPercent: 0,
            persist: true,
            now: NOW,
          }),
        ).rejects.toThrow();
      } finally {
        await removeFailureAt(stage);
      }

      expect(await prisma.recoveryCampaign.count({ where: { selectionVersion: version } })).toBe(0);
      expect(
        await prisma.recoveryCandidate.count({ where: { intentId: eligible.intentId } }),
      ).toBe(0);
    });
  }

  // The other half: drift must be VISIBLE. A gate flipping to exhausted between the dry
  // run and the write is exactly the case QA-14 describes, and the hash is what turns it
  // from a silent difference into a reviewable one.
  it("reports a different hash once a live predicate moves", async () => {
    // Two journeys, so deactivating one keyword changes the DECISION SET without
    // emptying the campaign — otherwise validateArmSplit rightly refuses a treatment arm
    // of zero (QA-07) and we would be testing that guard instead of the hash.
    await seedEligible({ triggers: [{ at: COMMENT_AT }] });
    await seedEligible({ triggers: [{ at: COMMENT_AT }], keywordId: fx.otherKeywordId });
    const selectionVersion = `sel-test-drift-${randomUUID()}`;
    const run = () => selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot" as const,
      selectionVersion,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      persist: false,
      now: NOW,
    });
    const before = await run();

    // The keyword goes inactive after the first selection — a live predicate, not
    // something the cutoff can bound, because keywords keep no history.
    await prisma.keyword.update({ where: { id: fx.otherKeywordId }, data: { active: false } });
    const after = await run();
    await prisma.keyword.update({ where: { id: fx.otherKeywordId }, data: { active: true } });

    expect(after.decisionHash).not.toBe(before.decisionHash);
    // And the decision itself changed, which is what the hash is reporting.
    expect(before.eligible).toBe(2);
    expect(after.eligible).toBe(1);
  });

  // "Nobody qualified" and "this cohort has candidates but no treatment arm" are
  // different problems. The second is a broken experiment and must refuse (QA-07). The
  // first is an ordinary answer, and it is the moment the operator most needs the
  // exclusion breakdown — throwing a stack trace there hides the only useful output.
  it("reports why the cohort is empty rather than throwing", async () => {
    await seedEligible({ triggers: [{ at: COMMENT_AT }], keywordId: fx.otherKeywordId });
    await prisma.keyword.update({ where: { id: fx.otherKeywordId }, data: { active: false } });

    const report = await selector.selectHistoricalCandidates({
      phase: "unknown_read_pilot",
      selectionVersion: `sel-test-${randomUUID()}`,
      copyVersion: "recovery-v2",
      westernOnly: true,
      holdoutPercent: 0,
      persist: true,
      now: NOW,
    });

    expect(report.eligible).toBe(0);
    // Nothing to approve, so nothing was created — but the reasons still came back.
    expect(report.campaignId).toBeNull();
    expect(Object.keys(report.excludedByReason).length).toBeGreaterThan(0);
  });
});
