import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resourceFindMany = vi.fn();
const resourceFindUnique = vi.fn();
const resourceDelete = vi.fn();
const guideDeliveryCount = vi.fn();
const keywordFindMany = vi.fn();
const keywordDeleteMany = vi.fn();
const conversationDeleteMany = vi.fn();
const transaction = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    resource: {
      findMany: resourceFindMany,
      findUnique: resourceFindUnique,
      delete: resourceDelete,
    },
    guideDelivery: { count: guideDeliveryCount },
    keyword: { findMany: keywordFindMany, deleteMany: keywordDeleteMany },
    conversation: { deleteMany: conversationDeleteMany },
    $transaction: transaction,
  },
}));

const { resourcesRouter } = await import("./resources.routes.js");

function makeApp() {
  const app = express();
  app.use("/api/resources", resourcesRouter);
  return app;
}

const PRIVATE_SENTINEL = "PRIVATE-GUIDE-SENTINEL";

function resource(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    name: "Guide name",
    description: null,
    createdAt: new Date("2026-08-09T00:00:00.000Z"),
    _count: { messages: 2, keywords: 1 },
    messages: [
      { body: "a".repeat(1_000) },
      { body: `${PRIVATE_SENTINEL}${"a".repeat(980)}` },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resourceFindMany.mockReset().mockResolvedValue([]);
  resourceFindUnique.mockReset().mockResolvedValue(null);
  resourceDelete.mockReset();
  guideDeliveryCount.mockReset().mockResolvedValue(0);
  keywordFindMany.mockReset().mockResolvedValue([]);
  keywordDeleteMany.mockReset();
  conversationDeleteMany.mockReset();
  transaction.mockReset().mockResolvedValue([]);
});

describe("resource guide message summaries", () => {
  it("keeps over-limit bodies out of the resource list while returning their count", async () => {
    resourceFindMany.mockResolvedValue([resource()]);

    const response = await request(makeApp()).get("/api/resources");

    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      id: "resource-1",
      invalidMessageCount: 1,
    });
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_SENTINEL);
    expect(response.body[0]).not.toHaveProperty("messages");
  });

  it("keeps authored messages in the editor response and adds their over-limit count", async () => {
    const authoredMessages = [
      { id: "message-1", body: "a".repeat(1_000), order: 0, type: "text", mediaUrl: null },
      {
        id: "message-2",
        body: `${PRIVATE_SENTINEL}${"a".repeat(980)}`,
        order: 1,
        type: "text",
        mediaUrl: null,
      },
    ];
    resourceFindUnique.mockResolvedValue(
      resource({ messages: authoredMessages, keywords: [{ id: "keyword-1", keyword: "DONE" }] }),
    );

    const response = await request(makeApp()).get("/api/resources/resource-1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "resource-1",
      invalidMessageCount: 1,
      messages: authoredMessages,
    });
  });
});

describe("resource deletion", () => {
  it("rejects deletion when immutable delivery history references the resource", async () => {
    guideDeliveryCount.mockResolvedValue(1);

    const response = await request(makeApp()).delete("/api/resources/resource-1");

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "resource_has_delivery_history" });
    expect(guideDeliveryCount).toHaveBeenCalledWith({
      where: { resourceId: "resource-1" },
    });
    expect(keywordFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
