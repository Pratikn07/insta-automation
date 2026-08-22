/**
 * One-off cleanup for event payloads written before the logger moved to
 * `describeGraphError` (see eventLogger.ts).
 *
 * Those older rows spread the raw Graph failure straight into the event,
 * including `requestBody` — the outbound request we sent Meta. The current
 * logger emits sanitized identifiers only, and dmRecoveryWorker states the rule
 * plainly: safe identifiers only, never a provider body. The code stopped
 * writing these; the rows already written were never cleaned up.
 */

/** Kinds observed carrying a legacy `requestBody`. */
export const LEGACY_PROVIDER_BODY_KINDS = [
  "dm_failed",
  "sequence_failed",
  "public_reply_failed",
] as const;

/**
 * Only the outbound body is removed. Meta's own `message` is deliberately kept:
 * it is the provider's error description ("The comment is invalid for a private
 * reply"), and on these legacy rows it is the only human-readable record of why
 * a delivery failed. Dropping it would cost diagnosis and protect nothing —
 * it describes the failure, it does not carry what we sent.
 */
export const LEGACY_PROVIDER_BODY_KEY = "requestBody";

export type LegacyProviderBodyPrisma = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
};

export type LegacyProviderBodySummary = {
  /** Rows still carrying the key at the time of the scan. */
  matched: number;
  /** Rows actually rewritten. Always 0 on a dry run. */
  redacted: number;
};

// Both the kind list and the key are module constants — never caller input — so
// the statement interpolates nothing that originates outside this file.
//
// `jsonb_exists(payload, ...)` rather than the `?` operator: `?` is also the
// driver's parameter placeholder, and the two collide in a raw statement.
const MATCH_PREDICATE =
  `kind IN (${LEGACY_PROVIDER_BODY_KINDS.map((kind) => `'${kind}'`).join(", ")}) ` +
  `AND jsonb_exists(payload, '${LEGACY_PROVIDER_BODY_KEY}')`;

export const COUNT_LEGACY_PROVIDER_BODIES_SQL = `SELECT count(*)::int AS n FROM event_log WHERE ${MATCH_PREDICATE}`;

export const REDACT_LEGACY_PROVIDER_BODIES_SQL = `UPDATE event_log SET payload = payload - '${LEGACY_PROVIDER_BODY_KEY}' WHERE ${MATCH_PREDICATE}`;

/**
 * Counts affected rows, and rewrites them only when `write` is set. Re-running
 * after a write is a no-op: the predicate requires the key to still be present,
 * so a redacted row can never be matched twice.
 */
export async function redactLegacyProviderBodies(
  prisma: LegacyProviderBodyPrisma,
  options: { write?: boolean } = {},
): Promise<LegacyProviderBodySummary> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
    COUNT_LEGACY_PROVIDER_BODIES_SQL,
  );
  // Postgres count() arrives as a bigint through some driver paths even with
  // the ::int cast, and a bigint would poison the JSON summary.
  const matched = Number(rows?.[0]?.n ?? 0);

  if (!options.write) {
    return { matched, redacted: 0 };
  }

  const redacted = await prisma.$executeRawUnsafe(REDACT_LEGACY_PROVIDER_BODIES_SQL);
  return { matched, redacted: Number(redacted) };
}

export function formatLegacyProviderBodySummary(summary: LegacyProviderBodySummary): string {
  return JSON.stringify(summary);
}
