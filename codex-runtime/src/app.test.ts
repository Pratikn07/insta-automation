import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AccountService } from "./accountService.js";
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

function makeApp(service = fakeAccountService(), appServerReady = () => true) {
  return createRuntimeApp({ accountService: service, runtimeSecret: SECRET, appServerReady });
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
