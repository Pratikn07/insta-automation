import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AccountService } from "./accountService.js";
import type { DraftService } from "./draftService.js";
import { DraftGenerationError } from "./draftService.js";
import { createRuntimeApp } from "./app.js";

const SECRET = "r".repeat(32);

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

function makeApp(
  service = fakeAccountService(),
  appServerReady = () => true,
  draftService = fakeDraftService(),
) {
  return createRuntimeApp({
    accountService: service,
    draftService,
    runtimeSecret: SECRET,
    appServerReady,
  });
}

const VALID_DRAFT_BODY = {
  requestId: "11111111-1111-1111-1111-111111111111",
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
