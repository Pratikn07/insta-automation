import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeError } from "../services/codexRuntimeClient.js";
import type { CodexRuntimeClient } from "../services/codexRuntimeClient.js";

// Flags are read through a proxy so a test can flip one without touching the real
// env, matching the convention in aiDrafts.routes.test.ts.
const flags = vi.hoisted(() => ({
  AI_ADVISOR_ENABLED: true,
  AI_DRAFTS_ENABLED: true,
  AI_FOLLOW_UPS_ENABLED: false,
  AI_SEND_ENABLED: false,
}));
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(actual.env, {
      get: (target, property) =>
        property in flags
          ? flags[property as keyof typeof flags]
          : target[property as string],
    }),
  };
});

const { createAiRouter } = await import("./ai.routes.js");
const { apiRouter } = await import("./router.js");

const ADVISOR_ANSWER = {
  answer: "Reply rate is the thing to fix first.",
  recommendation: "Clear the needs-reply queue this week.",
  evidence: [{ label: "Needs reply", value: "3 threads", href: "/conversations" as const }],
  confidence: "medium" as const,
  nextStep: "Open Conversations.",
  nextStepHref: "/conversations" as const,
  dataGaps: [],
};

function fakeClient(overrides: Partial<CodexRuntimeClient> = {}): CodexRuntimeClient {
  return {
    getConnectionStatus: vi.fn(async () => ({
      connected: true,
      requiresOpenaiAuth: false,
      account: { email: "owner@example.com", planType: "plus" },
      rateLimits: { usedPercent: 12, resetsAt: 1785888000 },
    })),
    startDeviceLogin: vi.fn(async () => ({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    })),
    disconnect: vi.fn(async () => undefined),
    getAdvisorHistory: vi.fn(async () => []),
    askAdvisor: vi.fn(async () => ADVISOR_ANSWER),
    ...overrides,
  };
}

/** Mount the AI router alone, standing in for the requireAdmin-protected apiRouter. */
function makeApp(client: CodexRuntimeClient, configured = true) {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", createAiRouter({ client, isConfigured: () => configured }));
  return app;
}

function makeOwnerApiApp() {
  const app = express();
  app.use("/api", apiRouter);
  return app;
}

let client: CodexRuntimeClient;

beforeEach(() => {
  client = fakeClient();
  flags.AI_ADVISOR_ENABLED = true;
  flags.AI_DRAFTS_ENABLED = true;
  flags.AI_FOLLOW_UPS_ENABLED = false;
  flags.AI_SEND_ENABLED = false;
});

describe("aiRouter", () => {
  it("returns only the server-controlled AI capabilities", async () => {
    await request(makeApp(client)).get("/api/ai/capabilities").expect(200, {
      draftsEnabled: true,
      followUpsEnabled: false,
      sendEnabled: false,
    });
  });

  it.each([
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true],
  ])(
    "reflects capability flags drafts=%s follow-ups=%s send=%s",
    async (draftsEnabled, followUpsEnabled, sendEnabled) => {
      flags.AI_DRAFTS_ENABLED = draftsEnabled;
      flags.AI_FOLLOW_UPS_ENABLED = followUpsEnabled;
      flags.AI_SEND_ENABLED = sendEnabled;

      const response = await request(makeApp(client)).get("/api/ai/capabilities").expect(200);

      expect(response.body).toEqual({ draftsEnabled, followUpsEnabled, sendEnabled });
      expect(Object.keys(response.body).sort()).toEqual([
        "draftsEnabled",
        "followUpsEnabled",
        "sendEnabled",
      ]);
      expect(client.getConnectionStatus).not.toHaveBeenCalled();
    },
  );

  it("is protected by the real owner-authenticated API router", async () => {
    await request(makeOwnerApiApp())
      .get("/api/ai/capabilities")
      .expect(401, { error: "missing_bearer_token" });
  });

  it("keeps capabilities available when the runtime itself is unavailable", async () => {
    await request(makeApp(client, false)).get("/api/ai/capabilities").expect(200, {
      draftsEnabled: true,
      followUpsEnabled: false,
      sendEnabled: false,
    });
  });

  it("returns the owner's connection status", async () => {
    const response = await request(makeApp(client)).get("/api/ai/connection").expect(200);

    expect(response.body).toEqual({
      connected: true,
      requiresOpenaiAuth: false,
      account: { email: "owner@example.com", planType: "plus" },
      rateLimits: { usedPercent: 12, resetsAt: 1785888000 },
    });
  });

  it("forwards an explicit refresh to the runtime", async () => {
    await request(makeApp(client)).get("/api/ai/connection?refresh=true").expect(200);
    expect(client.getConnectionStatus).toHaveBeenCalledWith(true);
  });

  it("starts a device login", async () => {
    await request(makeApp(client)).post("/api/ai/connection").expect(200, {
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
    expect(client.startDeviceLogin).toHaveBeenCalledOnce();
  });

  it("disconnects with no content", async () => {
    await request(makeApp(client)).post("/api/ai/disconnect").expect(204);
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("returns ai_not_configured when the runtime is unset", async () => {
    const app = makeApp(client, false);

    await request(app).get("/api/ai/connection").expect(503, { error: "ai_not_configured" });
    await request(app).post("/api/ai/connection").expect(503, { error: "ai_not_configured" });
    await request(app).post("/api/ai/disconnect").expect(503, { error: "ai_not_configured" });
    expect(client.getConnectionStatus).not.toHaveBeenCalled();
  });

  it("maps a runtime rate limit to 429 without echoing runtime detail", async () => {
    const retryAt = new Date("2026-08-04T12:00:00.000Z");
    const app = makeApp(
      fakeClient({
        getConnectionStatus: vi.fn(async () => {
          throw new CodexRuntimeError("runtime_rate_limited", 429, retryAt);
        }),
      }),
    );

    const response = await request(app).get("/api/ai/connection").expect(429);
    expect(response.body).toEqual({
      error: "runtime_rate_limited",
      retryAt: retryAt.toISOString(),
    });
  });

  it("maps runtime unavailability to 503", async () => {
    const app = makeApp(
      fakeClient({
        getConnectionStatus: vi.fn(async () => {
          throw new CodexRuntimeError("runtime_unavailable", 503, null);
        }),
      }),
    );

    await request(app)
      .get("/api/ai/connection")
      .expect(503, { error: "runtime_unavailable", retryAt: null });
  });

  it("never leaks an unexpected error message to the browser", async () => {
    const app = makeApp(
      fakeClient({
        getConnectionStatus: vi.fn(async () => {
          throw new Error("runtime said token sk-leaked-value is invalid");
        }),
      }),
    );

    const response = await request(app).get("/api/ai/connection").expect(502);
    expect(response.body).toEqual({ error: "ai_runtime_error" });
    expect(JSON.stringify(response.body)).not.toMatch(/sk-leaked-value/);
  });
});

describe("advisor routes", () => {
  const ASK = { message: "What should I focus on?", clientMessageId: "msg-1" };

  it("keeps the advisor disabled until its rollout flag is enabled", async () => {
    flags.AI_ADVISOR_ENABLED = false;
    const app = makeApp(client);

    await request(app)
      .post("/api/ai/advisor/messages")
      .send(ASK)
      .expect(403, { error: "ai_advisor_disabled" });
    await request(app)
      .get("/api/ai/advisor/history")
      .expect(403, { error: "ai_advisor_disabled" });
    expect(client.askAdvisor).not.toHaveBeenCalled();
    expect(client.getAdvisorHistory).not.toHaveBeenCalled();
  });

  it("returns the structured answer when enabled", async () => {
    const response = await request(makeApp(client))
      .post("/api/ai/advisor/messages")
      .send(ASK)
      .expect(200);
    expect(response.body).toEqual(ADVISOR_ANSWER);
    expect(client.askAdvisor).toHaveBeenCalledWith(ASK);
  });

  // An extra key is an attempt to widen the request the runtime receives, so it is
  // rejected rather than stripped and forwarded.
  it("forwards only the validated owner question", async () => {
    const app = makeApp(client);
    await request(app)
      .post("/api/ai/advisor/messages")
      .send({ ...ASK, tool: "send" })
      .expect(400);
    expect(client.askAdvisor).not.toHaveBeenCalled();
  });

  // The browser distinguishes "still confirming" from "failed"; a 503 would erase
  // that distinction and its retry would ask the model a second time.
  it.each(["advisor_outcome_pending", "idempotency_conflict"] as const)(
    "passes %s through as 409",
    async (code) => {
      const failing = {
        ...client,
        askAdvisor: vi.fn(async () => {
          throw new CodexRuntimeError(code, 409);
        }),
      };

      await request(makeApp(failing))
        .post("/api/ai/advisor/messages")
        .send(ASK)
        .expect(409, { error: code, retryAt: null });
    },
  );

  it("rejects an empty or oversized question", async () => {
    const app = makeApp(client);
    await request(app).post("/api/ai/advisor/messages").send({ ...ASK, message: "" }).expect(400);
    await request(app)
      .post("/api/ai/advisor/messages")
      .send({ ...ASK, message: "x".repeat(2001) })
      .expect(400);
    await request(app).post("/api/ai/advisor/messages").send({ message: "hi" }).expect(400);
    expect(client.askAdvisor).not.toHaveBeenCalled();
  });

  it("returns history items", async () => {
    const app = makeApp(
      fakeClient({
        getAdvisorHistory: vi.fn(async () => [
          { role: "user" as const, clientMessageId: "msg-1", text: "hi", response: null },
          {
            role: "assistant" as const,
            clientMessageId: "msg-1",
            text: null,
            response: ADVISOR_ANSWER,
          },
        ]),
      }),
    );
    const response = await request(app).get("/api/ai/advisor/history").expect(200);
    expect(response.body.items).toHaveLength(2);
  });

  it("returns ai_not_configured before checking the advisor flag", async () => {
    const app = makeApp(client, false);
    await request(app)
      .post("/api/ai/advisor/messages")
      .send(ASK)
      .expect(503, { error: "ai_not_configured" });
  });

  it("maps an advisor usage limit to 429 with retryAt", async () => {
    const retryAt = new Date("2026-08-04T12:00:00.000Z");
    const app = makeApp(
      fakeClient({
        askAdvisor: vi.fn(async () => {
          throw new CodexRuntimeError("runtime_rate_limited", 429, retryAt);
        }),
      }),
    );
    const response = await request(app).post("/api/ai/advisor/messages").send(ASK).expect(429);
    expect(response.body).toEqual({
      error: "runtime_rate_limited",
      retryAt: retryAt.toISOString(),
    });
  });

  it("never leaks runtime detail from an advisor failure", async () => {
    const app = makeApp(
      fakeClient({
        askAdvisor: vi.fn(async () => {
          throw new Error('relation "ig_token" at postgres://user:pw@host/db');
        }),
      }),
    );
    const response = await request(app).post("/api/ai/advisor/messages").send(ASK).expect(502);
    expect(response.body).toEqual({ error: "ai_runtime_error" });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:\/\/|ig_token/);
  });
});
