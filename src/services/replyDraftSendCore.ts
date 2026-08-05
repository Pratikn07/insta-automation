import { isAxiosError } from "axios";

/**
 * Did Instagram definitely reject this send, or do we genuinely not know?
 *
 * This distinction decides whether a retry is safe to offer. A Graph *response* —
 * any HTTP status — means Meta processed the request and refused it, so nothing was
 * delivered and retrying is safe. No response at all (timeout, socket reset, DNS)
 * means the message may well have arrived, and a blind retry would double-send to a
 * real person.
 *
 * Pure so both outcomes are testable without a network or a database.
 */
export type SendOutcome = "failed" | "uncertain";

export function classifySendError(err: unknown): { outcome: SendOutcome; errorCode: string } {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      // Meta answered. The send did not happen.
      return { outcome: "failed", errorCode: `graph_${status}` };
    }
    // No response: timeout, ECONNRESET, ETIMEDOUT, DNS failure…
    return { outcome: "uncertain", errorCode: err.code ?? "no_response" };
  }
  // A non-Axios throw from inside our own send path (e.g. a bug) never reached
  // Instagram, so it is a definite failure rather than an unknown.
  return { outcome: "failed", errorCode: "send_error" };
}
