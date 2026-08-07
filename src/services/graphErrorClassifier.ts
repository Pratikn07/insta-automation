import type { GraphErrorMetadata } from "./eventLogger.js";

export type PrivateGateFailure =
  | "settings_blocked"
  | "rate_limited"
  | "permission_or_auth"
  /** Provably never delivered — safe to retry without duplicating a DM. */
  | "retryable_transport"
  /** May have been delivered. Must never be retried automatically. */
  | "transport_uncertain"
  | "permanent"
  | "uncertain";

export type PublicReplyFailure =
  | "safe_retry"
  | "open_circuit"
  | "permanent"
  | "uncertain";

export function parseGraphSignatures(value: string): ReadonlySet<string> {
  if (!value || typeof value !== "string") return new Set();

  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^\d+:\d+$/.test(part)),
  );
}

/**
 * Rate limiting is identified by HTTP status or error code only.
 *
 * Deliberately NOT matched on a bare subcode. A subcode is only meaningful
 * paired with its code: 2534025 belongs to code 100 ("the comment is invalid
 * for a private reply" — deleted, older than seven days, already replied to, or
 * blocked by the recipient's settings), which is permanent, not a rate limit.
 * Matching it bare classified the most common private-reply failure as a rate
 * limit, which both retried a permanently failing send and made the
 * settings-blocked allowlist unreachable, because this check runs first.
 */
function isRateLimit(metadata: GraphErrorMetadata): boolean {
  if (metadata.httpStatus === 429) return true;

  return (
    metadata.graphCode === 4 ||
    metadata.graphCode === 17 ||
    metadata.graphCode === 32 ||
    metadata.graphCode === 613
  );
}

/**
 * Transport codes proving the request never reached Meta. Everything else,
 * including an unrecognised code, is ambiguous: the send may have been
 * processed before the connection died, so retrying could deliver twice.
 */
const NEVER_DELIVERED_TRANSPORT: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function classifyPrivateGateFailure(
  metadata: GraphErrorMetadata,
  allowlistedSignatures: ReadonlySet<string>,
): PrivateGateFailure {
  // 1. Rate limits take precedence over allowlists
  if (isRateLimit(metadata)) {
    return "rate_limited";
  }

  // 2. Allowlisted settings-blocked signatures
  if (metadata.graphCode !== null && metadata.graphSubcode !== null) {
    const signature = `${metadata.graphCode}:${metadata.graphSubcode}`;
    if (allowlistedSignatures.has(signature)) {
      return "settings_blocked";
    }
  }

  // 3. Permission or authentication errors
  if (
    metadata.httpStatus === 401 ||
    metadata.httpStatus === 403 ||
    metadata.graphCode === 10 ||
    metadata.graphCode === 102 ||
    metadata.graphCode === 190 ||
    metadata.graphCode === 200
  ) {
    return "permission_or_auth";
  }

  // 4. Response-less failures: retryable only when provably undelivered.
  if (metadata.category === "graph_transport") {
    return metadata.transportCode !== null &&
      NEVER_DELIVERED_TRANSPORT.has(metadata.transportCode)
      ? "retryable_transport"
      : "transport_uncertain";
  }

  // 5. Gateway errors — Meta answered, so the send was not accepted.
  if (
    metadata.httpStatus === 502 ||
    metadata.httpStatus === 503 ||
    metadata.httpStatus === 504
  ) {
    return "retryable_transport";
  }

  // 6. Permanent client or Graph errors
  if (metadata.httpStatus === 400 || metadata.httpStatus === 404) {
    return "permanent";
  }

  return "uncertain";
}

export function classifyPublicReplyFailure(
  metadata: GraphErrorMetadata,
): PublicReplyFailure {
  if (isRateLimit(metadata)) {
    return "safe_retry";
  }

  if (
    metadata.httpStatus === 401 ||
    metadata.httpStatus === 403 ||
    metadata.graphCode === 10 ||
    metadata.graphCode === 190
  ) {
    return "open_circuit";
  }

  if (metadata.httpStatus === 400 || metadata.httpStatus === 404 || metadata.graphCode === 100) {
    return "permanent";
  }

  return "uncertain";
}
