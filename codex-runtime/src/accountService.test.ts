import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "./appServerClient.js";
import { createAccountService } from "./accountService.js";

function fakeAppServer(request: AppServerClient["request"]): AppServerClient {
  return {
    request,
    notify: vi.fn(),
    onNotification: vi.fn(() => () => undefined),
    onRequest: vi.fn(() => () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("createAccountService", () => {
  it("starts managed ChatGPT device-code login", async () => {
    const request = vi.fn().mockResolvedValue({
      type: "chatgptDeviceCode",
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.startDeviceLogin()).resolves.toEqual({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
    expect(request).toHaveBeenCalledWith("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
  });

  it("never asks for an API-key login type", async () => {
    const request = vi.fn().mockResolvedValue({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
    const service = createAccountService(fakeAppServer(request as never));
    await service.startDeviceLogin();

    const [, params] = request.mock.calls[0] ?? [];
    expect(params).toEqual({ type: "chatgptDeviceCode" });
    expect(JSON.stringify(params)).not.toMatch(/apiKey|api_key/i);
  });

  it("reports disconnected without reading rate limits when no account exists", async () => {
    const request = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: true });
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.status()).resolves.toEqual({
      connected: false,
      requiresOpenaiAuth: true,
      account: null,
      rateLimits: null,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false }, 30_000);
  });

  it("forwards an explicit token refresh", async () => {
    const request = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false });
    const service = createAccountService(fakeAppServer(request as never));
    await service.status(true);

    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: true }, 30_000);
  });

  it("maps a connected ChatGPT account and its rate limits", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return {
          requiresOpenaiAuth: false,
          account: { type: "chatgpt", email: "owner@example.com", planType: "plus" },
        };
      }
      return { primary: { usedPercent: 42.5, resetsAt: 1_760_000_000 } };
    });
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.status()).resolves.toEqual({
      connected: true,
      requiresOpenaiAuth: false,
      account: { email: "owner@example.com", planType: "plus" },
      rateLimits: { usedPercent: 42.5, resetsAt: 1_760_000_000 },
    });
    expect(request).toHaveBeenCalledWith("account/rateLimits/read", {}, 30_000);
  });

  it("preserves nulls rather than inventing quota", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { requiresOpenaiAuth: false, account: { type: "chatgpt", email: null, planType: "pro" } };
      }
      return {};
    });
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.status()).resolves.toMatchObject({
      connected: true,
      account: { email: null, planType: "pro" },
      rateLimits: { usedPercent: null, resetsAt: null },
    });
  });

  it("degrades to null rate limits when the snapshot read fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { requiresOpenaiAuth: false, account: { type: "chatgpt", email: "a@b.c", planType: "plus" } };
      }
      throw new Error("account/rateLimits/read failed");
    });
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.status()).resolves.toMatchObject({ connected: true, rateLimits: null });
  });

  it("does not read rate limits for a non-ChatGPT account", async () => {
    const request = vi.fn().mockResolvedValue({
      requiresOpenaiAuth: false,
      account: { type: "apiKey", email: null, planType: "unknown" },
    });
    const service = createAccountService(fakeAppServer(request as never));
    await service.status();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("logs out through app-server", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const service = createAccountService(fakeAppServer(request as never));

    await expect(service.logout()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("account/logout", {}, 30_000);
  });
});
