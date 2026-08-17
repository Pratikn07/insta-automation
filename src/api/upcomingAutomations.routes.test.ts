import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const resourceFindUnique = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    upcomingAutomation: { findMany, findUnique, create, update, updateMany },
    resource: { findUnique: resourceFindUnique },
  },
}));

vi.mock("../services/eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({ env: { UPCOMING_AUTOMATIONS_ENABLED: false } }));

const { upcomingAutomationsRouter } = await import("./upcomingAutomations.routes.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminEmail = "owner@example.com";
    next();
  });
  app.use("/api/upcoming-automations", upcomingAutomationsRouter);
  return app;
}

const validBody = {
  keyword: " highchair ",
  resourceId: "11111111-1111-4111-8111-111111111111",
  publicReply: "Sent! Check your DMs.",
  gateMessage: "Follow and reply DONE for the guide.",
  active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resourceFindUnique.mockResolvedValue({ id: validBody.resourceId, _count: { messages: 1 } });
  create.mockImplementation(async ({ data }) => ({ id: "upcoming-1", status: "waiting", ...data }));
  updateMany.mockResolvedValue({ count: 1 });
});

describe("upcoming automations API", () => {
  it("lists every non-bound setup with its guide summary", async () => {
    findMany.mockResolvedValue([{ id: "upcoming-1", status: "waiting" }]);

    const response = await request(makeApp()).get("/api/upcoming-automations").expect(200);

    expect(response.body).toEqual({
      automations: [{ id: "upcoming-1", status: "waiting" }],
      discoveryEnabled: false,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { status: { not: "bound" } },
      include: { resource: { select: { id: true, name: true, _count: { select: { messages: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("creates an uppercase reservation only when the guide has messages", async () => {
    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(201);

    expect(response.body.triggerWord).toBe("HIGHCHAIR");
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        triggerWord: "HIGHCHAIR",
        resourceId: validBody.resourceId,
        publicReply: validBody.publicReply,
        gateMessage: validBody.gateMessage,
        active: true,
        createdBy: "owner@example.com",
        status: "waiting",
      }),
    });
    expect(logEvent).toHaveBeenCalledWith("upcoming_automation_created", {
      upcomingAutomationId: "upcoming-1",
      triggerWord: "HIGHCHAIR",
      createdBy: "owner@example.com",
    });
  });

  it.each(["two words", "POTTY!", "🥑", "under_score"])(
    "rejects a trigger that is not one letters-and-numbers token: %j",
    async (keyword) => {
      await request(makeApp())
        .post("/api/upcoming-automations")
        .send({ ...validBody, keyword })
        .expect(400);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("rejects a guide with no messages", async () => {
    resourceFindUnique.mockResolvedValue({ id: validBody.resourceId, _count: { messages: 0 } });

    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(400);

    expect(response.body).toEqual({ error: "empty_resource" });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps the partial unique reservation to a stable conflict response", async () => {
    create.mockRejectedValue({ code: "P2002" });

    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(409);

    expect(response.body).toEqual({ error: "upcoming_keyword_reserved" });
  });

  it("edits an unresolved setup and revalidates a changed guide", async () => {
    findUnique.mockResolvedValue({ id: "upcoming-1", status: "waiting" });
    update.mockResolvedValue({ id: "upcoming-1", status: "waiting", triggerWord: "POTTY" });

    await request(makeApp())
      .patch("/api/upcoming-automations/upcoming-1")
      .send({ keyword: "potty", resourceId: validBody.resourceId })
      .expect(200);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "upcoming-1", status: { in: ["waiting", "needs_attention"] } },
      data: { triggerWord: "POTTY", resourceId: validBody.resourceId },
    });
  });

  it.each(["bound", "cancelled"])("keeps a %s setup immutable", async (status) => {
    findUnique.mockResolvedValue({ id: "upcoming-1", status });

    const response = await request(makeApp())
      .patch("/api/upcoming-automations/upcoming-1")
      .send({ publicReply: "Changed" })
      .expect(409);

    expect(response.body).toEqual({ error: "upcoming_automation_resolved" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("cancels an open setup with a lifecycle timestamp", async () => {
    findUnique.mockResolvedValue({ id: "upcoming-1", status: "waiting", triggerWord: "HIGHCHAIR" });
    update.mockResolvedValue({ id: "upcoming-1", status: "cancelled" });

    await request(makeApp())
      .post("/api/upcoming-automations/upcoming-1/cancel")
      .expect(200);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "upcoming-1", status: { in: ["waiting", "needs_attention"] } },
      data: { status: "cancelled", cancelledAt: expect.any(Date), errorCode: null },
    });
    expect(logEvent).toHaveBeenCalledWith(
      "upcoming_automation_cancelled",
      expect.objectContaining({ upcomingAutomationId: "upcoming-1" }),
    );
  });

  it("refuses cancellation when binding wins the race after the initial read", async () => {
    findUnique.mockResolvedValue({ id: "upcoming-1", status: "waiting", triggerWord: "HIGHCHAIR" });
    updateMany.mockResolvedValue({ count: 0 });

    const response = await request(makeApp())
      .post("/api/upcoming-automations/upcoming-1/cancel")
      .expect(409);

    expect(response.body).toEqual({ error: "upcoming_automation_resolved" });
    expect(logEvent).not.toHaveBeenCalledWith("upcoming_automation_cancelled", expect.anything());
  });

  it("retries only a needs-attention setup", async () => {
    findUnique.mockResolvedValue({
      id: "upcoming-1",
      status: "needs_attention",
      triggerWord: "HIGHCHAIR",
    });
    update.mockResolvedValue({ id: "upcoming-1", status: "waiting" });

    await request(makeApp())
      .post("/api/upcoming-automations/upcoming-1/retry")
      .expect(200);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "upcoming-1", status: "needs_attention" },
      data: {
        status: "waiting",
        errorCode: null,
        lastAttemptAt: null,
        matchedMediaId: null,
        retriedAt: expect.any(Date),
      },
    });
  });
});
