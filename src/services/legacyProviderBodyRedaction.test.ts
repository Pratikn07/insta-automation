import { describe, expect, it, vi } from "vitest";
import {
  COUNT_LEGACY_PROVIDER_BODIES_SQL,
  LEGACY_PROVIDER_BODY_KINDS,
  REDACT_LEGACY_PROVIDER_BODIES_SQL,
  formatLegacyProviderBodySummary,
  redactLegacyProviderBodies,
  type LegacyProviderBodyPrisma,
} from "./legacyProviderBodyRedaction.js";

function prismaStub(count: number | bigint, updated = 0): LegacyProviderBodyPrisma & {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
} {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ n: count }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(updated),
  } as never;
}

describe("redactLegacyProviderBodies", () => {
  it("counts without writing by default", async () => {
    const prisma = prismaStub(1364);

    const summary = await redactLegacyProviderBodies(prisma);

    expect(summary).toEqual({ matched: 1364, redacted: 0 });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("writes only when explicitly asked", async () => {
    const prisma = prismaStub(1364, 1364);

    const summary = await redactLegacyProviderBodies(prisma, { write: true });

    expect(summary).toEqual({ matched: 1364, redacted: 1364 });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(REDACT_LEGACY_PROVIDER_BODIES_SQL);
  });

  // count() can arrive as a bigint through some driver paths; a bigint would
  // throw on JSON.stringify when the CLI prints the summary.
  it("normalizes a bigint count to a number", async () => {
    const prisma = prismaStub(7n);

    const summary = await redactLegacyProviderBodies(prisma);

    expect(summary.matched).toBe(7);
    expect(() => formatLegacyProviderBodySummary(summary)).not.toThrow();
  });

  it("reports zero rather than throwing when the count comes back empty", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    } as never as LegacyProviderBodyPrisma;

    await expect(redactLegacyProviderBodies(prisma)).resolves.toEqual({
      matched: 0,
      redacted: 0,
    });
  });
});

describe("the statements themselves", () => {
  it("removes only requestBody, never Meta's error description", () => {
    expect(REDACT_LEGACY_PROVIDER_BODIES_SQL).toContain("payload - 'requestBody'");
    expect(REDACT_LEGACY_PROVIDER_BODIES_SQL).not.toContain("'message'");
    expect(REDACT_LEGACY_PROVIDER_BODIES_SQL).not.toContain("'endpoint'");
  });

  // A redacted row no longer has the key, so it can never match again.
  it("is idempotent by predicate", () => {
    for (const sql of [COUNT_LEGACY_PROVIDER_BODIES_SQL, REDACT_LEGACY_PROVIDER_BODIES_SQL]) {
      expect(sql).toContain("jsonb_exists(payload, 'requestBody')");
    }
  });

  // `?` is the driver's parameter placeholder and collides in a raw statement.
  it("avoids the bare ? jsonb operator", () => {
    expect(REDACT_LEGACY_PROVIDER_BODIES_SQL).not.toMatch(/payload\s*\?/);
  });

  it("scopes to the three affected kinds and nothing else", () => {
    for (const kind of LEGACY_PROVIDER_BODY_KINDS) {
      expect(COUNT_LEGACY_PROVIDER_BODIES_SQL).toContain(`'${kind}'`);
    }
    expect(COUNT_LEGACY_PROVIDER_BODIES_SQL).toContain("kind IN (");
  });
});
