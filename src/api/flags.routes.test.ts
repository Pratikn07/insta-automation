import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const refresh = vi.fn();
const snapshot = vi.fn();
const logEvent = vi.fn();
const flagExperimentKey = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { flagOverride: { upsert } } }));
vi.mock("../services/flagService.js", () => ({
  flags: { snapshot: () => snapshot(), refresh: () => refresh() },
}));
vi.mock("../services/eventLogger.js", () => ({ logEvent }));
vi.mock("../services/experimentLifecycle.js", () => ({
  configuredFlagExperimentKey: (key: string, declared: string | undefined) =>
    flagExperimentKey(key, declared),
}));

const { flagsRouter } = await import("./flags.routes.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.adminEmail = "owner@example.com";
    next();
  });
  a.use("/api/flags", flagsRouter);
  return a;
}

/** Mounted without the requireAdmin stub, so `adminEmail` is absent. */
function appWithoutIdentity() {
  const a = express();
  a.use(express.json());
  a.use("/api/flags", flagsRouter);
  return a;
}

function row(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockReturnValue([
    row("AI_DRAFTS_ENABLED"),
    row("AI_SEND_ENABLED", { valueBool: false }),
    row("WORKERS_ENABLED"),
    row("GUIDE_DELIVERY_ROLLOUT_PERCENT", { valueBool: null, valuePercent: 45 }),
    row("DM_RECOVERY_FAILURE_RATE_PERCENT", { valueBool: null, valuePercent: 50 }),
  ]);
  upsert.mockResolvedValue({});
  flagExperimentKey.mockImplementation((_key: string, declared: string | undefined) => declared);
});

describe("flags API", () => {
  it("returns every flag with its description and its value", async () => {
    const response = await request(app()).get("/api/flags").expect(200);

    const drafts = response.body.flags.find(
      (f: { key: string }) => f.key === "AI_DRAFTS_ENABLED",
    );
    expect(drafts).toMatchObject({
      name: "Reply drafts",
      group: "assistive",
      kind: "boolean",
      valueBool: true,
      pageMayEnable: true,
      pageMayStop: true,
    });
    expect(drafts.doesWhat.length).toBeGreaterThan(20);
    expect(drafts.affectsWho.length).toBeGreaterThan(10);
    expect(drafts.ifOff.length).toBeGreaterThan(10);
  });

  it("returns all nineteen, even those with no stored row", async () => {
    snapshot.mockReturnValue([]);

    const response = await request(app()).get("/api/flags").expect(200);

    expect(response.body.flags).toHaveLength(19);
  });

  /**
   * The detail page fetches its own flag rather than filtering a cached list, so a
   * bookmarked switch URL works before the list has ever been opened.
   */
  it("returns a single flag with its description, its value, and its experiment", async () => {
    const response = await request(app()).get("/api/flags/DM_RECOVERY_ENABLED").expect(200);

    expect(response.body).toMatchObject({
      key: "DM_RECOVERY_ENABLED",
      name: "Recovery reminders",
      kind: "boolean",
      pageMayEnable: false,
      pageMayStop: true,
      experimentKey: "recovery-reminder-timing-v2",
      // Served, not looked up client-side: the console keeping its own key-to-name
      // map is how a renamed experiment would keep its old name on this switch.
      experimentName: "Recovery reminder — 2 vs 6 hours",
    });
    expect(response.body.ifOff.length).toBeGreaterThan(10);
  });

  it("returns a standalone flag with no experiment attached", async () => {
    const response = await request(app()).get("/api/flags/AI_ADVISOR_ENABLED").expect(200);

    expect(response.body.key).toBe("AI_ADVISOR_ENABLED");
    expect(response.body.experimentKey).toBeUndefined();
    expect(response.body.experimentName).toBeNull();
  });

  it("links shared recovery controls to V1 before cutover", async () => {
    flagExperimentKey.mockImplementation((key: string, declared: string | undefined) =>
      key === "DM_RECOVERY_ENABLED" ? "recovery-reminder-timing" : declared,
    );

    const response = await request(app()).get("/api/flags/DM_RECOVERY_ENABLED").expect(200);

    expect(response.body).toMatchObject({
      experimentKey: "recovery-reminder-timing",
      experimentName: "Recovery reminder — 10 hours vs none",
    });
  });

  it("404s a single flag that does not exist", async () => {
    await request(app()).get("/api/flags/NOPE").expect(404);
  });

  it("saves a permitted change and refreshes the cache", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valueBool: false })
      .expect(200);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "AI_DRAFTS_ENABLED" } }),
    );
    // Without this the console would show the old value until the timer fired.
    expect(refresh).toHaveBeenCalled();
  });

  it("records the change without recording anyone's data", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valueBool: false })
      .expect(200);

    expect(logEvent).toHaveBeenCalledWith("flag_changed", {
      key: "AI_DRAFTS_ENABLED",
      valueBool: false,
      valuePercent: null,
      updatedBy: "owner@example.com",
    });
  });

  // The fence, server-side. The page hides the control; this is what makes it true.
  it("refuses to enable a flag the console may not enable", async () => {
    const response = await request(app())
      .patch("/api/flags/AI_SEND_ENABLED")
      .send({ valueBool: true })
      .expect(403);

    expect(response.body).toEqual({ error: "flag_enable_not_permitted" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("allows that same flag to be switched off", async () => {
    await request(app())
      .patch("/api/flags/AI_SEND_ENABLED")
      .send({ valueBool: false })
      .expect(200);

    expect(upsert).toHaveBeenCalled();
  });

  it.each(["GUIDE_FOLLOW_GATE_V2_ENABLED", "GUIDE_RICH_GATE_ENABLED"])(
    "refuses to enable %s from the page but permits its emergency stop",
    async (key) => {
      await request(app())
        .patch(`/api/flags/${key}`)
        .send({ valueBool: true })
        .expect(403, { error: "flag_enable_not_permitted" });
      expect(upsert).not.toHaveBeenCalled();

      await request(app()).patch(`/api/flags/${key}`).send({ valueBool: false }).expect(200);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key },
          create: expect.objectContaining({ valueBool: false }),
        }),
      );
    },
  );

  it("refuses any change to a flag that offers no control", async () => {
    const response = await request(app())
      .patch("/api/flags/WORKERS_ENABLED")
      .send({ valueBool: false })
      .expect(403);

    expect(response.body).toEqual({ error: "flag_not_controllable" });
    expect(upsert).not.toHaveBeenCalled();
  });

  // Raising this would make the system tolerate more failures, which is the one
  // direction the console may not move anything.
  it("refuses to change the stop-sending threshold", async () => {
    const response = await request(app())
      .patch("/api/flags/DM_RECOVERY_FAILURE_RATE_PERCENT")
      .send({ valuePercent: 90 })
      .expect(403);

    expect(response.body).toEqual({ error: "flag_not_controllable" });
  });

  it("accepts a percentage for a percentage flag", async () => {
    await request(app())
      .patch("/api/flags/GUIDE_DELIVERY_ROLLOUT_PERCENT")
      .send({ valuePercent: 100 })
      .expect(200);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ valuePercent: 100, valueBool: null }),
      }),
    );
  });

  it("rejects the wrong kind of value for the flag", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valuePercent: 50 })
      .expect(400);
    await request(app())
      .patch("/api/flags/GUIDE_DELIVERY_ROLLOUT_PERCENT")
      .send({ valueBool: true })
      .expect(400);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a body carrying both values, or neither", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valueBool: true, valuePercent: 5 })
      .expect(400);
    await request(app()).patch("/api/flags/AI_DRAFTS_ENABLED").send({}).expect(400);
  });

  it("rejects a percentage outside 0-100", async () => {
    await request(app())
      .patch("/api/flags/GUIDE_DELIVERY_ROLLOUT_PERCENT")
      .send({ valuePercent: 150 })
      .expect(400);
  });

  it("404s an unknown key", async () => {
    await request(app()).patch("/api/flags/NOPE").send({ valueBool: true }).expect(404);
  });

  /**
   * `requireAdmin` already makes this unreachable in the running app — it gates the
   * whole apiRouter. These two exist because `updatedBy` is an audit field on a row
   * that changes what the entire system does, so an invented identity must be
   * impossible rather than merely unlikely.
   */
  describe("without a verified identity", () => {
    it("refuses before doing any work", async () => {
      const response = await request(appWithoutIdentity())
        .patch("/api/flags/AI_DRAFTS_ENABLED")
        .send({ valueBool: false })
        .expect(401);

      expect(response.body).toEqual({ error: "owner_auth_required" });
    });

    it("writes nothing and records nothing", async () => {
      await request(appWithoutIdentity())
        .patch("/api/flags/AI_DRAFTS_ENABLED")
        .send({ valueBool: false })
        .expect(401);

      expect(upsert).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    // Reading is a different question from writing, and the router-level guard is
    // what protects it. This asserts the change did not silently break the read.
    it("still allows the list to be read", async () => {
      await request(appWithoutIdentity()).get("/api/flags").expect(200);
    });
  });
});
