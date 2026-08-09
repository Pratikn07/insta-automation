import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let resourceId: string;
let keywordId: string;
let igUserId: string;
let conversationId: string;
let retireSettingsBlockedVerification: typeof import("./settingsBlockedVerificationAdminService.js").retireSettingsBlockedVerification;
let lockAndValidateSettingsBlockedVerificationEvidence: typeof import("./settingsBlockedVerificationService.js").lockAndValidateSettingsBlockedVerificationEvidence;

async function createVerification(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID();
  return prisma.settingsBlockedVerification.create({
    data: {
      version: `settings-proof-${suffix}`,
      graphCode: 10,
      graphSubcode: 12345,
      semanticCategory: "settings_blocked",
      verifiedAt: new Date("2026-08-08T10:00:00Z"),
      validUntil: new Date("2026-09-08T10:00:00Z"),
      verifierIdentity: "qa-owner",
      controlledAccountContext: "controlled-meta-sandbox-account",
      apiVersion: "v23.0",
      evidenceReference: `meta-sandbox/${suffix}`,
      evidenceSha256: "a".repeat(64),
      active: true,
      ...overrides,
    },
  });
}

function settingsReminderData(
  verification: Awaited<ReturnType<typeof createVerification>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId,
    igUserId,
    keywordId,
    keywordSnapshot: "SLEEP",
    templateVersion: "v1",
    publicReplyText: "safe settings fallback",
    commentId: `settings-proof-comment-${randomUUID()}`,
    triggerKind: "settings_blocked" as const,
    status: "waiting" as const,
    cohort: "not_applicable" as const,
    eligibleAt: new Date("2026-08-08T12:00:00Z"),
    settingsEvidenceLegacy: false,
    settingsVerificationId: verification.id,
    settingsVerificationVersion: verification.version,
    settingsGraphCode: verification.graphCode,
    settingsGraphSubcode: verification.graphSubcode,
    settingsClassifiedAt: new Date("2026-08-08T12:00:00Z"),
    settingsEvidenceReference: verification.evidenceReference,
    settingsEvidenceSha256: verification.evidenceSha256,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  ({ retireSettingsBlockedVerification } = await import(
    "./settingsBlockedVerificationAdminService.js"
  ));
  ({ lockAndValidateSettingsBlockedVerificationEvidence } = await import(
    "./settingsBlockedVerificationService.js"
  ));
  resourceId = randomUUID();
  keywordId = randomUUID();
  igUserId = `settings-proof-user-${randomUUID()}`;
  conversationId = randomUUID();

  await prisma.resource.create({ data: { id: resourceId, name: "QA-17 contract" } });
  await prisma.keyword.create({
    data: {
      id: keywordId,
      keyword: `qa17-${keywordId}`,
      resourceId,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await prisma.igUser.create({ data: { id: igUserId } });
  await prisma.conversation.create({ data: { id: conversationId, igUserId, keywordId } });
});

afterEach(async () => {
  if (!prisma) return;
  await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId } });
  await prisma.settingsBlockedVerification.deleteMany({
    where: { evidenceReference: { startsWith: "meta-sandbox/" } },
  });
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.igUser.deleteMany({ where: { id: igUserId } });
  await prisma.keyword.deleteMany({ where: { id: keywordId } });
  await prisma.resource.deleteMany({ where: { id: resourceId } });
  await prisma.$disconnect();
});

describeWithLocalDatabase("QA-17 settings-blocked verification database contract", () => {
  it("enables RLS on the verification registry without permissive policies", async () => {
    const relations = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; policy_count: bigint }>
    >`
      SELECT c.relrowsecurity,
             (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'settings_blocked_verification'
    `;

    expect(relations).toEqual([{ relrowsecurity: true, policy_count: 0n }]);
  });

  it("requires complete evidence on every new settings-blocked reminder", async () => {
    await expect(
      prisma.dmRecoveryReminder.create({
        data: {
          conversationId,
          igUserId,
          keywordId,
          keywordSnapshot: "SLEEP",
          templateVersion: "v1",
          publicReplyText: "must not persist",
          commentId: `missing-proof-${randomUUID()}`,
          triggerKind: "settings_blocked",
          status: "waiting",
          cohort: "not_applicable",
          eligibleAt: new Date(),
        },
      }),
    ).rejects.toThrow(/dm_recovery_reminder_settings_evidence_shape_check/i);
  });

  it("never permits a newly inserted row to claim legacy evidence status", async () => {
    await expect(
      prisma.dmRecoveryReminder.create({
        data: {
          conversationId,
          igUserId,
          keywordId,
          keywordSnapshot: "SLEEP",
          templateVersion: "v1",
          publicReplyText: "must not persist",
          commentId: `false-legacy-${randomUUID()}`,
          triggerKind: "settings_blocked",
          status: "waiting",
          cohort: "not_applicable",
          eligibleAt: new Date(),
          settingsEvidenceLegacy: true,
        },
      }),
    ).rejects.toThrow(/new settings-blocked reminders require verified evidence/i);
  });

  it("accepts an exact complete snapshot and makes reminder evidence immutable", async () => {
    const verification = await createVerification();
    const reminder = await prisma.dmRecoveryReminder.create({
      data: settingsReminderData(verification),
    });

    expect(reminder.settingsVerificationVersion).toBe(verification.version);
    expect(reminder.settingsGraphCode).toBe(10);
    await expect(
      prisma.dmRecoveryReminder.update({
        where: { id: reminder.id },
        data: { settingsGraphSubcode: 99999 },
      }),
    ).rejects.toThrow(/reminder evidence is immutable/i);
  });

  it("rejects a snapshot whose version or signature does not match its registry id", async () => {
    const verification = await createVerification();

    await expect(
      prisma.dmRecoveryReminder.create({
        data: settingsReminderData(verification, {
          settingsGraphSubcode: verification.graphSubcode + 1,
        }),
      }),
    ).rejects.toThrow(/settings_verification_identity_fkey/i);
  });

  it("allows lifecycle retirement but never rewrites registry evidence", async () => {
    const verification = await createVerification();

    await expect(
      prisma.settingsBlockedVerification.update({
        where: { id: verification.id },
        data: { evidenceSha256: "b".repeat(64) },
      }),
    ).rejects.toThrow(/verification evidence is immutable/i);

    const retired = await prisma.settingsBlockedVerification.update({
      where: { id: verification.id },
      data: {
        active: false,
        retiredAt: new Date("2026-08-08T13:00:00Z"),
        retirementReason: "controlled verification expired",
      },
    });
    expect(retired.active).toBe(false);
    expect(retired.retirementReason).toBe("controlled verification expired");
  });

  it("permits only one active record for an exact Graph signature", async () => {
    await createVerification();

    await expect(createVerification()).rejects.toThrow();
    expect(
      await prisma.settingsBlockedVerification.count({
        where: { graphCode: 10, graphSubcode: 12345, active: true },
      }),
    ).toBe(1);
  });

  it("keeps no-confirmed-read evidence separate", async () => {
    const verification = await createVerification();

    await expect(
      prisma.dmRecoveryReminder.create({
        data: settingsReminderData(verification, {
          triggerKind: "no_confirmed_read",
          cohort: "treatment",
        }),
      }),
    ).rejects.toThrow(/dm_recovery_reminder_settings_evidence_shape_check/i);
  });

  it("serializes reminder creation with retirement on the registry row", async () => {
    const verification = await createVerification();
    const classifiedAt = new Date("2026-08-08T12:00:00Z");
    const evidence = {
      verificationId: verification.id,
      verificationVersion: verification.version,
      graphCode: verification.graphCode,
      graphSubcode: verification.graphSubcode,
      classifiedAt,
      verifiedAt: verification.verifiedAt,
      validUntil: verification.validUntil,
      evidenceReference: verification.evidenceReference,
      evidenceSha256: verification.evidenceSha256,
    };

    let announceLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const create = prisma.$transaction(async (tx) => {
      await lockAndValidateSettingsBlockedVerificationEvidence(tx, evidence, classifiedAt);
      announceLocked();
      await release;
      return tx.dmRecoveryReminder.create({ data: settingsReminderData(verification) });
    });
    await locked;

    const retirement = retireSettingsBlockedVerification(
      verification.id,
      "interleaving contract retirement",
      "qa-owner",
      new Date("2026-08-08T13:00:00Z"),
    );
    const beforeRelease = await Promise.race([
      retirement.then(() => "retired" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(beforeRelease).toBe("blocked");

    releaseLock();
    const [reminder] = await Promise.all([create, retirement]);
    expect(reminder.settingsVerificationId).toBe(verification.id);
    expect(
      await prisma.settingsBlockedVerification.findUnique({ where: { id: verification.id } }),
    ).toMatchObject({ active: false, retirementReason: expect.stringContaining("interleaving") });
  });

  it("rejects scheduling when retirement wins before the evidence lock", async () => {
    const verification = await createVerification();
    const now = new Date("2026-08-08T13:00:00Z");
    await retireSettingsBlockedVerification(
      verification.id,
      "retirement wins",
      "qa-owner",
      now,
    );

    await expect(
      prisma.$transaction((tx) =>
        lockAndValidateSettingsBlockedVerificationEvidence(
          tx,
          {
            verificationId: verification.id,
            verificationVersion: verification.version,
            graphCode: verification.graphCode,
            graphSubcode: verification.graphSubcode,
            classifiedAt: now,
            verifiedAt: verification.verifiedAt,
            validUntil: verification.validUntil,
            evidenceReference: verification.evidenceReference,
            evidenceSha256: verification.evidenceSha256,
          },
          now,
        ),
      ),
    ).rejects.toMatchObject({ reason: "verification_retired" });
  });
});
