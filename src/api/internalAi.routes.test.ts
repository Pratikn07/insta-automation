import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

const getBusinessOverview = vi.fn();
const getKeywordGuideCatalog = vi.fn();
const getConversationSummary = vi.fn();

vi.mock("../services/advisorReadService.js", () => ({
  getBusinessOverview,
  getKeywordGuideCatalog,
  getConversationSummary,
}));

const INTERNAL_TOKEN = "i".repeat(32);
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(actual.env, {
      get: (t, p) => (p === "TINY_SOHO_INTERNAL_TOKEN" ? INTERNAL_TOKEN : t[p as string]),
    }),
  };
});

const { internalAiRouter } = await import("./internalAi.routes.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/internal/ai", internalAiRouter);
  return app;
}

function tool(name: string) {
  return request(makeApp())
    .post(`/internal/ai/tools/${name}`)
    .set("authorization", `Bearer ${INTERNAL_TOKEN}`);
}

beforeEach(() => {
  getBusinessOverview.mockReset().mockResolvedValue({
    windowDays: 7,
    guideDeliveries: 42,
    inboundDmCount: 18,
    needsReplyCount: 3,
    approvedReplyCount: 5,
    replyRatePct: 27.8,
    topKeyword: { keyword: "SLEEP", triggers: 14 },
    capturedAt: "2026-08-04T10:00:00.000Z",
  });
  getKeywordGuideCatalog.mockReset().mockResolvedValue({ items: [] });
  getConversationSummary.mockReset().mockResolvedValue({
    windowDays: 7,
    totals: { threads: 1, needsReply: 1, approvedReplies: 0 },
    threads: [],
  });
});

describe("internal advisor routes — authentication", () => {
  it("rejects a request with no token", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .send({ windowDays: 7 })
      .expect(401, { error: "unauthorized" });
    expect(getBusinessOverview).not.toHaveBeenCalled();
  });

  it("rejects a wrong internal token", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .send({ windowDays: 7 })
      .expect(401);
  });

  // The two auth directions must stay separate: an owner's Supabase JWT is not a
  // service credential, and vice versa.
  it("does not accept an owner Supabase bearer token", async () => {
    const supabaseish = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"a".repeat(40)}.${"b".repeat(43)}`;
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Bearer ${supabaseish}`)
      .send({ windowDays: 7 })
      .expect(401);
  });
});

describe("internal advisor routes — the closed tool registry", () => {
  it("returns 404 for an unknown tool name", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/run_sql")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .send({ query: "select * from ig_token" })
      .expect(404, { error: "unknown_tool" });
  });

  it("exposes exactly the three named tools", async () => {
    await tool("business_overview").send({ windowDays: 7 }).expect(200);
    await tool("keyword_guide_catalog").send({ limit: 10 }).expect(200);
    await tool("conversation_summary").send({ windowDays: 7, limit: 5 }).expect(200);
  });
});

describe("internal advisor routes — strict arguments", () => {
  it("rejects an extra key rather than ignoring it", async () => {
    await tool("business_overview")
      .send({ windowDays: 7, includeSecrets: true })
      .expect(400, { error: "invalid_arguments" });
    expect(getBusinessOverview).not.toHaveBeenCalled();
  });

  it("rejects a window the schema does not allow", async () => {
    await tool("business_overview").send({ windowDays: 365 }).expect(400);
  });

  it("rejects a limit above the cap", async () => {
    await tool("keyword_guide_catalog").send({ limit: 500 }).expect(400);
    await tool("conversation_summary").send({ windowDays: 7, limit: 100 }).expect(400);
  });

  it("rejects a missing argument", async () => {
    await tool("keyword_guide_catalog").send({}).expect(400);
  });

  it("passes validated arguments straight through", async () => {
    await tool("conversation_summary").send({ windowDays: 30, limit: 25 }).expect(200);
    expect(getConversationSummary).toHaveBeenCalledWith({ windowDays: 30, limit: 25 });
  });
});

describe("internal advisor routes — no secret ever leaves", () => {
  it("does not expose tokens, service keys, media URLs or DM bodies", async () => {
    getBusinessOverview.mockResolvedValue({
      windowDays: 7,
      guideDeliveries: 1,
      inboundDmCount: 1,
      needsReplyCount: 0,
      approvedReplyCount: 0,
      replyRatePct: null,
      topKeyword: null,
      capturedAt: "2026-08-04T10:00:00.000Z",
    });
    const res = await tool("business_overview").send({ windowDays: 7 }).expect(200);
    const body = JSON.stringify(res.body);
    for (const forbidden of ["accessToken", "serviceKey", "mediaUrl", "altText", "DATABASE_URL"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("collapses a database failure to a generic code", async () => {
    getConversationSummary.mockRejectedValue(
      new Error('relation "dm_thread" does not exist at postgres://user:pw@host/db'),
    );
    const res = await tool("conversation_summary").send({ windowDays: 7, limit: 5 }).expect(503);
    expect(res.body).toEqual({ error: "tool_unavailable" });
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });
});
