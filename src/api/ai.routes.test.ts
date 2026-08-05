import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeError } from "../services/codexRuntimeClient.js";
import type { CodexRuntimeClient } from "../services/codexRuntimeClient.js";
import { createAiRouter } from "./ai.routes.js";

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

let client: CodexRuntimeClient;

beforeEach(() => {
  client = fakeClient();
});

describe("aiRouter", () => {
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
