import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { CURRENT_ORIGIN_METHOD } from "./historicalAudienceSegment.js";
import type { OriginVerdict } from "./originClassifier.js";
import type { Origin } from "./originInference.js";

/**
 * One reader and one writer for `ig_users.inferred_origin`, shared by the
 * enrichment worker, the DM-recovery gate, and the guide audience gate. Before
 * this module the worker owned the write and the recovery repository owned the
 * read, so a third caller could only agree with them by copying both.
 */

export type StoredOriginRow = {
  username: string | null;
  name: string | null;
  inferredOrigin: string | null;
  originConfidence: string | null;
  originMethod: string | null;
};

export type StoredOriginVerdict = { origin: Origin; confidence: "high" | "low" };

/** Identity snapshot a write is allowed to land against. */
export type OriginIdentity = { id: string; username: string | null; name: string | null };

const ORIGINS = new Set(["us_western", "south_asian", "other", "unknown"]);

export function isOrigin(value: string | null | undefined): value is Origin {
  return typeof value === "string" && ORIGINS.has(value);
}

/**
 * The stored verdict, or null when there is none written by the CURRENT prompt
 * version. Null is deliberately not a value: the same columns are written by a
 * one-time backfill (origin_method "name") and by any future prompt, so pinning
 * the version means a prompt change re-earns trust through the worker. Callers
 * decide what a miss means — recovery falls back to the name screen, the guide
 * gate calls Gemini.
 */
export function readStoredOrigin(person: StoredOriginRow | null): StoredOriginVerdict | null {
  if (!person || person.originMethod !== CURRENT_ORIGIN_METHOD) return null;
  if (!isOrigin(person.inferredOrigin)) return null;
  return {
    origin: person.inferredOrigin,
    // Anything not exactly "high" reads as low: "high" is the value that
    // withholds a public reminder, so a malformed column must not grant it.
    confidence: person.originConfidence === "high" ? "high" : "low",
  };
}

export const ORIGIN_STILL_DUE = {
  OR: [
    { originCheckedAt: null },
    { originMethod: null },
    { originMethod: { not: CURRENT_ORIGIN_METHOD } },
  ],
} satisfies Prisma.IgUserWhereInput;

/**
 * Every field `readStoredOrigin` inspects, written together. Omitting
 * originMethod here would leave the row a permanent cache miss and re-bill it
 * on every interaction.
 */
export function originVerdictWriteData(
  verdict: OriginVerdict,
  now: Date,
): Prisma.IgUserUpdateManyMutationInput {
  return {
    inferredOrigin: verdict.origin,
    originConfidence: verdict.confidence,
    originMethod: CURRENT_ORIGIN_METHOD,
    originEvidence: verdict.evidence,
    audienceSegment: verdict.audienceSegment,
    originCheckedAt: now,
  };
}

/**
 * Persist classifier output only for the exact identity snapshot that was sent to
 * Gemini and only while it still needs this method revision. A profile update clears
 * origin fields; matching name and username prevents a delayed old response from
 * immediately restoring a verdict for the prior identity.
 */
export async function compareAndSetOrigin(
  writes: Array<{ candidate: OriginIdentity; data: Prisma.IgUserUpdateManyMutationInput }>,
): Promise<number> {
  if (writes.length === 0) return 0;
  const results = await prisma.$transaction(
    writes.map(({ candidate, data }) => prisma.igUser.updateMany({
      where: {
        id: candidate.id,
        username: candidate.username,
        name: candidate.name,
        ...ORIGIN_STILL_DUE,
      },
      data,
    })),
  );
  return results.reduce((count, write) => count + write.count, 0);
}
