import { isAxiosError } from "axios";

/**
 * Did Instagram definitely reject this send, or do we genuinely not know?
 *
 * This distinction decides whether a retry is safe to offer. Only a deterministic
 * 4xx rejection proves that Graph refused the message. A 408, gateway/server
 * response, missing response, or unknown post-handoff throw can happen after Graph
 * accepted it, so a blind retry could double-send to a real person.
 *
 * Pure so both outcomes are testable without a network or a database.
 */
export type SendOutcome = "failed" | "uncertain";
export type SendErrorCode =
  | "graph_rejected"
  | "graph_timeout"
  | "graph_server_error"
  | "graph_response_uncertain"
  | "transport_timeout"
  | "transport_connection_reset"
  | "transport_dns_failure"
  | "transport_unavailable"
  | "transport_error"
  | "send_outcome_unknown";

export function classifySendError(err: unknown): { outcome: SendOutcome; errorCode: SendErrorCode } {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      if (status >= 400 && status < 500 && status !== 408) {
        return { outcome: "failed", errorCode: "graph_rejected" };
      }
      if (status === 408) {
        return { outcome: "uncertain", errorCode: "graph_timeout" };
      }
      if (status >= 500 && status < 600) {
        return { outcome: "uncertain", errorCode: "graph_server_error" };
      }
      return { outcome: "uncertain", errorCode: "graph_response_uncertain" };
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
  // Once the send boundary has been entered, an unknown throw cannot prove where
  // handoff stopped. Preserve uncertainty instead of authorizing a blind retry.
  return { outcome: "uncertain", errorCode: "send_outcome_unknown" };
}
