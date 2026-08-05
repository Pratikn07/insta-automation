import type { AppServerClient } from "./appServerClient.js";

const REQUEST_TIMEOUT_MS = 30_000;

export interface ConnectionStatus {
  connected: boolean;
  requiresOpenaiAuth: boolean;
  account: null | { email: string | null; planType: string };
  rateLimits: null | { usedPercent: number | null; resetsAt: number | null };
}

export interface DeviceLoginStart {
  loginId: string;
  userCode: string;
  verificationUrl: string;
}

export interface AccountService {
  status(refreshToken?: boolean): Promise<ConnectionStatus>;
  startDeviceLogin(): Promise<DeviceLoginStart>;
  logout(): Promise<void>;
}

interface AccountReadResult {
  requiresOpenaiAuth?: unknown;
  account?: { type?: unknown; email?: unknown; planType?: unknown } | null;
}

interface RateLimitsResult {
  primary?: { usedPercent?: unknown; resetsAt?: unknown } | null;
}

interface LoginStartResult {
  loginId?: unknown;
  userCode?: unknown;
  verificationUrl?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createAccountService(appServer: AppServerClient): AccountService {
  async function readRateLimits(): Promise<ConnectionStatus["rateLimits"]> {
    try {
      const snapshot = await appServer.request<RateLimitsResult>(
        "account/rateLimits/read",
        {},
        REQUEST_TIMEOUT_MS,
      );
      // Preserve nulls rather than inventing quota: an absent snapshot means
      // "unknown usage", which the UI must show as unknown, not as 0%.
      return {
        usedPercent: asFiniteNumber(snapshot?.primary?.usedPercent),
        resetsAt: asFiniteNumber(snapshot?.primary?.resetsAt),
      };
    } catch {
      // A quota read failure must not make a connected account look disconnected.
      return null;
    }
  }

  return {
    async status(refreshToken = false): Promise<ConnectionStatus> {
      const result = await appServer.request<AccountReadResult>(
        "account/read",
        { refreshToken },
        REQUEST_TIMEOUT_MS,
      );
      const requiresOpenaiAuth = result?.requiresOpenaiAuth === true;
      const account = result?.account ?? null;

      if (!account) {
        return { connected: false, requiresOpenaiAuth, account: null, rateLimits: null };
      }

      const planType = asString(account.planType) ?? "unknown";
      const mapped = { email: asString(account.email), planType };

      // Rate limits are a ChatGPT-subscription concept. Any other account type
      // (which this product never configures) gets no quota read at all.
      const isChatGpt = account.type === "chatgpt";
      return {
        connected: true,
        requiresOpenaiAuth,
        account: mapped,
        rateLimits: isChatGpt ? await readRateLimits() : null,
      };
    },

    async startDeviceLogin(): Promise<DeviceLoginStart> {
      // `chatgptDeviceCode` is the only login type this product uses: it binds the
      // owner's ChatGPT subscription and never an OpenAI API key.
      const result = await appServer.request<LoginStartResult>(
        "account/login/start",
        { type: "chatgptDeviceCode" },
        REQUEST_TIMEOUT_MS,
      );
      const loginId = asString(result?.loginId);
      const userCode = asString(result?.userCode);
      const verificationUrl = asString(result?.verificationUrl);
      if (!loginId || !userCode || !verificationUrl) {
        throw new Error("app-server returned an incomplete device-code login");
      }
      // Only display fields leave this method — no tokens, ever.
      return { loginId, userCode, verificationUrl };
    },

    async logout(): Promise<void> {
      await appServer.request("account/logout", {}, REQUEST_TIMEOUT_MS);
    },
  };
}
