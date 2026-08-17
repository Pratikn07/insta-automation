import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { resource: { findMany, findUnique } },
}));

const { resourcesRouter } = await import("./resources.routes.js");

const RESOURCE_ID = "10000000-0000-4000-8000-000000000001";
const PRIVATE_SENTINEL = "PRIVATE-GUIDE-SENTINEL";

function makeApp() {
  const app = express();
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
