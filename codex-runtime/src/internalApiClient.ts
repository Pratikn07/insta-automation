import { z } from "zod";
import type { RuntimeConfig } from "./config.js";

/**
 * The runtime's only way to reach Tiny SOHO data.
 *
 * `callTool` is a SWITCH over three literal names. There is deliberately no
 * generic `get(path)` method: if the model asks for a tool that is not one of
 * these three, there is no code path that could serve it. Arguments are validated
 * against the same bounds the API enforces, so a malformed call fails here rather
 * than becoming a 400 the model then tries to work around.
 */

export const ADVISOR_TOOL_NAMES = [
  "business_overview",
  "keyword_guide_catalog",
  "conversation_summary",
] as const;

export type AdvisorToolName = (typeof ADVISOR_TOOL_NAMES)[number];

export function isAdvisorToolName(name: string): name is AdvisorToolName {
  return (ADVISOR_TOOL_NAMES as readonly string[]).includes(name);
}

const windowArgs = z.object({ windowDays: z.union([z.literal(7), z.literal(30)]) }).strict();
const catalogArgs = z.object({ limit: z.number().int().min(1).max(100) }).strict();
const summaryArgs = z
  .object({
    windowDays: z.union([z.literal(7), z.literal(30)]),
    limit: z.number().int().min(1).max(25),
  })
  .strict();

// Response shapes are validated too: the runtime must not hand a model something
// structurally unexpected just because the API returned 200.
const overviewResult = z
  .object({
    windowDays: z.number(),
    guideDeliveries: z.number().nullable(),
    inboundDmCount: z.number().nullable(),
    needsReplyCount: z.number().nullable(),
    approvedReplyCount: z.number().nullable(),
    replyRatePct: z.number().nullable(),
    topKeyword: z.object({ keyword: z.string(), triggers: z.number() }).nullable(),
    capturedAt: z.string(),
  })
  .passthrough();

const catalogResult = z.object({ items: z.array(z.record(z.unknown())) }).passthrough();
const summaryResult = z
  .object({
    windowDays: z.number(),
    totals: z.record(z.number()),
    threads: z.array(z.record(z.unknown())),
  })
  .passthrough();

export type InternalApiErrorCode =
  | "advisor_not_configured"
  | "invalid_tool_arguments"
  | "unknown_tool"
  | "internal_api_timeout"
  | "internal_api_unavailable";

export class InternalApiError extends Error {
  readonly code: InternalApiErrorCode;
  constructor(code: InternalApiErrorCode) {
    super(code);
    this.name = "InternalApiError";
    this.code = code;
  }
}

export interface InternalApiClient {
  callTool(name: string, args: unknown): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

export function createInternalApiClient(config: RuntimeConfig): InternalApiClient {
  async function post<T>(tool: AdvisorToolName, body: unknown, schema: z.ZodType<T>): Promise<T> {
    if (!config.TINY_SOHO_API_URL || !config.TINY_SOHO_INTERNAL_TOKEN) {
      throw new InternalApiError("advisor_not_configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${config.TINY_SOHO_API_URL}/internal/ai/tools/${tool}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.TINY_SOHO_INTERNAL_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new InternalApiError("internal_api_timeout");
      }
      throw new InternalApiError("internal_api_unavailable");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new InternalApiError("internal_api_unavailable");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new InternalApiError("internal_api_unavailable");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new InternalApiError("internal_api_unavailable");
    return parsed.data;
  }

  return {
    async callTool(name: string, args: unknown): Promise<unknown> {
      // A switch, not a lookup table with a fallthrough: an unregistered name has
      // nowhere to go.
      switch (name) {
        case "business_overview": {
          const parsed = windowArgs.safeParse(args);
          if (!parsed.success) throw new InternalApiError("invalid_tool_arguments");
          return post("business_overview", parsed.data, overviewResult);
        }
        case "keyword_guide_catalog": {
          const parsed = catalogArgs.safeParse(args);
          if (!parsed.success) throw new InternalApiError("invalid_tool_arguments");
          return post("keyword_guide_catalog", parsed.data, catalogResult);
        }
        case "conversation_summary": {
          const parsed = summaryArgs.safeParse(args);
          if (!parsed.success) throw new InternalApiError("invalid_tool_arguments");
          return post("conversation_summary", parsed.data, summaryResult);
        }
        default:
          throw new InternalApiError("unknown_tool");
      }
    },
  };
}
