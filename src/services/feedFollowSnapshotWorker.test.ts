import { describe, expect, it, vi } from "vitest";
import type { AccountMedia } from "../meta/fetchMedia.js";
import type { FeedFollowMetricResult } from "../meta/mediaFollowFetcher.js";

const {
  collectFeedFollowSnapshot,
  createFeedFollowSnapshotRunner,
  createPrismaFeedFollowRepository,
  toFeedFollowEvent,
} = await import("./feedFollowSnapshotWorker.js");

function post(id: string, timestamp: string | null): AccountMedia {
  return {
    id,
    kind: "carousel",
    mediaType: "CAROUSEL_ALBUM",
    mediaProductType: "FEED",
    caption: `${id} caption`,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    permalink: `https://instagram.com/p/${id}`,
    timestamp,
    mediaUrl: null,
    mediaAudioType: null,
  };
}

function memoryRepository(startedAt: Date) {
  const baselines = new Map<string, number | null>();
  const snapshots = new Map<string, { status: string; follows: number | null }>();
  const snapshotWrites: Array<{
    mediaId: string;
    day: Date;
    capturedAt: Date;
    status: string;
    follows: number | null;
  }> = [];
  const finishes: unknown[] = [];

  return {
    baselines,
    snapshots,
    snapshotWrites,
    finishes,
    repository: {
      beginRun: vi.fn(async () => ({ startedAt, runId: "run-1" })),
      upsertPost: vi.fn(async (input: { mediaId: string; initialBaseline: number | null }) => {
        if (!baselines.has(input.mediaId)) baselines.set(input.mediaId, input.initialBaseline);
      }),
      setBaselineIfMissing: vi.fn(async (mediaId: string, follows: number) => {
        if (baselines.get(mediaId) === null) baselines.set(mediaId, follows);
      }),
      writeSnapshot: vi.fn(
        async (input: { mediaId: string; status: string; follows: number | null }) => {
          snapshotWrites.push(input as (typeof snapshotWrites)[number]);
          const existing = snapshots.get(input.mediaId);
          if (existing?.status === "ok" && input.status !== "ok") return;
          snapshots.set(input.mediaId, { status: input.status, follows: input.follows });
        },
      ),
      finishRun: vi.fn(async (_runId: string, summary: unknown) => {
        finishes.push(summary);
      }),
    },
  };
}

describe("collectFeedFollowSnapshot", () => {
  it("baselines existing posts at their first count and new posts at zero", async () => {
    const now = new Date("2026-08-04T18:00:00Z");
    const startedAt = new Date("2026-08-03T18:00:00Z");
    const memory = memoryRepository(startedAt);
    const posts = [
      post("existing", "2026-08-01T12:00:00Z"),
      post("new", "2026-08-04T12:00:00Z"),
    ];
    const counts = new Map<string, number>([
      ["existing", 17],
      ["new", 4],
    ]);

    const result = await collectFeedFollowSnapshot(
      {
        repository: memory.repository,
        listPosts: async () => posts,
        fetchFollowCount: async (mediaId) => ({ status: "ok", follows: counts.get(mediaId)! }),
        isAuthenticationError: () => false,
        pause: async () => undefined,
        recordEvent: async () => undefined,
        describeError: (error) => ({ message: String(error) }),
      },
      now,
    );

    expect(memory.baselines).toEqual(
      new Map<string, number | null>([
        ["existing", 17],
        ["new", 0],
      ]),
    );
    expect(memory.snapshots).toEqual(
      new Map([
        ["existing", { status: "ok", follows: 17 }],
        ["new", { status: "ok", follows: 4 }],
      ]),
    );
    expect(result).toMatchObject({
      status: "success",
      eligibleCount: 2,
      writtenCount: 2,
      unavailableCount: 0,
      failedCount: 0,
    });
  });

  it("stores unavailable as unknown and continues after an ordinary media failure", async () => {
    const now = new Date("2026-08-04T18:00:00Z");
    const memory = memoryRepository(new Date("2026-08-01T00:00:00Z"));
    const responses = new Map<string, FeedFollowMetricResult | Error>([
      ["unavailable", { status: "unavailable", follows: null }],
      ["failed", new Error("media does not support follows")],
      ["ok", { status: "ok", follows: 2 }],
    ]);

    const result = await collectFeedFollowSnapshot(
      {
        repository: memory.repository,
        listPosts: async () => [post("unavailable", null), post("failed", null), post("ok", null)],
        fetchFollowCount: async (mediaId) => {
          const response = responses.get(mediaId)!;
          if (response instanceof Error) throw response;
          return response;
        },
        isAuthenticationError: () => false,
        pause: async () => undefined,
        recordEvent: async () => undefined,
        describeError: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      },
      now,
    );

    expect(memory.snapshots).toEqual(
      new Map([
        ["unavailable", { status: "unavailable", follows: null }],
        ["failed", { status: "failed", follows: null }],
        ["ok", { status: "ok", follows: 2 }],
      ]),
    );
    expect(result).toMatchObject({ status: "partial", writtenCount: 1, unavailableCount: 1, failedCount: 1 });
  });

  it("aborts remaining media after an account authentication error", async () => {
    const memory = memoryRepository(new Date("2026-08-01T00:00:00Z"));
    const authError = new Error("invalid token");
    const fetched: string[] = [];

    const result = await collectFeedFollowSnapshot(
      {
        repository: memory.repository,
        listPosts: async () => [post("first", null), post("never-fetched", null)],
        fetchFollowCount: async (mediaId) => {
          fetched.push(mediaId);
          throw authError;
        },
        isAuthenticationError: (error) => error === authError,
        pause: async () => undefined,
        recordEvent: async () => undefined,
        describeError: () => ({ message: "invalid token", code: 190 }),
      },
      new Date("2026-08-04T18:00:00Z"),
    );

    expect(fetched).toEqual(["first"]);
    expect(result).toMatchObject({ status: "failed", eligibleCount: 2, writtenCount: 0, failedCount: 1 });
  });

  it("skips collection when another process holds the database lease", async () => {
    const memory = memoryRepository(new Date("2026-08-01T00:00:00Z"));
    memory.repository.beginRun.mockResolvedValueOnce(null as never);
    const listPosts = vi.fn().mockResolvedValue([post("never-listed", null)]);

    const result = await collectFeedFollowSnapshot(
      {
        repository: memory.repository,
        listPosts,
        fetchFollowCount: vi.fn(),
        isAuthenticationError: () => false,
        pause: async () => undefined,
        recordEvent: async () => undefined,
        describeError: () => ({}),
      },
      new Date("2026-08-04T18:00:00Z"),
    );

    expect(result).toBeNull();
    expect(listPosts).not.toHaveBeenCalled();
  });

  it("dates each media snapshot at its own capture time when a batch crosses UTC midnight", async () => {
    const memory = memoryRepository(new Date("2026-08-01T00:00:00Z"));
    const clock = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-08-05T00:00:01Z"))
      .mockReturnValueOnce(new Date("2026-08-05T00:00:02Z"));

    await collectFeedFollowSnapshot(
      {
        repository: memory.repository,
        listPosts: async () => [post("midnight", null)],
        fetchFollowCount: async () => ({ status: "ok", follows: 2 }),
        isAuthenticationError: () => false,
        pause: async () => undefined,
        recordEvent: async () => undefined,
        describeError: () => ({}),
        clock,
      },
      new Date("2026-08-04T23:59:59Z"),
    );

    expect(memory.snapshotWrites[0]).toMatchObject({
      day: new Date("2026-08-05T00:00:00Z"),
      capturedAt: new Date("2026-08-05T00:00:01Z"),
    });
  });
});

describe("createPrismaFeedFollowRepository", () => {
  it("acquires the database lease atomically and skips when another owner holds it", async () => {
    const client = {
      feedFollowCollectorState: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
    };
    const repository = createPrismaFeedFollowRepository(client as never);

    await expect(repository.beginRun(new Date("2026-08-04T18:00:00Z"))).resolves.toBeNull();
    expect(client.feedFollowCollectorState.findUnique).not.toHaveBeenCalled();
    expect(client.feedFollowCollectorState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: "feed",
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: new Date("2026-08-04T18:00:00Z") } },
          ],
        }),
      }),
    );
  });

  it("emits monotonic conflict clauses that update failures but preserve successful rows", async () => {
    const client = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const repository = createPrismaFeedFollowRepository(client as never);

    await repository.writeSnapshot({
      mediaId: "post-1",
      day: new Date("2026-08-04T00:00:00Z"),
      capturedAt: new Date("2026-08-04T18:00:00Z"),
      status: "failed",
      follows: null,
    });

    const failedSql = (client.$executeRaw.mock.calls[0]![0] as TemplateStringsArray).join("?");
    expect(failedSql).toContain('"status" <> \'ok\'');
    expect(failedSql).toContain('"captured_at" <= EXCLUDED."captured_at"');

    await repository.writeSnapshot({
      mediaId: "post-1",
      day: new Date("2026-08-04T00:00:00Z"),
      capturedAt: new Date("2026-08-04T19:00:00Z"),
      status: "ok",
      follows: 4,
    });

    const successSql = (client.$executeRaw.mock.calls[1]![0] as TemplateStringsArray).join("?");
    expect(successSql).toMatch(/"status" <> 'ok'\s+OR/);
    expect(successSql).toContain('"captured_at" <= EXCLUDED."captured_at"');
  });
});

describe("createFeedFollowSnapshotRunner", () => {
  it("skips overlapping ticks and remains usable after the active tick completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const runner = createFeedFollowSnapshotRunner(run, vi.fn());

    const first = runner();
    await runner();
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
    await runner();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("toFeedFollowEvent", () => {
  it("serializes run timestamps before the payload reaches Prisma JSON", () => {
    expect(
      toFeedFollowEvent({
        status: "success",
        startedAt: new Date("2026-08-04T18:00:00Z"),
        completedAt: new Date("2026-08-04T18:01:00Z"),
        eligibleCount: 1,
        writtenCount: 1,
        unavailableCount: 0,
        failedCount: 0,
        abortedForAuthentication: false,
        errors: [],
      }),
    ).toEqual({
      status: "success",
      startedAt: "2026-08-04T18:00:00.000Z",
      completedAt: "2026-08-04T18:01:00.000Z",
      eligibleCount: 1,
      writtenCount: 1,
      unavailableCount: 0,
      failedCount: 0,
      abortedForAuthentication: false,
      errors: [],
    });
  });
});
