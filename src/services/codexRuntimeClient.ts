import { z } from "zod";

/**
 * The API's only door into the private Codex runtime.
 *
 * The runtime is a separate Railway service reached over the private network. It
 * holds the ChatGPT OAuth state and never sees this app's database, Supabase or
 * Instagram credentials — so everything crossing this boundary is validated on
 * the way back in, and no runtime response detail is ever forwarded verbatim to
 * the browser.
 */

export type CodexRuntimeErrorCode =
  | "ai_not_configured"
  | "runtime_unauthorized"
  | "runtime_rate_limited"
  | "runtime_unavailable"
  | "runtime_timeout"
  | "invalid_runtime_response";

export class CodexRuntimeError extends Error {
  readonly code: CodexRuntimeErrorCode;
  readonly status: number | null;
  /** When the caller may retry. Only a 429 with a usable retry-after sets this. */
  readonly retryAt: Date | null;

  constructor(code: CodexRuntimeErrorCode, status: number | null = null, retryAt: Date | null = null) {
    super(code);
    this.name = "CodexRuntimeError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

const connectionStatusSchema = z.object({
  connected: z.boolean(),
  requiresOpenaiAuth: z.boolean(),
  account: z
    .object({ email: z.string().nullable(), planType: z.string() })
    .nullable(),
  rateLimits: z
    .object({ usedPercent: z.number().nullable(), resetsAt: z.number().nullable() })
    .nullable(),
});

const loginStartSchema = z.object({
  loginId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string().url(),
});

export type AiConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type AiLoginStart = z.infer<typeof loginStartSchema>;

export interface CodexRuntimeClient {
  getConnectionStatus(refresh?: boolean): Promise<AiConnectionStatus>;
  startDeviceLogin(): Promise<AiLoginStart>;
  disconnect(): Promise<void>;
}

export interface CodexRuntimeClientConfig {
  baseUrl: string | undefined;
  token: string | undefined;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Map a retry-after header (delta-seconds or HTTP date) to an absolute instant. */
function parseRetryAfter(header: string | null): Date | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : new Date(at);
}

export function createCodexRuntimeClient(config: CodexRuntimeClientConfig): CodexRuntimeClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    path: string,
    method: "GET" | "POST",
    schema: z.ZodType<T> | null,
  ): Promise<T | undefined> {
    // Checked before any network work so a misconfigured deploy fails fast and
    // identically on every route, rather than timing out against nothing.
    if (!config.baseUrl || !config.token) throw new CodexRuntimeError("ai_not_configured");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new CodexRuntimeError("runtime_timeout");
      }
      throw new CodexRuntimeError("runtime_unavailable");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new CodexRuntimeError("runtime_unauthorized", response.status);
      }
      if (response.status === 429) {
        throw new CodexRuntimeError(
          "runtime_rate_limited",
          429,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      throw new CodexRuntimeError("runtime_unavailable", response.status);
    }

    if (!schema) return undefined;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CodexRuntimeError("invalid_runtime_response", response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new CodexRuntimeError("invalid_runtime_response", response.status);
    return parsed.data;
  }

  return {
    async getConnectionStatus(refresh = false) {
      const path = refresh
        ? "/internal/account/status?refresh=true"
        : "/internal/account/status";
      return (await call(path, "GET", connectionStatusSchema)) as AiConnectionStatus;
    },
    async startDeviceLogin() {
      return (await call("/internal/account/login/start", "POST", loginStartSchema)) as AiLoginStart;
    },
    async disconnect() {
      await call("/internal/account/logout", "POST", null);
    },
  };
}
