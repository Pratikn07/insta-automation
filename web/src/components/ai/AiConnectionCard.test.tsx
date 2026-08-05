import { describe, expect, it } from "vitest";
import type { AiConnectionStatus } from "@/lib/types";
import { connectionView } from "./connectionView";

const connected: AiConnectionStatus = {
  connected: true,
  requiresOpenaiAuth: false,
  account: { email: "owner@example.com", planType: "plus" },
  rateLimits: { usedPercent: 12, resetsAt: 1785888000 },
};

const login = {
  loginId: "login-1",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://auth.openai.com/device",
};

describe("connectionView", () => {
  it("shows loading before the first status arrives", () => {
    expect(connectionView({ isLoading: true, error: null, status: undefined, login: null })).toEqual({
      kind: "loading",
    });
  });

  it("explains an unconfigured runtime distinctly from an unreachable one", () => {
    const unconfigured = connectionView({
      isLoading: false,
      error: { body: { error: "ai_not_configured" } },
      status: undefined,
      login: null,
    });
    const unreachable = connectionView({
      isLoading: false,
      error: { body: { error: "runtime_unavailable" } },
      status: undefined,
      login: null,
    });

    expect(unconfigured).toMatchObject({ kind: "unavailable" });
    expect(unreachable).toMatchObject({ kind: "unavailable" });
    expect((unconfigured as { reason: string }).reason).not.toBe(
      (unreachable as { reason: string }).reason,
    );
  });

  it("offers Connect when disconnected with no code outstanding", () => {
    expect(
      connectionView({
        isLoading: false,
        error: null,
        status: { connected: false, requiresOpenaiAuth: false, account: null, rateLimits: null },
        login: null,
      }),
    ).toEqual({ kind: "disconnected" });
  });

  it("shows the device code while a login is outstanding", () => {
    const view = connectionView({
      isLoading: false,
      error: null,
      status: { connected: false, requiresOpenaiAuth: false, account: null, rateLimits: null },
      login,
    });

    expect(view).toEqual({ kind: "awaiting-code", login });
    expect((view as { login: typeof login }).login.userCode).toBe("ABCD-EFGH");
  });

  it("prefers a completed connection over a stale outstanding code", () => {
    // The 3s poll notices the redemption; the code must not linger on screen.
    expect(connectionView({ isLoading: false, error: null, status: connected, login })).toEqual({
      kind: "connected",
      status: connected,
    });
  });

  it("never surfaces a token field in any view", () => {
    for (const view of [
      connectionView({ isLoading: false, error: null, status: connected, login: null }),
      connectionView({ isLoading: false, error: null, status: undefined, login }),
    ]) {
      expect(JSON.stringify(view)).not.toMatch(/accessToken|refreshToken|"token"|secret/i);
    }
  });
});
