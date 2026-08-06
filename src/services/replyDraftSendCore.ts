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
export type SendErrorCode =
  | "graph_rejected"
  | "transport_timeout"
  | "transport_connection_reset"
  | "transport_dns_failure"
  | "transport_unavailable"
  | "transport_error"
  | "send_error";

export function classifySendError(err: unknown): { outcome: SendOutcome; errorCode: SendErrorCode } {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      // Meta answered. The send did not happen.
      return { outcome: "failed", errorCode: "graph_rejected" };
    }

    // Axios error codes are not a trusted vocabulary. Map the few useful
    // transport classes and collapse everything else to one stable value.
    const errorCode: SendErrorCode = (() => {
      switch (err.code) {
        case "ECONNABORTED":
        case "ETIMEDOUT":
          return "transport_timeout";
        case "ECONNRESET":
          return "transport_connection_reset";
        case "ENOTFOUND":
        case "EAI_AGAIN":
          return "transport_dns_failure";
        case "ECONNREFUSED":
        case "EHOSTUNREACH":
        case "ENETUNREACH":
          return "transport_unavailable";
        default:
          return "transport_error";
      }
    })();

    // No response: the message may have arrived, so a blind retry is unsafe.
    return { outcome: "uncertain", errorCode };
  }
  // A non-Axios throw from inside our own send path (e.g. a bug) never reached
  // Instagram, so it is a definite failure rather than an unknown.
  return { outcome: "failed", errorCode: "send_error" };
}
