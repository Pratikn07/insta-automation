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
vi.mock("../config/env.js", () => ({ env: {} }));
// The route reads this flag through the service now, so the stub is where the
// value comes from. False keeps every existing expectation: the list reports
// discoveryEnabled false.
vi.mock("../services/flagService.js", () => ({
  flags: { bool: () => false, percent: () => 0 },
}));

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

/** Mounted without the requireAdmin stub, so `adminEmail` is absent. */
function appWithoutIdentity() {
  const app = express();
  app.use(express.json());
  app.use("/api/upcoming-automations", upcomingAutomationsRouter);
  return app;
}

// The browser owns this. A create whose response is lost is indistinguishable
// from one that never ran, so the id has to come from the caller.
const SETUP_ID = "22222222-2222-4222-8222-222222222222";

const validBody = {
  id: SETUP_ID,
  keyword: " highchair ",
  resourceId: "11111111-1111-4111-8111-111111111111",
  publicReply: "Sent! Check your DMs.",
  gateMessage: "Follow and reply DONE for the guide.",
  active: true,
};

/** The row the route would have written, as the database would return it. */
const storedRow = {
  id: SETUP_ID,
  triggerWord: "HIGHCHAIR",
  resourceId: validBody.resourceId,
  publicReply: validBody.publicReply,
  gateMessage: validBody.gateMessage,
  active: true,
  status: "waiting",
  createdBy: "owner@example.com",
};

function primaryKeyViolation() {
  return { code: "P2002", meta: { target: ["id"] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resourceFindUnique.mockResolvedValue({ id: validBody.resourceId, _count: { messages: 1 } });
  create.mockImplementation(async ({ data }) => ({ status: "waiting", ...data }));
  updateMany.mockResolvedValue({ count: 1 });
});

describe("upcoming automations API", () => {
  it("lists open setups always, and resolved ones only for 24 hours", async () => {
    // Fixed so the 24h boundary is an assertable value rather than "roughly now".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    findMany.mockResolvedValue([{ id: "upcoming-1", status: "waiting" }]);

    const response = await request(makeApp()).get("/api/upcoming-automations").expect(200);

    expect(response.body).toEqual({
      automations: [{ id: "upcoming-1", status: "waiting" }],
      discoveryEnabled: false,
    });

    const cutoff = new Date("2026-08-17T12:00:00.000Z");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: { in: ["waiting", "needs_attention"] } },
          { status: "bound", boundAt: { gte: cutoff } },
          { status: "cancelled", cancelledAt: { gte: cutoff } },
        ],
      },
      include: { resource: { select: { id: true, name: true, _count: { select: { messages: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  });

  // A bound row IS an ordinary keyword and already shows on its post in the
  // Content grid. Keeping it here forever prints the same fact twice; dropping it
  // instantly means she never sees that the thing she set up worked.
  it("never expires an open setup, however old", async () => {
    findMany.mockResolvedValue([]);

    await request(makeApp()).get("/api/upcoming-automations").expect(200);

    const where = findMany.mock.calls[0]![0].where;
    const openClause = where.OR.find(
      (clause: { status?: unknown }) =>
        typeof clause.status === "object" && clause.status !== null,
    );
    expect(openClause).toEqual({ status: { in: ["waiting", "needs_attention"] } });
    expect(Object.keys(openClause)).toEqual(["status"]);
  });

  it("creates an uppercase reservation only when the guide has messages", async () => {
    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(201);

    expect(response.body.triggerWord).toBe("HIGHCHAIR");
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: SETUP_ID,
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
      upcomingAutomationId: SETUP_ID,
      triggerWord: "HIGHCHAIR",
      createdBy: "owner@example.com",
    });
  });

  it("refuses a create with no client-owned id", async () => {
    const { id: _omitted, ...noId } = validBody;

    await request(makeApp()).post("/api/upcoming-automations").send(noId).expect(400);

    expect(create).not.toHaveBeenCalled();
  });

  // Two identities for one request, and no safe way to guess which was meant.
  it("refuses before writing when the header disagrees with the body", async () => {
    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .set("Idempotency-Key", "33333333-3333-4333-8333-333333333333")
      .send(validBody)
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(create).not.toHaveBeenCalled();
    expect(resourceFindUnique).not.toHaveBeenCalled();
  });

  it("returns the stored row when the same create is repeated", async () => {
    create.mockRejectedValue(primaryKeyViolation());
    findUnique.mockResolvedValue(storedRow);

    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .set("Idempotency-Key", SETUP_ID)
      .send(validBody)
      .expect(200);

    expect(response.body).toMatchObject({ id: SETUP_ID, triggerWord: "HIGHCHAIR" });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: SETUP_ID } });
  });

  // Casing was never part of the intent, so it must not read as a conflict.
  it("treats a differently cased repeat as the same create", async () => {
    create.mockRejectedValue(primaryKeyViolation());
    findUnique.mockResolvedValue(storedRow);

    await request(makeApp())
      .post("/api/upcoming-automations")
      .send({ ...validBody, keyword: "HighChair" })
      .expect(200);
  });

  it("surfaces one key reused for two different intents rather than the wrong row", async () => {
    create.mockRejectedValue(primaryKeyViolation());
    findUnique.mockResolvedValue(storedRow);

    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send({ ...validBody, gateMessage: "A different gate entirely." })
      .expect(409);

    expect(response.body).toEqual({ error: "idempotency_conflict" });
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

  /**
   * A guide with no steps yet is allowed here, and refused at bind time instead.
   *
   * You cannot write a guide before something exists to write it into, so this used
   * to make the create-a-guide-inline flow impossible. It also never delivered the
   * safety it implied: the binder did not re-check, so a guide emptied after
   * creation still attached. See upcomingAutomationBinding.test.ts for the refusal
   * that replaced it.
   */
  it("accepts a guide that has no steps yet", async () => {
    resourceFindUnique.mockResolvedValue({ id: validBody.resourceId });

    await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(201);

    expect(create).toHaveBeenCalled();
  });

  it("still refuses a guide that does not exist", async () => {
    resourceFindUnique.mockResolvedValue(null);

    const response = await request(makeApp())
      .post("/api/upcoming-automations")
      .send(validBody)
      .expect(400);

    expect(response.body).toEqual({ error: "invalid_resource" });
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

  /**
   * These four writes persist the actor into `created_by`, `updated_by`,
   * `cancelled_by` and `retried_by`. `requireAdmin` gates the whole apiRouter, so
   * an unidentified request cannot reach here in the running app — but the columns
   * are an audit trail, and the previous `?? "unknown"` would have written a name
   * indistinguishable afterwards from a real one.
   */
  describe("without a verified identity", () => {
    it.each([
      ["create", "post", "/api/upcoming-automations"],
      ["edit", "patch", "/api/upcoming-automations/upcoming-1"],
      ["cancel", "post", "/api/upcoming-automations/upcoming-1/cancel"],
      ["retry", "post", "/api/upcoming-automations/upcoming-1/retry"],
    ] as const)("refuses to %s", async (_label, method, path) => {
      const response = await request(appWithoutIdentity())[method](path)
        .send(validBody)
        .expect(401);

      expect(response.body).toEqual({ error: "owner_auth_required" });
    });

    it("writes nothing and records nothing", async () => {
      await request(appWithoutIdentity())
        .post("/api/upcoming-automations")
        .send(validBody)
        .expect(401);

      expect(create).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
    });

    // Reading is protected by the router-level guard, not by this helper. Asserted
    // so hardening the writes cannot quietly break the list.
    it("still allows the list to be read", async () => {
      findMany.mockResolvedValue([]);

      await request(appWithoutIdentity()).get("/api/upcoming-automations").expect(200);
    });
  });
});
