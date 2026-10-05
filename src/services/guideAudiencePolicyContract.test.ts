import { randomUUID } from "node:crypto";
import { PrismaClient, type GuideAudienceActionSource } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGuideAudienceAuthorizationService } from "./guideAudienceAuthorization.js";
import { createGuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";
import { classifyOrigins } from "./originClassifier.js";
import { compareAndSetOrigin, originVerdictWriteData } from "./originVerdictStore.js";

// The gate's whole job is a column read and an audit row. Both were mocked in
// every earlier test, so nothing proved the enum values the service passes are
// the enum values Postgres accepts, or that `classification_id` stays null now
// that the classification table is going away.
//
// `compareAndSetOrigin` writes through the module-level Prisma singleton, so the
// guard below asserting DATABASE_URL === MIGRATION_TEST_DATABASE_URL is what
// makes the real writer safe to call here.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;

type DecisionRow = {
  kind: string;
  source: string;
  origin: string | null;
  confidence: string | null;
  defer_reason: string | null;
  provider: string;
  model_id: string;
  method: string;
  classification_id: string | null;
  identity_hash: string;
  comment_id: string | null;
};

beforeAll(() => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (db) await db.$disconnect();
});

/** A person the gate can screen, with an identity worth classifying. */
async function seedPerson(overrides: {
  inferredOrigin?: string;
  originConfidence?: string;
  originMethod?: string;
  originCheckedAt?: Date;
} = {}): Promise<{ id: string; username: string; name: string }> {
  const id = `audience-gate-${randomUUID()}`;
  const username = `priya_${randomUUID().slice(0, 8)}`;
  const name = "Priya Sharma";
  await db.igUser.create({ data: { id, username, name, ...overrides } });
  return { id, username, name };
}

function verdict(origin: string, confidence: string) {
  return {
    verdicts: [
      {
        id: "replaced-per-call",
        origin,
        confidence,
        cueKind: "distinctive_cultural",
        audienceSegment: origin === "south_asian" ? "south_asian" : "western",
        evidence: `${origin} given name`,
      },
    ],
    costUsd: 0.00015,
    modelId: "gemini-2.5-flash",
    promptVersion: "llm_v3",
    finishReason: "STOP",
  };
}

function gate(classify: typeof classifyOrigins) {
  return createGuideAudienceAuthorizationService({
    repository: createGuideAudienceAuthorizationRepository(db),
    classify,
    persistVerdict: compareAndSetOrigin,
    isEnabled: () => true,
    classifierEnabled: true,
    timeoutMs: 3_000,
  });
}

async function decisionsFor(igUserId: string): Promise<DecisionRow[]> {
  return db.$queryRaw<DecisionRow[]>`
    SELECT kind::text, source::text, origin::text, confidence::text,
           defer_reason::text, provider, model_id, method,
           classification_id::text, identity_hash, comment_id
    FROM guide_audience_decision
    WHERE ig_user_id = ${igUserId}
  `;
}

describeWithLocalDatabase("guide audience policy contract", () => {
  it("writes exactly one block row for a stored south_asian verdict", async () => {
    const person = await seedPerson({
      inferredOrigin: "south_asian",
      originConfidence: "low",
      originMethod: "llm_v3",
      originCheckedAt: new Date(),
    });
    const classify = vi.fn();
    const commentId = `c-${randomUUID()}`;

    const decision = await gate(classify as never).authorizeNewGuideAction({
      igUserId: person.id,
      source: "comment",
      commentId,
    });

    expect(decision.kind).toBe("block");
    // A stored verdict must not be re-billed.
    expect(classify).not.toHaveBeenCalled();

    const rows = await decisionsFor(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "block",
      source: "comment",
      origin: "south_asian",
      confidence: "low",
      defer_reason: null,
      provider: "gemini",
      method: "llm_v3",
      // The classification table is being dropped in M2. A row that still
      // pointed at it would block that migration.
      classification_id: null,
      comment_id: commentId,
    });
    expect(rows[0]?.identity_hash).toHaveLength(64);
    // The audit row anchors to a hash, never the profile text itself.
    expect(JSON.stringify(rows[0])).not.toContain(person.name);
    expect(JSON.stringify(rows[0])).not.toContain(person.username);
  });

  it.each([
    "comment",
    "dm",
    "quick_reply",
    "postback",
    "redelivery",
  ] satisfies GuideAudienceActionSource[])("blocks a %s entry and stores that source", async (source) => {
    const person = await seedPerson({
      inferredOrigin: "south_asian",
      originConfidence: "high",
      originMethod: "llm_v3",
      originCheckedAt: new Date(),
    });

    const decision = await gate(vi.fn() as never).authorizeNewGuideAction({
      igUserId: person.id,
      source,
    });

    expect(decision.kind).toBe("block");
    const rows = await decisionsFor(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "block", source, confidence: "high" });
  });

  it("allows and audits allow_unverified when the classifier throws", async () => {
    const person = await seedPerson();
    const classify = vi.fn().mockRejectedValue(new Error("gemini down"));

    const decision = await gate(classify as never).authorizeNewGuideAction({
      igUserId: person.id,
      source: "dm",
    });

    // Better to reach a western reader than to drop them over a broken provider.
    expect(decision).toEqual({ kind: "allow" });

    const rows = await decisionsFor(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "allow_unverified",
      source: "dm",
      defer_reason: "provider_unavailable",
      origin: null,
      confidence: null,
      provider: "gemini",
      classification_id: null,
    });
  });

  it("stores a live verdict so the next action reads it instead of re-billing", async () => {
    const person = await seedPerson();
    const classify = vi.fn(async (candidates: Array<{ id: string }>) => {
      const result = verdict("south_asian", "high");
      result.verdicts[0]!.id = candidates[0]!.id;
      return result;
    });

    expect(
      (await gate(classify as never).authorizeNewGuideAction({
        igUserId: person.id,
        source: "comment",
        commentId: `c-${randomUUID()}`,
      })).kind,
    ).toBe("block");

    expect(await db.igUser.findUniqueOrThrow({
      where: { id: person.id },
      select: { inferredOrigin: true, originConfidence: true, originMethod: true },
    })).toEqual({
      inferredOrigin: "south_asian",
      originConfidence: "high",
      originMethod: "llm_v3",
    });

    // Second action, same person: the column now answers, so no second call.
    const second = vi.fn();
    expect(
      (await gate(second as never).authorizeNewGuideAction({
        igUserId: person.id,
        source: "dm",
      })).kind,
    ).toBe("block");
    expect(second).not.toHaveBeenCalled();
  });

  it("does not stamp a renamed person with the previous identity's verdict", async () => {
    const person = await seedPerson();
    const repository = createGuideAudienceAuthorizationRepository(db);
    const subject = await repository.findAudienceSubject(person.id);

    // The rename lands while the classifier is still thinking.
    await db.igUser.update({
      where: { id: person.id },
      data: { username: `renamed_${randomUUID().slice(0, 8)}` },
    });

    const written = await compareAndSetOrigin([
      {
        candidate: { id: subject!.id, username: subject!.username, name: subject!.name },
        data: originVerdictWriteData(
          {
            id: person.id,
            origin: "south_asian",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "south_asian",
            evidence: "south asian given name",
          } as never,
          new Date(),
        ),
      },
    ]);

    expect(written).toBe(0);
    expect(await db.igUser.findUniqueOrThrow({
      where: { id: person.id },
      select: { inferredOrigin: true, originMethod: true },
    })).toEqual({ inferredOrigin: null, originMethod: null });
  });
});
