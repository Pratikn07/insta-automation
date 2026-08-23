import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const countDeliveries = vi.fn();
const findUpcoming = vi.fn();
const findKeywords = vi.fn();
const deleteConversations = vi.fn();
const deleteKeywords = vi.fn();
const deleteResource = vi.fn();
const countPublishedCovers = vi.fn();
const countCoverOrphans = vi.fn();
const deleteCoverVersions = vi.fn();
const deleteCoverSuggestions = vi.fn();
const deletePresentation = vi.fn();
const transaction = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    guideDelivery: { count: countDeliveries },
    upcomingAutomation: { findMany: findUpcoming },
    keyword: { findMany: findKeywords, deleteMany: deleteKeywords },
    conversation: { deleteMany: deleteConversations },
    resource: { findMany, findUnique, create, delete: deleteResource },
    resourceCoverVersion: {
      count: countPublishedCovers,
      deleteMany: deleteCoverVersions,
    },
    resourceCoverSuggestion: { deleteMany: deleteCoverSuggestions },
    resourcePresentation: { deleteMany: deletePresentation },
    guideCoverOrphan: { count: countCoverOrphans },
    $transaction: transaction,
  },
}));

const { resourcesRouter } = await import("./resources.routes.js");

const RESOURCE_ID = "10000000-0000-4000-8000-000000000001";
const PRIVATE_SENTINEL = "PRIVATE-GUIDE-SENTINEL";

/** Prisma's unique-violation shape, as the client actually throws it. */
function primaryKeyViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: ["id"] },
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/resources", resourcesRouter);
  return app;
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([
    {
      id: RESOURCE_ID,
      name: "Guide name",
      description: null,
      _count: { messages: 2, keywords: 1 },
      messages: [
        { body: "A short authored message" },
        { body: `${PRIVATE_SENTINEL}${"x".repeat(1_001 - PRIVATE_SENTINEL.length)}` },
      ],
    },
  ]);
  findUnique.mockReset().mockResolvedValue({
    id: RESOURCE_ID,
    name: "Guide name",
    description: null,
    messages: [
      { id: "message-1", order: 1, type: "text", body: "A short authored message", mediaUrl: null },
      {
        id: "message-2",
        order: 2,
        type: "text",
        body: `${PRIVATE_SENTINEL}${"x".repeat(1_001 - PRIVATE_SENTINEL.length)}`,
        mediaUrl: null,
      },
    ],
    keywords: [{ id: "keyword-1", keyword: "DONE" }],
  });
  create.mockReset().mockResolvedValue({
    id: RESOURCE_ID,
    name: "Guide name",
    description: null,
  });
  countDeliveries.mockReset().mockResolvedValue(0);
  findUpcoming.mockReset().mockResolvedValue([]);
  findKeywords.mockReset().mockResolvedValue([]);
  deleteConversations.mockReset().mockReturnValue({ operation: "delete-conversations" });
  deleteKeywords.mockReset().mockReturnValue({ operation: "delete-keywords" });
  deleteResource.mockReset().mockReturnValue({ operation: "delete-resource" });
  countPublishedCovers.mockReset().mockResolvedValue(0);
  countCoverOrphans.mockReset().mockResolvedValue(0);
  deleteCoverVersions.mockReset().mockReturnValue({ operation: "delete-cover-versions" });
  deleteCoverSuggestions.mockReset().mockReturnValue({ operation: "delete-cover-suggestions" });
  deletePresentation.mockReset().mockReturnValue({ operation: "delete-presentation" });
  transaction.mockReset().mockResolvedValue([]);
});

// The browser cannot always know whether a create arrived. It owns the UUID and
// repeats it, so asking twice is a primary-key lookup rather than a guess.
describe("resource create replay", () => {
  const body = { id: RESOURCE_ID, name: "Guide name", description: null };

  it("creates with the client's UUID and reports 201", async () => {
    const response = await request(makeApp()).post("/api/resources").send(body).expect(201);

    expect(response.body).toMatchObject({ id: RESOURCE_ID });
    expect(create).toHaveBeenCalledWith({
      data: { id: RESOURCE_ID, name: "Guide name", description: null },
    });
  });

  it("requires the UUID rather than inventing one", async () => {
    await request(makeApp())
      .post("/api/resources")
      .send({ name: "Guide name" })
      .expect(400);

    expect(create).not.toHaveBeenCalled();
  });

  it("answers an exact replay with 200 and the stored row", async () => {
    create.mockRejectedValueOnce(primaryKeyViolation());
    findUnique.mockResolvedValueOnce({
      id: RESOURCE_ID,
      name: "Guide name",
      description: null,
    });

    const response = await request(makeApp()).post("/api/resources").send(body).expect(200);

    expect(response.body).toMatchObject({ id: RESOURCE_ID, name: "Guide name" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects the same UUID used for a different guide", async () => {
    create.mockRejectedValueOnce(primaryKeyViolation());
    findUnique.mockResolvedValueOnce({
      id: RESOURCE_ID,
      name: "A different guide",
      description: null,
    });

    const response = await request(makeApp()).post("/api/resources").send(body).expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
  });

  it("rejects a header that disagrees with the body before touching Prisma", async () => {
    const response = await request(makeApp())
      .post("/api/resources")
      .set("idempotency-key", "20000000-0000-4000-8000-000000000009")
      .send(body)
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a header that agrees with the body", async () => {
    await request(makeApp())
      .post("/api/resources")
      .set("idempotency-key", RESOURCE_ID)
      .send(body)
      .expect(201);
  });
});

describe("resource deletion", () => {
  it("refuses to delete a guide whose published cover is part of its public history", async () => {
    countPublishedCovers.mockResolvedValue(1);

    const response = await request(makeApp())
      .delete(`/api/resources/${RESOURCE_ID}`)
      .expect(409);

    expect(response.body).toEqual({ error: "resource_has_published_cover" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses deletion while an exact generated object still needs cleanup", async () => {
    countCoverOrphans.mockResolvedValue(1);

    const response = await request(makeApp())
      .delete(`/api/resources/${RESOURCE_ID}`)
      .expect(409);

    expect(response.body).toEqual({ error: "resource_has_cover_cleanup_pending" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("preserves retired published-cover history and its immutable object", async () => {
    countPublishedCovers
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const response = await request(makeApp())
      .delete(`/api/resources/${RESOURCE_ID}`)
      .expect(409);

    expect(response.body).toEqual({ error: "resource_has_cover_history" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects deletion before its transaction when immutable delivery history exists", async () => {
    countDeliveries.mockResolvedValue(1);

    const response = await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(409);

    expect(response.body).toEqual({ error: "resource_has_delivery_history" });
    expect(countDeliveries).toHaveBeenCalledWith({ where: { resourceId: RESOURCE_ID } });
    expect(findKeywords).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  /**
   * `upcoming_automations.resource_id` is ON DELETE RESTRICT, so before this guard
   * the delete reached Postgres, failed the constraint, threw uncaught, and arrived
   * in the console as "Delete failed" — no cause, no way out. The create-a-guide
   * inline flow made it easy to reach, since every setup made that way owns a guide.
   */
  it("names the setup holding the guide instead of letting the constraint throw", async () => {
    findUpcoming.mockResolvedValue([{ triggerWord: "TEST", status: "waiting" }]);

    const response = await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(409);

    expect(response.body).toEqual({
      error: "resource_has_upcoming_setup",
      triggerWords: ["TEST"],
      clearable: true,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  // Cancelling is the way out, so whether one is available decides the wording.
  // "Cancel it first" is useless advice about a setup that is already cancelled.
  it("reports a resolved setup as not clearable", async () => {
    findUpcoming.mockResolvedValue([
      { triggerWord: "OLDWORD", status: "cancelled" },
      { triggerWord: "DONEWORD", status: "bound" },
    ]);

    const response = await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(409);

    expect(response.body).toMatchObject({
      triggerWords: ["OLDWORD", "DONEWORD"],
      clearable: false,
    });
  });

  // Every status, because the constraint counts every row. Checking only the open
  // ones would have left the same unhandled 500 for an attached or cancelled setup.
  it("asks about setups of any status", async () => {
    await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(204);

    expect(findUpcoming).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resourceId: RESOURCE_ID } }),
    );
  });

  it("deletes the guide with its keywords and conversations when nothing holds it", async () => {
    findKeywords.mockResolvedValue([{ id: "keyword-1" }]);

    await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(204);

    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteCoverVersions).toHaveBeenCalledWith({ where: { resourceId: RESOURCE_ID } });
    expect(deleteCoverSuggestions).toHaveBeenCalledWith({ where: { resourceId: RESOURCE_ID } });
    expect(deletePresentation).toHaveBeenCalledWith({ where: { resourceId: RESOURCE_ID } });
    expect(deleteResource).toHaveBeenCalledWith({ where: { id: RESOURCE_ID } });
  });

  // A restricting reference this route does not yet know about must still not reach
  // the owner as a 500, which reads as "the server broke" rather than "this is held".
  it("answers a constraint failure it did not anticipate with a refusal, not a crash", async () => {
    transaction.mockRejectedValue(
      Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }),
    );

    const response = await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(409);

    expect(response.body).toEqual({ error: "resource_still_referenced" });
  });

  // Only foreign keys are translated. Swallowing everything would turn a genuine
  // outage into a tidy 409 and hide it.
  it("lets an unrelated failure surface", async () => {
    transaction.mockRejectedValue(new Error("connection terminated"));

    await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(500);
  });
});

describe("resource message-length summaries", () => {
  it("returns only an invalid-message count in the resource list", async () => {
    const response = await request(makeApp()).get("/api/resources").expect(200);

    expect(response.body[0]).toMatchObject({
      id: RESOURCE_ID,
      invalidMessageCount: 1,
    });
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_SENTINEL);
    expect(response.body[0]).not.toHaveProperty("messages");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ messages: { select: { body: true } } }),
      }),
    );
  });

  it("keeps authored messages in an editor response alongside the invalid-message count", async () => {
    const response = await request(makeApp()).get(`/api/resources/${RESOURCE_ID}`).expect(200);

    expect(response.body).toMatchObject({
      id: RESOURCE_ID,
      invalidMessageCount: 1,
    });
    expect(response.body.messages[1].body).toContain(PRIVATE_SENTINEL);
  });
});
