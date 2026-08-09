import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let runner: typeof import("./journeyReconciliationRunner.js");
let resourceId: string;
let keywordId: string;
let prefix: string;

const BASE = new Date("2026-06-10T10:00:00Z");
const CUTOFF = new Date("2026-06-20T00:00:00Z");

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  runner = await import("./journeyReconciliationRunner.js");
  resourceId = randomUUID();
  keywordId = randomUUID();
  await prisma.resource.create({ data: { id: resourceId, name: "reconciliation manifest" } });
  await prisma.keyword.create({
    data: {
      id: keywordId,
      keyword: `MANIFEST-${keywordId}`,
      resourceId,
      publicReply: "x",
      gateMessage: "y",
    },
  });
});

async function wipe(): Promise<void> {
  await prisma.journeyReconciliationRun.deleteMany({});
  await prisma.journeyTrigger.deleteMany({
    where: { intent: { igUserId: { startsWith: "manifest-contract-" } } },
  });
  await prisma.journeyIntent.deleteMany({
    where: { igUserId: { startsWith: "manifest-contract-" } },
  });
  await prisma.conversation.deleteMany({
    where: { igUserId: { startsWith: "manifest-contract-" } },
  });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: "manifest-contract-" } } });
}

beforeEach(async () => {
  if (!prisma) return;
  await wipe();
  prefix = `manifest-contract-${randomUUID()}`;
});

afterAll(async () => {
  if (!prisma) return;
  await wipe();
  await prisma.keyword.delete({ where: { id: keywordId } });
  await prisma.resource.delete({ where: { id: resourceId } });
  await prisma.$disconnect();
});

async function seedWindow(personSuffix: string, offsetHours: number): Promise<string[]> {
  const person = `${prefix}-${personSuffix}`;
  await prisma.igUser.create({ data: { id: person } });
  const firstAt = new Date(BASE.getTime() + offsetHours * 3600_000);
  const secondAt = new Date(firstAt.getTime() + 3600_000);
  const first = await prisma.conversation.create({
    data: { igUserId: person, keywordId, state: "awaiting_done", createdAt: firstAt },
  });
  const second = await prisma.conversation.create({
    data: { igUserId: person, keywordId, state: "awaiting_done", createdAt: secondAt },
  });
  await prisma.eventLog.create({
    data: {
      kind: "dm_sent",
      payload: { conversationId: second.id },
      createdAt: secondAt,
    },
  });
  return [first.id, second.id];
}

describeWithLocalDatabase("durable journey reconciliation manifests", () => {
  it("requires an approved dry run and refuses changed frozen input", async () => {
    const [, second] = await seedWindow("one", 0);
    await expect(
      runner.runJourneyReconciliation({ write: true, testIgUserPrefix: prefix }),
    ).rejects.toThrow("approved_dry_run_required");

    const dry = await runner.runJourneyReconciliation({
      write: false,
      sourceCutoff: CUTOFF,
      testIgUserPrefix: prefix,
    });
    expect(dry.results).toEqual({ planned: 1 });

    await prisma.conversation.update({
      where: { id: second },
      data: { createdAt: new Date(BASE.getTime() + 2 * 3600_000) },
    });

    let failedRunId: string | null = null;
    try {
      await runner.runJourneyReconciliation({
        write: true,
        approvedManifestRunId: dry.runId,
        testIgUserPrefix: prefix,
      });
      throw new Error("expected manifest conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(runner.JourneyReconciliationRunError);
      expect((error as InstanceType<typeof runner.JourneyReconciliationRunError>).message)
        .toBe("manifest_input_changed");
      failedRunId = (error as InstanceType<typeof runner.JourneyReconciliationRunError>).runId;
    }

    const failed = await prisma.journeyReconciliationRun.findUniqueOrThrow({
      where: { id: failedRunId! },
      include: { windows: true },
    });
    expect(failed).toMatchObject({ status: "failed", lastError: "manifest_input_changed" });
    expect(failed.windows).toHaveLength(1);
    expect(failed.windows[0]).toMatchObject({
      result: "manifest_conflict",
      conflictReason: "manifest_input_changed",
    });
    expect(await prisma.journeyIntent.count({ where: { igUserId: { startsWith: prefix } } }))
      .toBe(0);
  });

  it("resumes a crashed dry run from its committed checkpoint deterministically", async () => {
    await seedWindow("one", 0);
    await seedWindow("two", 72);

    let crashedRunId: string | null = null;
    try {
      await runner.runJourneyReconciliation({
        write: false,
        sourceCutoff: CUTOFF,
        testIgUserPrefix: prefix,
        hooks: {
          beforePosition: async (position) => {
            if (position === 1) throw new Error("simulated_crash");
          },
        },
      });
    } catch (error) {
      crashedRunId = (error as InstanceType<typeof runner.JourneyReconciliationRunError>).runId;
    }

    const crashed = await prisma.journeyReconciliationRun.findUniqueOrThrow({
      where: { id: crashedRunId! },
      include: { windows: true },
    });
    expect(crashed).toMatchObject({ status: "failed", resumePosition: 1 });
    expect(crashed.windows).toHaveLength(1);

    const resumed = await runner.runJourneyReconciliation({
      write: false,
      resumeRunId: crashed.id,
      testIgUserPrefix: prefix,
    });
    expect(resumed).toMatchObject({ runId: crashed.id, status: "completed", windows: 2 });

    const uninterrupted = await runner.runJourneyReconciliation({
      write: false,
      sourceCutoff: CUTOFF,
      testIgUserPrefix: prefix,
    });
    const manifests = await Promise.all(
      [resumed.runId, uninterrupted.runId].map((runId) =>
        prisma.journeyReconciliationWindow.findMany({
          where: { runId },
          orderBy: { position: "asc" },
          select: {
            position: true,
            windowKey: true,
            inputFingerprint: true,
            proposedCanonicalId: true,
            evidenceChoice: true,
            result: true,
            conflictReason: true,
          },
        }),
      ),
    );
    expect(manifests[0]).toEqual(manifests[1]);
  });

  it("commits each write, result, and checkpoint together across crash and resume", async () => {
    await seedWindow("one", 0);
    await seedWindow("two", 72);
    const dry = await runner.runJourneyReconciliation({
      write: false,
      sourceCutoff: CUTOFF,
      testIgUserPrefix: prefix,
    });

    let writeRunId: string | null = null;
    try {
      await runner.runJourneyReconciliation({
        write: true,
        approvedManifestRunId: dry.runId,
        testIgUserPrefix: prefix,
        hooks: {
          beforePosition: async (position) => {
            if (position === 1) throw new Error("simulated_crash");
          },
        },
      });
    } catch (error) {
      writeRunId = (error as InstanceType<typeof runner.JourneyReconciliationRunError>).runId;
    }

    const partial = await prisma.journeyReconciliationRun.findUniqueOrThrow({
      where: { id: writeRunId! },
      include: { windows: true },
    });
    expect(partial).toMatchObject({ status: "failed", resumePosition: 1 });
    expect(partial.windows).toHaveLength(1);
    expect(partial.windows[0]!.result).toBe("written");
    expect(await prisma.journeyIntent.count({ where: { igUserId: { startsWith: prefix } } }))
      .toBe(1);

    const completed = await runner.runJourneyReconciliation({
      write: true,
      resumeRunId: partial.id,
      testIgUserPrefix: prefix,
    });
    expect(completed).toMatchObject({ status: "completed", windows: 2, results: { written: 2 } });
    expect(await prisma.journeyIntent.count({ where: { igUserId: { startsWith: prefix } } }))
      .toBe(2);
  });
});
