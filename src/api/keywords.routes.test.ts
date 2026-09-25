import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
const backfillKeyword = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { keyword: { create, findUnique } },
}));
vi.mock("../services/keywordBackfillService.js", () => ({
  backfillKeyword: (...a: unknown[]) => backfillKeyword(...a),
}));
vi.mock("../services/keywordService.js", () => ({
  normalizeKeyword: (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase(),
  isValidKeywordPhrase: (value: string) =>
    /^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)?$/.test(value.trim()),
}));

const { keywordsRouter } = await import("./keywords.routes.js");

const KEYWORD_ID = "30000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "10000000-0000-4000-8000-000000000001";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/keywords", keywordsRouter);
  return app;
}

const body = {
  id: KEYWORD_ID,
  keyword: "sleep",
  resourceId: RESOURCE_ID,
  publicReply: "Sent!",
  gateMessage: "Follow to get it",
  mediaId: "media-1",
};

/** Stored row as the route would have written it. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: KEYWORD_ID,
    keyword: "SLEEP",
    mediaId: "media-1",
    mediaCaption: null,
    mediaPermalink: null,
    mediaPostedAt: null,
    resourceId: RESOURCE_ID,
    publicReply: "Sent!",
    gateMessage: "Follow to get it",
    active: true,
    ...overrides,
  };
}

function violation(target: string[]) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });
}

beforeEach(() => {
  create.mockReset().mockResolvedValue(stored());
  findUnique.mockReset().mockResolvedValue(null);
  backfillKeyword.mockReset().mockResolvedValue(undefined);
});

describe("keyword create replay", () => {
  it("creates with the client's UUID and normalizes the keyword", async () => {
    await request(makeApp()).post("/api/keywords").send(body).expect(201);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: KEYWORD_ID, keyword: "SLEEP" }),
    });
    expect(backfillKeyword).toHaveBeenCalledWith(KEYWORD_ID);
  });

  it("accepts and canonicalizes a two-word keyword", async () => {
    await request(makeApp())
      .post("/api/keywords")
      .send({ ...body, keyword: "  high   chair  " })
      .expect(201);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ keyword: "HIGH CHAIR" }),
    });
  });

  it.each(["one two three", "POTTY!", "under_score", "🥑"])(
    "rejects an invalid keyword phrase: %j",
    async (keyword) => {
      await request(makeApp()).post("/api/keywords").send({ ...body, keyword }).expect(400);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("requires the UUID", async () => {
    const { id: _id, ...withoutId } = body;
    await request(makeApp()).post("/api/keywords").send(withoutId).expect(400);

    expect(create).not.toHaveBeenCalled();
  });

  it("answers an exact replay with 200 and the stored keyword", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    findUnique.mockResolvedValueOnce(stored());

    const response = await request(makeApp()).post("/api/keywords").send(body).expect(200);

    expect(response.body).toMatchObject({ id: KEYWORD_ID, keyword: "SLEEP" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  // The backfill is itself idempotent, and a lost first response may well have
  // lost the enqueue with it. Re-running it is the safe side of that bet.
  it("re-enqueues backfill for an active exact replay", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    findUnique.mockResolvedValueOnce(stored({ active: true }));

    await request(makeApp()).post("/api/keywords").send(body).expect(200);

    expect(backfillKeyword).toHaveBeenCalledWith(KEYWORD_ID);
  });

  it("does not enqueue backfill for an inactive exact replay", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    findUnique.mockResolvedValueOnce(stored({ active: false }));

    // The request must also have asked for inactive, or this is a conflict rather
    // than a replay — `active` is the caller's field.
    await request(makeApp())
      .post("/api/keywords")
      .send({ ...body, active: false })
      .expect(200);

    expect(backfillKeyword).not.toHaveBeenCalled();
  });

  it("calls a flipped active flag a conflict rather than a replay", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    findUnique.mockResolvedValueOnce(stored({ active: false }));

    // Stored inactive, requested active: the caller means something else now.
    const response = await request(makeApp()).post("/api/keywords").send(body).expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
    expect(backfillKeyword).not.toHaveBeenCalled();
  });

  it("rejects a conflicting replay and enqueues nothing", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    findUnique.mockResolvedValueOnce(stored({ gateMessage: "Something different" }));

    const response = await request(makeApp()).post("/api/keywords").send(body).expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
    expect(backfillKeyword).not.toHaveBeenCalled();
  });

  it("compares the normalized keyword, not the raw request text", async () => {
    create.mockRejectedValueOnce(violation(["id"]));
    // Stored uppercase, requested lowercase: the same keyword.
    findUnique.mockResolvedValueOnce(stored({ keyword: "SLEEP" }));

    await request(makeApp()).post("/api/keywords").send(body).expect(200);
  });

  // A different row already owns this post's keyword. That is the existing domain
  // duplicate, not a replay, and it keeps its existing answer.
  it("keeps the domain duplicate response for a business-key clash", async () => {
    create.mockRejectedValueOnce(violation(["keyword", "media_id"]));

    const response = await request(makeApp()).post("/api/keywords").send(body).expect(409);

    expect(response.body).toEqual({ error: "keyword_exists" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a mismatched header before touching Prisma", async () => {
    const response = await request(makeApp())
      .post("/api/keywords")
      .set("idempotency-key", "30000000-0000-4000-8000-000000000009")
      .send(body)
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });
});
