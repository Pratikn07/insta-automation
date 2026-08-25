import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
const deleteKeyword = vi.fn();
const deleteConversations = vi.fn();
const countDeliveries = vi.fn();
const countAccessAttempts = vi.fn();
const countReminders = vi.fn();
const countCandidates = vi.fn();
const countIntents = vi.fn();
const transaction = vi.fn();
const backfillKeyword = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    keyword: { create, findUnique, delete: deleteKeyword },
    conversation: { deleteMany: deleteConversations },
    guideDelivery: { count: countDeliveries },
    guideAccessAttempt: { count: countAccessAttempts },
    dmRecoveryReminder: { count: countReminders },
    recoveryCandidate: { count: countCandidates },
    journeyIntent: { count: countIntents },
    $transaction: transaction,
  },
}));
vi.mock("../services/keywordBackfillService.js", () => ({
  backfillKeyword: (...a: unknown[]) => backfillKeyword(...a),
}));
vi.mock("../services/keywordService.js", () => ({
  normalizeKeyword: (value: string) => value.trim().toUpperCase(),
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

/** Prisma's foreign-key refusal, as the client actually throws it. */
function foreignKeyViolation() {
  return Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
}

beforeEach(() => {
  create.mockReset().mockResolvedValue(stored());
  findUnique.mockReset().mockResolvedValue(null);
  backfillKeyword.mockReset().mockResolvedValue(undefined);
  deleteKeyword.mockReset().mockResolvedValue(stored());
  deleteConversations.mockReset().mockResolvedValue({ count: 0 });
  // Nothing blocks the delete unless a test says so.
  countDeliveries.mockReset().mockResolvedValue(0);
  countAccessAttempts.mockReset().mockResolvedValue(0);
  countReminders.mockReset().mockResolvedValue(0);
  countCandidates.mockReset().mockResolvedValue(0);
  countIntents.mockReset().mockResolvedValue(0);
  transaction.mockReset().mockResolvedValue([]);
});

describe("keyword create replay", () => {
  it("creates with the client's UUID and normalizes the keyword", async () => {
    await request(makeApp()).post("/api/keywords").send(body).expect(201);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: KEYWORD_ID, keyword: "SLEEP" }),
    });
    expect(backfillKeyword).toHaveBeenCalledWith(KEYWORD_ID);
  });

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

/**
 * Each of these previously reached the error middleware as a 500 — which the browser
 * client turns into an outcome nobody knows, not an `ApiError` — so the only thing the
 * Keywords page could say was a bare "Delete failed". A named 409 is what lets it say
 * which record is holding the keyword and that pausing is the way out.
 */
describe("keyword delete refusals", () => {
  const deleteKeywordRequest = () => request(makeApp()).delete(`/api/keywords/${KEYWORD_ID}`);

  beforeEach(() => {
    findUnique.mockResolvedValue({ id: KEYWORD_ID });
  });

  it("deletes the keyword and its conversations when nothing holds it", async () => {
    await deleteKeywordRequest().expect(204);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteConversations).toHaveBeenCalledWith({ where: { keywordId: KEYWORD_ID } });
    expect(deleteKeyword).toHaveBeenCalledWith({ where: { id: KEYWORD_ID } });
  });

  // A repeat of a delete whose response was lost is the owner asking for a state that
  // already holds, not an error.
  it("treats an already-deleted keyword as done", async () => {
    findUnique.mockResolvedValueOnce(null);

    await deleteKeywordRequest().expect(204);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a keyword whose guide already reached someone", async () => {
    countDeliveries.mockResolvedValueOnce(1);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_delivery_history" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a keyword someone asked for through the follow check", async () => {
    countAccessAttempts.mockResolvedValueOnce(1);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_guide_access_history" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a keyword holding follow-up records", async () => {
    countReminders.mockResolvedValueOnce(3);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_recovery_history" });
  });

  // Candidates and reminders are the same answer: one count of zero must not hide the
  // other's rows.
  it("counts recovery candidates as well as reminders", async () => {
    countCandidates.mockResolvedValueOnce(2);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_recovery_history" });
  });

  it("refuses a keyword people have already commented", async () => {
    countIntents.mockResolvedValueOnce(5);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_journey_history" });
    expect(transaction).not.toHaveBeenCalled();
  });

  // Delivery history says more than the journey rows that almost always accompany it.
  it("names the delivery when both hold the keyword", async () => {
    countDeliveries.mockResolvedValueOnce(1);
    countIntents.mockResolvedValueOnce(5);

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_has_delivery_history" });
  });

  it("answers a refusal for a reference no guard names yet", async () => {
    transaction.mockRejectedValueOnce(foreignKeyViolation());

    const response = await deleteKeywordRequest().expect(409);

    expect(response.body).toEqual({ error: "keyword_still_referenced" });
  });

  // Anything that is not a blocked reference stays a 500 rather than being dressed up
  // as a refusal the owner could act on.
  it("forwards an unrelated failure to the error middleware", async () => {
    transaction.mockRejectedValueOnce(new Error("connection lost"));

    await deleteKeywordRequest().expect(500);
  });
});
