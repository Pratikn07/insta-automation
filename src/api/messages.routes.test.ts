import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { resourceMessage: { create, findFirst, update } },
}));

const { messagesRouter } = await import("./messages.routes.js");

const RESOURCE_ID = "10000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "20000000-0000-4000-8000-000000000001";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messagesRouter);
  return app;
}

function sendMessageRequest(
  method: "POST" | "PATCH",
  body: string,
  type: "text" | "image" | "pdf" = "text",
) {
  const payload =
    method === "POST"
      ? {
          resourceId: RESOURCE_ID,
          type,
          body,
          ...(type === "text" ? {} : { mediaUrl: "https://example.com/captioned-media" }),
        }
      : { body };
  const req = request(makeApp())[method === "POST" ? "post" : "patch"](
    method === "POST" ? "/api/messages" : `/api/messages/${MESSAGE_ID}`,
  );
  return req.send(payload);
}

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: MESSAGE_ID });
  findFirst.mockReset().mockResolvedValue(null);
  update.mockReset().mockResolvedValue({ id: MESSAGE_ID });
});

describe("guide message length boundary", () => {
  it.each(["POST", "PATCH"] as const)("%s accepts exactly 1,000 code points", async (method) => {
    const response = await sendMessageRequest(method, "a".repeat(1_000));

    expect(response.status).toBe(method === "POST" ? 201 : 200);
  });

  it.each(["POST", "PATCH"] as const)(
    "%s rejects 1,001 code points without echoing text",
    async (method) => {
      const sentinel = "P".repeat(1_001);
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

  it.each(["image", "pdf"] as const)("rejects an over-limit %s caption", async (type) => {
    const response = await sendMessageRequest("POST", "P".repeat(1_001), type);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "message_body_too_long",
      limit: 1_000,
      actual: 1_001,
    });
  });

  it.each(["POST", "PATCH"] as const)("%s accepts exactly 1,000 emoji", async (method) => {
    const response = await sendMessageRequest(method, "🙂".repeat(1_000));

    expect(response.status).toBe(method === "POST" ? 201 : 200);
  });

  it.each(["POST", "PATCH"] as const)(
    "%s accepts a production-shaped body over 1,000 UTF-8 bytes but under 1,000 code points",
    async (method) => {
      const body = "a".repeat(962) + "💛".repeat(11);
      expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1_000);

      const response = await sendMessageRequest(method, body);

      expect(response.status).toBe(method === "POST" ? 201 : 200);
    },
  );
});
