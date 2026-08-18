import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findFirst = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { resourceMessage: { create, findFirst, findUnique, update } },
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
          id: MESSAGE_ID,
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
  findUnique.mockReset().mockResolvedValue(null);
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

// A step's position is assigned by the server from the current tail, so it cannot
// take part in deciding whether a repeated create is the same create.
describe("resource message create replay", () => {
  const body = {
    id: MESSAGE_ID,
    resourceId: RESOURCE_ID,
    type: "text" as const,
    body: "Step one",
  };

  function primaryKeyViolation() {
    return Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["id"] },
    });
  }

  it("creates with the client's UUID at the computed order", async () => {
    findFirst.mockResolvedValue({ order: 4 });

    await request(makeApp()).post("/api/messages").send(body).expect(201);

    expect(create).toHaveBeenCalledWith({
      data: {
        id: MESSAGE_ID,
        resourceId: RESOURCE_ID,
        order: 5,
        type: "text",
        body: "Step one",
        mediaUrl: null,
      },
    });
  });

  it("treats a replay as a replay even though the stored order differs from the next one", async () => {
    // The tail moved on since the first attempt. That is the server's business,
    // not evidence of a different intent.
    findFirst.mockResolvedValue({ order: 9 });
    create.mockRejectedValueOnce(primaryKeyViolation());
    findUnique.mockResolvedValueOnce({
      id: MESSAGE_ID,
      resourceId: RESOURCE_ID,
      order: 5,
      type: "text",
      body: "Step one",
      mediaUrl: null,
    });

    const response = await request(makeApp()).post("/api/messages").send(body).expect(200);

    expect(response.body).toMatchObject({ id: MESSAGE_ID, order: 5 });
  });

  it("rejects the same UUID carrying different authored text", async () => {
    create.mockRejectedValueOnce(primaryKeyViolation());
    findUnique.mockResolvedValueOnce({
      id: MESSAGE_ID,
      resourceId: RESOURCE_ID,
      order: 5,
      type: "text",
      body: "Something else entirely",
      mediaUrl: null,
    });

    const response = await request(makeApp()).post("/api/messages").send(body).expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
  });

  it("rejects the same UUID moved to another guide", async () => {
    create.mockRejectedValueOnce(primaryKeyViolation());
    findUnique.mockResolvedValueOnce({
      id: MESSAGE_ID,
      resourceId: "10000000-0000-4000-8000-000000000009",
      order: 5,
      type: "text",
      body: "Step one",
      mediaUrl: null,
    });

    await request(makeApp()).post("/api/messages").send(body).expect(409);
  });

  it("rejects a mismatched header before touching Prisma", async () => {
    const response = await request(makeApp())
      .post("/api/messages")
      .set("idempotency-key", "20000000-0000-4000-8000-000000000009")
      .send(body)
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(create).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
