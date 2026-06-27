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
  } catch (err) {
    logger.error({ err, kind }, "Failed to write eventLog");
  }
}

/**
 * Flatten an Axios/Graph error into a structured, queryable record. This is what
 * turns an opaque "AxiosError: ...400" into the actual Instagram reason
 * (code / subcode / message / fbtrace_id) plus the request we sent — so failures
 * like subcode 2534025 become facts we can group and count in the DB.
 */
export function describeGraphError(err: unknown): Record<string, unknown> {
  if (isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { code?: number; error_subcode?: number; message?: string; fbtrace_id?: string } }
      | undefined;
    const apiError = data?.error;

    let requestBody: unknown = err.config?.data;
    if (typeof requestBody === "string") {
      try {
        requestBody = JSON.parse(requestBody);
      } catch {
        // leave as the raw string if it isn't JSON
      }
    }

    return {
      httpStatus: err.response?.status ?? null,
      code: apiError?.code ?? null,
      subcode: apiError?.error_subcode ?? null,
      message: apiError?.message ?? err.message,
      fbtrace_id: apiError?.fbtrace_id ?? null,
      endpoint: err.config?.url ?? null,
      requestBody: requestBody ?? null,
    };
  }

  return { message: err instanceof Error ? err.message : String(err) };
}
