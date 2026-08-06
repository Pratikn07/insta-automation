import { z } from "zod";
import { env } from "../config/env.js";

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

const draftSuggestionSchema = z.object({
  reply: z.string().min(1),
  rationale: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  warnings: z.array(z.string()),
  modelId: z.string().nullable(),
});

/**
 * The advisor's navigation targets, closed on this side too.
 *
 * The runtime already constrains these, but this client is the boundary the
 * browser trusts: if a future runtime ever emitted an arbitrary URL, it must not
 * become a link the owner can click.
 */
const ADVISOR_HREFS = ["/conversations", "/insights", "/keywords", "/sequences"] as const;

const advisorResponseSchema = z.object({
  answer: z.string().min(1),
  recommendation: z.string().min(1),
  evidence: z.array(
    z.object({
      label: z.string().min(1),
      value: z.string().min(1),
      href: z.enum(ADVISOR_HREFS).nullable(),
    }),
  ),
  confidence: z.enum(["low", "medium", "high"]),
  nextStep: z.string().min(1),
  nextStepHref: z.enum(ADVISOR_HREFS).nullable(),
  dataGaps: z.array(z.string()),
});

const advisorHistorySchema = z.object({
  items: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      clientMessageId: z.string().nullable(),
      text: z.string().nullable(),
      response: advisorResponseSchema.nullable(),
    }),
  ),
});

export type AiConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type AiLoginStart = z.infer<typeof loginStartSchema>;
export type DmDraftSuggestion = z.infer<typeof draftSuggestionSchema>;
export type AdvisorResponse = z.infer<typeof advisorResponseSchema>;
export type AdvisorHistoryItem = z.infer<typeof advisorHistorySchema>["items"][number];

export interface AdvisorAsk {
  message: string;
  clientMessageId: string;
}

/** The request sent to the runtime's drafter. Shape mirrors runtime schemas.ts. */
export interface DmDraftRequest {
  requestId: string;
  kind: "reply" | "engagement_follow_up";
  promptVersion: 2;
  guideDeliveredAt: string | null;
  participant: { igUserId: string; username: string | null; name: string | null };
  messages: Array<{
    direction: "inbound" | "outbound";
    text: string | null;
    messageType: "text" | "image" | "video" | "audio" | "file" | "unknown";
    source: string;
    at: string;
  }>;
  brandVoice: string;
  guideContext: null | { keyword: string; resourceName: string; description: string | null };
}

export interface CodexRuntimeClient {
  getConnectionStatus(refresh?: boolean): Promise<AiConnectionStatus>;
  startDeviceLogin(): Promise<AiLoginStart>;
  disconnect(): Promise<void>;
  generateDmDraft(input: DmDraftRequest): Promise<DmDraftSuggestion>;
  getAdvisorHistory(): Promise<AdvisorHistoryItem[]>;
  askAdvisor(input: AdvisorAsk): Promise<AdvisorResponse>;
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
    body?: unknown,
  ): Promise<T | undefined> {
    // Checked before any network work so a misconfigured deploy fails fast and
    // identically on every route, rather than timing out against nothing.
    if (!config.baseUrl || !config.token) throw new CodexRuntimeError("ai_not_configured");

    // A draft turn can take most of a minute; a status check should not. Callers
    // pass a longer timeout for generation via config.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CodexRuntimeError("invalid_runtime_response", response.status);
    }
    const parsed = schema.safeParse(payload);
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
    async generateDmDraft(input: DmDraftRequest) {
      return (await call(
        "/internal/drafts/generate",
        "POST",
        draftSuggestionSchema,
        input,
      )) as DmDraftSuggestion;
    },
    async getAdvisorHistory() {
      const payload = (await call(
        "/internal/advisor/history",
        "GET",
        advisorHistorySchema,
      )) as z.infer<typeof advisorHistorySchema>;
      return payload.items;
    },
    async askAdvisor(input: AdvisorAsk) {
      // Only the two validated fields are forwarded: the runtime's request schema
      // is strict, and an extra key here would be a widening attempt.
      return (await call("/internal/advisor/messages", "POST", advisorResponseSchema, {
        message: input.message,
        clientMessageId: input.clientMessageId,
      })) as AdvisorResponse;
    },
  };
}

/**
 * The process-wide runtime client, configured from env. A draft turn can run for
 * most of a minute, so the timeout is generous — well past the runtime's own 90s
 * turn cap would be pointless, but the default 15s is far too short for a turn.
 */
export const runtimeClient: CodexRuntimeClient = createCodexRuntimeClient({
  baseUrl: env.CODEX_RUNTIME_URL,
  token: env.CODEX_RUNTIME_TOKEN,
  timeoutMs: 100_000,
});
