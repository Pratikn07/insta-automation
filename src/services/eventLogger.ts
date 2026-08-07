import { isAxiosError } from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Persist an event to the eventLog table. Logging must never break the webhook
 * flow, so any DB failure here is swallowed (and logged to stdout) rather than
 * thrown back into the handler.
 */
export async function logEvent(kind: string, payload: object): Promise<void> {
  try {
    await prisma.eventLog.create({ data: { kind, payload: payload as object } });
  } catch {
    logger.error({ errorCode: "event_log_write_failed", kind }, "Failed to write eventLog");
  }
}

/**
 * The complete metadata vocabulary allowed to leave a Graph-error boundary.
 * Provider messages, request bodies/URLs, Axios codes, and raw errors are never
 * returned because each can contain tokens or private DM text.
 */
export interface GraphErrorMetadata extends Record<string, unknown> {
  category: "graph_response" | "graph_transport" | "unknown_error";
  httpStatus: number | null;
  graphCode: number | null;
  graphSubcode: number | null;
  traceId: string | null;
  /**
   * Transport-level failure code, needed to tell a request that provably never
   * reached Meta from one that may have been delivered before the connection
   * died. Only codes on the closed allowlist below are surfaced — `err.code` is
   * caller-controlled and must never be echoed verbatim into the event log.
   */
  transportCode: TransportCode | null;
}

/**
 * Closed allowlist of transport codes. Anything not listed becomes null, which
 * every consumer must treat as "delivery outcome unknown".
 */
const TRANSPORT_CODES = [
  // Provably never delivered: the connection was refused or never resolved.
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  // Ambiguous: the request may have been received before the socket died.
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_CANCELED",
] as const;

export type TransportCode = (typeof TRANSPORT_CODES)[number];

const TRANSPORT_CODE_SET: ReadonlySet<string> = new Set(TRANSPORT_CODES);

function safeTransportCode(value: unknown): TransportCode | null {
  return typeof value === "string" && TRANSPORT_CODE_SET.has(value)
    ? (value as TransportCode)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeTraceId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function describeGraphError(err: unknown): GraphErrorMetadata {
  if (isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } }
      | undefined;
    const apiError = data?.error;

    return {
      category: err.response ? "graph_response" : "graph_transport",
      httpStatus: finiteNumber(err.response?.status),
      graphCode: finiteNumber(apiError?.code),
      graphSubcode: finiteNumber(apiError?.error_subcode),
      traceId: safeTraceId(apiError?.fbtrace_id),
      transportCode: safeTransportCode(err.code),
    };
  }

  return {
    category: "unknown_error",
    httpStatus: null,
    graphCode: null,
    graphSubcode: null,
    traceId: null,
    transportCode: null,
  };
}
