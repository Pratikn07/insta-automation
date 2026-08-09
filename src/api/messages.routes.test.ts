import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { resourceMessage: { findFirst, create, update } },
}));

const { messagesRouter } = await import("./messages.routes.js");

const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messagesRouter);
  return app;
}

async function sendMessageRequest(
  method: "POST" | "PATCH",
  body: string,
  type: "text" | "image" | "pdf" = "text",
) {
  if (method === "POST") {
    return request(makeApp())
      .post("/api/messages")
      .send({
        resourceId: RESOURCE_ID,
        type,
        body,
        mediaUrl: type === "text" ? undefined : "https://cdn.example.com/guide.png",
      });
  }

  return request(makeApp()).patch("/api/messages/message-1").send({ body });
}

beforeEach(() => {
  findFirst.mockReset().mockResolvedValue(null);
  create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "message-1",
    ...data,
  }));
  update.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "message-1",
    ...data,
  }));
});

describe("guide message length", () => {
  it.each(["POST", "PATCH"] as const)("%s accepts exactly 1,000 code units", async (method) => {
    const response = await sendMessageRequest(method, "a".repeat(1_000));

    expect(response.status).toBe(method === "POST" ? 201 : 200);
  });

  it.each(["POST", "PATCH"] as const)(
    "%s accepts exactly 500 emoji (1,000 code units)",
    async (method) => {
      const response = await sendMessageRequest(method, "😀".repeat(500));

      expect(response.status).toBe(method === "POST" ? 201 : 200);
    },
  );

  it.each(["POST", "PATCH"] as const)(
    "%s rejects 1,001 code units without echoing text",
    async (method) => {
      const sentinel = `${"a".repeat(999)}😀`;
      const response = await sendMessageRequest(method, sentinel);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "message_body_too_long",
        limit: 1_000,
        actual: 1_001,
      });
      expect(JSON.stringify(response.body)).not.toContain(sentinel);
    },
  );

  it.each(["image", "pdf"] as const)(
    "rejects an over-limit %s caption with the shared error",
    async (type) => {
      const response = await sendMessageRequest("POST", "😀".repeat(501), type);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "message_body_too_long",
        limit: 1_000,
        actual: 1_002,
      });
    },
  );
});
