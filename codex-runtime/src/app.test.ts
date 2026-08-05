import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AccountService } from "./accountService.js";
import type { AdvisorService } from "./advisorService.js";
import { AdvisorError } from "./advisorService.js";
import type { DraftService } from "./draftService.js";
import { DraftGenerationError } from "./draftService.js";
import { createRuntimeApp } from "./app.js";

const SECRET = "r".repeat(32);

const ADVISOR_ANSWER = {
  answer: "Reply rate is the thing to fix first.",
  recommendation: "Clear the needs-reply queue this week.",
  evidence: [{ label: "Needs reply", value: "3 threads", href: "/conversations" }],
  confidence: "medium" as const,
  nextStep: "Open Conversations.",
  nextStepHref: "/conversations" as const,
  dataGaps: [],
};

function fakeAccountService(overrides: Partial<AccountService> = {}): AccountService {
  return {
    status: vi.fn(async () => ({
      connected: true,
      requiresOpenaiAuth: false,
      account: { email: "owner@example.com", planType: "plus" },
      rateLimits: { usedPercent: 10, resetsAt: 1_760_000_000 },
    })),
    startDeviceLogin: vi.fn(async () => ({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeDraftService(overrides: Partial<DraftService> = {}): DraftService {
  return {
    generate: vi.fn(async () => ({
      reply: "Most toddlers hold onto a nap until around 3 💛",
      rationale: "Answers directly, warm tone.",
      confidence: "high" as const,
      warnings: [],
      modelId: "codex-default",
    })),
    ...overrides,
  };
}

function fakeAdvisorService(overrides: Partial<AdvisorService> = {}): AdvisorService {
  return {
    ask: vi.fn(async () => ADVISOR_ANSWER),
    history: vi.fn(async () => []),
    ...overrides,
  };
}

function makeApp(
  service = fakeAccountService(),
  appServerReady = () => true,
  draftService = fakeDraftService(),
  advisorService = fakeAdvisorService(),
) {
  return createRuntimeApp({
    accountService: service,
    draftService,
    advisorService,
    runtimeSecret: SECRET,
    appServerReady,
  });
}

function advisorApp(advisorService: AdvisorService) {
  return makeApp(fakeAccountService(), () => true, fakeDraftService(), advisorService);
}

const VALID_DRAFT_BODY = {
  requestId: "11111111-1111-1111-1111-111111111111",
  kind: "reply",
  promptVersion: 2,
  guideDeliveredAt: null,
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "inbound",
      text: "How old before dropping the nap?",
      messageType: "text",
      source: "instagram_user",
      at: "2026-08-04T10:00:00.000Z",
    },
  ],
  brandVoice: "Warm, practical, concise.",
  guideContext: null,
};

function draftReq(app: ReturnType<typeof makeApp>) {
  return request(app)
    .post("/internal/drafts/generate")
    .set("authorization", `Bearer ${SECRET}`);
}

describe("createRuntimeApp", () => {
  it("exposes health without authentication", async () => {
    await request(makeApp()).get("/health").expect(200, { ok: true, appServerReady: true });
  });

  it("reports app-server readiness in health", async () => {
    await request(makeApp(fakeAccountService(), () => false))
      .get("/health")
      .expect(200, { ok: true, appServerReady: false });
  });

  it("rejects a missing runtime bearer token", async () => {
    await request(makeApp()).get("/internal/account/status").expect(401, { error: "unauthorized" });
  });

  it("rejects an incorrect runtime bearer token", async () => {
    await request(makeApp())
      .get("/internal/account/status")
      .set("authorization", `Bearer ${"w".repeat(32)}`)
      .expect(401, { error: "unauthorized" });
  });

  it("rejects a token of a different length without leaking timing", async () => {
    await request(makeApp())
      .get("/internal/account/status")
      .set("authorization", "Bearer short")
      .expect(401, { error: "unauthorized" });
  });

  it("returns connection status to an authorized caller", async () => {
    const response = await request(makeApp())
      .get("/internal/account/status")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(response.body).toEqual({
      connected: true,
      requiresOpenaiAuth: false,
      account: { email: "owner@example.com", planType: "plus" },
      rateLimits: { usedPercent: 10, resetsAt: 1_760_000_000 },
    });
  });

  it("forwards the refresh flag from the query string", async () => {
    const service = fakeAccountService();
    await request(makeApp(service))
      .get("/internal/account/status?refresh=true")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(service.status).toHaveBeenCalledWith(true);
  });

  it("returns only device-code display fields", async () => {
    const response = await request(makeApp())
      .post("/internal/account/login/start")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(response.body).toEqual({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/token|secret/i);
  });

  it("logs out with no content", async () => {
    const service = fakeAccountService();
    await request(makeApp(service))
      .post("/internal/account/logout")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(204);

    expect(service.logout).toHaveBeenCalledTimes(1);
  });

  it("never leaks an app-server error message to the caller", async () => {
    const service = fakeAccountService({
      status: vi.fn(async () => {
        throw new Error("account/read failed: token sk-secret-value expired");
      }),
    });
    const response = await request(makeApp(service))
      .get("/internal/account/status")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(502);

    expect(response.body).toEqual({ error: "app_server_unavailable" });
    expect(JSON.stringify(response.body)).not.toMatch(/sk-secret-value/);
  });

  it("refuses internal routes while app-server is not ready", async () => {
    await request(makeApp(fakeAccountService(), () => false))
      .get("/internal/account/status")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(503, { error: "app_server_not_ready" });
  });
});

describe("POST /internal/drafts/generate", () => {
  it("requires the runtime bearer token", async () => {
    await request(makeApp())
      .post("/internal/drafts/generate")
      .send(VALID_DRAFT_BODY)
      .expect(401, { error: "unauthorized" });
  });

  it("returns the suggestion for a valid request", async () => {
    const response = await draftReq(makeApp()).send(VALID_DRAFT_BODY).expect(200);
    expect(response.body).toMatchObject({ reply: expect.any(String), confidence: "high" });
  });

  it("rejects a malformed request body with 400", async () => {
    await draftReq(makeApp())
      .send({ ...VALID_DRAFT_BODY, requestId: "not-a-uuid" })
      .expect(400);
  });

  it("rejects an empty transcript with 400", async () => {
    await draftReq(makeApp())
      .send({ ...VALID_DRAFT_BODY, messages: [] })
      .expect(400);
  });

  it("maps a usage limit to 429 with a nullable retryAt", async () => {
    const resetAt = new Date("2026-08-04T12:00:00.000Z");
    const app = makeApp(
      fakeAccountService(),
      () => true,
      fakeDraftService({
        generate: vi.fn(async () => {
          throw new DraftGenerationError("usage_limited", resetAt);
        }),
      }),
    );
    const response = await draftReq(app).send(VALID_DRAFT_BODY).expect(429);
    expect(response.body).toEqual({ error: "usage_limited", retryAt: resetAt.toISOString() });
  });

  it("maps a turn timeout to 504", async () => {
    const app = makeApp(
      fakeAccountService(),
      () => true,
      fakeDraftService({
        generate: vi.fn(async () => {
          throw new DraftGenerationError("turn_timeout");
        }),
      }),
    );
    await draftReq(app).send(VALID_DRAFT_BODY).expect(504, { error: "turn_timeout", retryAt: null });
  });

  it("maps an unauthenticated app-server to 401", async () => {
    const app = makeApp(
      fakeAccountService(),
      () => true,
      fakeDraftService({
        generate: vi.fn(async () => {
          throw new DraftGenerationError("app_server_unauthenticated");
        }),
      }),
    );
    await draftReq(app).send(VALID_DRAFT_BODY).expect(401, {
      error: "app_server_unauthenticated",
      retryAt: null,
    });
  });

  it("maps any other draft failure to 503 without leaking detail", async () => {
    const app = makeApp(
      fakeAccountService(),
      () => true,
      fakeDraftService({
        generate: vi.fn(async () => {
          throw new Error("app-server said token sk-secret is invalid");
        }),
      }),
    );
    const response = await draftReq(app).send(VALID_DRAFT_BODY).expect(503);
    expect(response.body).toEqual({ error: "draft_unavailable", retryAt: null });
    expect(JSON.stringify(response.body)).not.toMatch(/sk-secret/);
  });
});

function askReq(app: ReturnType<typeof makeApp>) {
  return request(app)
    .post("/internal/advisor/messages")
    .set("authorization", `Bearer ${SECRET}`);
}

const VALID_ASK = { message: "What should I focus on?", clientMessageId: "msg-1" };

describe("POST /internal/advisor/messages", () => {
  it("requires the runtime bearer token", async () => {
    await request(makeApp())
      .post("/internal/advisor/messages")
      .send(VALID_ASK)
      .expect(401, { error: "unauthorized" });
  });

  it("returns the structured answer", async () => {
    const response = await askReq(makeApp()).send(VALID_ASK).expect(200);
    expect(response.body).toEqual(ADVISOR_ANSWER);
  });

  it("passes the owner's message and id through", async () => {
    const advisor = fakeAdvisorService();
    await askReq(advisorApp(advisor)).send(VALID_ASK).expect(200);
    expect(advisor.ask).toHaveBeenCalledWith(VALID_ASK);
  });

  it("rejects an empty message with 400", async () => {
    await askReq(makeApp()).send({ ...VALID_ASK, message: "" }).expect(400);
  });

  it("rejects a missing clientMessageId with 400", async () => {
    await askReq(makeApp()).send({ message: "hello" }).expect(400);
  });

  it("maps a usage limit to 429 with retryAt", async () => {
    const resetAt = new Date("2026-08-04T12:00:00.000Z");
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new AdvisorError("usage_limited", resetAt);
        }),
      }),
    );
    const response = await askReq(app).send(VALID_ASK).expect(429);
    expect(response.body).toEqual({ error: "usage_limited", retryAt: resetAt.toISOString() });
  });

  it("maps a disconnected ChatGPT account to 401", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new AdvisorError("not_connected");
        }),
      }),
    );
    await askReq(app).send(VALID_ASK).expect(401, { error: "not_connected", retryAt: null });
  });

  it("maps unconfigured data tools to 503", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new AdvisorError("advisor_not_configured");
        }),
      }),
    );
    await askReq(app)
      .send(VALID_ASK)
      .expect(503, { error: "advisor_not_configured", retryAt: null });
  });

  it("maps a turn timeout to 504", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new AdvisorError("turn_timeout");
        }),
      }),
    );
    await askReq(app).send(VALID_ASK).expect(504, { error: "turn_timeout", retryAt: null });
  });

  it("maps invalid advisor output to 503", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new AdvisorError("invalid_advisor_output");
        }),
      }),
    );
    await askReq(app)
      .send(VALID_ASK)
      .expect(503, { error: "invalid_advisor_output", retryAt: null });
  });

  it("maps an unexpected failure to 503 without leaking detail", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        ask: vi.fn(async () => {
          throw new Error('relation "ig_token" at postgres://user:pw@host/db');
        }),
      }),
    );
    const response = await askReq(app).send(VALID_ASK).expect(503);
    expect(response.body).toEqual({ error: "advisor_unavailable", retryAt: null });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:\/\/|ig_token/);
  });

  it("refuses while app-server is not ready", async () => {
    const app = makeApp(fakeAccountService(), () => false);
    await request(app)
      .post("/internal/advisor/messages")
      .set("authorization", `Bearer ${SECRET}`)
      .send(VALID_ASK)
      .expect(503, { error: "app_server_not_ready" });
  });
});

describe("GET /internal/advisor/history", () => {
  it("requires the runtime bearer token", async () => {
    await request(makeApp())
      .get("/internal/advisor/history")
      .expect(401, { error: "unauthorized" });
  });

  it("returns the stored conversation", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        history: vi.fn(async () => [
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
    const response = await request(app)
      .get("/internal/advisor/history")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[1].response).toEqual(ADVISOR_ANSWER);
  });

  // History is a convenience: an empty chat is a better failure than an error page.
  it("returns an empty list rather than an error when history is unreadable", async () => {
    const app = advisorApp(
      fakeAdvisorService({
        history: vi.fn(async () => {
          throw new Error("thread/read failed for token sk-secret");
        }),
      }),
    );
    const response = await request(app)
      .get("/internal/advisor/history")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(response.body).toEqual({ items: [] });
    expect(JSON.stringify(response.body)).not.toMatch(/sk-secret/);
  });
});
