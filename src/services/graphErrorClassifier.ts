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

export type DirectMessageSendDisposition =
  | "definite_transient"
  | "definite_permanent"
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

/**
 * Classify a standard direct-message send without exposing a provider error.
 *
 * Only response shapes proving rejection, or transports proving the request
 * never reached Meta, authorize an automatic retry. Every response-less
 * timeout/reset/cancellation remains ambiguous because Meta may have accepted
 * the message before the connection failed.
 */
export function classifyDirectMessageSendFailure(
  metadata: GraphErrorMetadata,
): DirectMessageSendDisposition {
  if (isRateLimit(metadata)) return "definite_transient";

  if (
    metadata.httpStatus === 401 ||
    metadata.httpStatus === 403 ||
    metadata.graphCode === 10 ||
    metadata.graphCode === 102 ||
    metadata.graphCode === 190 ||
    metadata.graphCode === 200
  ) {
    return "definite_permanent";
  }

  if (metadata.category === "graph_transport") {
    return metadata.transportCode !== null &&
      NEVER_DELIVERED_TRANSPORT.has(metadata.transportCode)
      ? "definite_transient"
      : "uncertain";
  }

  if (
    metadata.httpStatus === 502 ||
    metadata.httpStatus === 503 ||
    metadata.httpStatus === 504
  ) {
    return "definite_transient";
  }

  if (
    metadata.category === "graph_response" &&
    metadata.httpStatus !== null &&
    metadata.httpStatus >= 400 &&
    metadata.httpStatus < 500 &&
    metadata.httpStatus !== 408
  ) {
    return "definite_permanent";
  }

  return "uncertain";
}

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

/**
 * What a failed read of the source comment means (QA-09).
 *
 * Distinct from `PublicReplyFailure` because the question is different: that one asks
 * "did my post land?", this asks "does the thing I want to reply to still exist?".
 *
 *   - `missing`  — Meta answered, and the answer was that the object is not there.
 *                  Only this may terminally suppress a candidate.
 *   - `auth`     — credentials or permissions. Opens the shared circuit; suppressing
 *                  would burn the whole pool on one expired token.
 *   - `deferred` — rate limit, timeout, 5xx, or anything unrecognised. Try later.
 */
export type SourceReadFailure = "missing" | "auth" | "deferred";

/**
 * Classify a failed source-comment read.
 *
 * The worker previously caught every failure and returned null, which the recheck read
 * as `source_comment_deleted` — terminal. So a timeout, a rate limit, a Meta 5xx, an
 * expired token, or a permission regression permanently suppressed a candidate whose
 * comment was fine, and corrupted the source-unavailable metric at the same time.
 *
 * Deliberately narrow on `missing`. Code 100 alone is NOT enough: on the private-reply
 * path it also covers "older than seven days" and "already replied to". Only the two
 * signatures that mean the object could not be resolved count, and everything
 * unrecognised defers — the safe direction, because deferring costs a tick while
 * suppressing costs the candidate permanently.
 */
export function classifySourceReadFailure(
  metadata: GraphErrorMetadata,
): SourceReadFailure {
  // Auth first: an expired token 400s on some endpoints, and reading that as
  // "missing" would suppress every remaining candidate in the campaign.
  if (
    metadata.httpStatus === 401 ||
    metadata.httpStatus === 403 ||
    metadata.graphCode === 10 ||
    metadata.graphCode === 190 ||
    metadata.graphCode === 200
  ) {
    return "auth";
  }

  if (isRateLimit(metadata)) return "deferred";

  // Meta answered that the object is gone. Code 803 is "object does not exist";
  // subcode 33 on code 100 is "unsupported get request" for an unresolvable id —
  // both are Meta stating the id resolves to nothing.
  if (metadata.category === "graph_response") {
    if (metadata.graphCode === 803) return "missing";
    if (metadata.graphCode === 100 && metadata.graphSubcode === 33) return "missing";
    if (metadata.httpStatus === 404) return "missing";
  }

  // Transport failures, 5xx, and every unrecognised shape. The comment may well be
  // there; we simply could not ask.
  return "deferred";
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
