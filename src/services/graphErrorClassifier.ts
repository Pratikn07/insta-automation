import type { GraphErrorMetadata } from "./eventLogger.js";

export type PrivateGateFailure =
  | "settings_blocked"
  | "rate_limited"
  | "permission_or_auth"
  | "retryable_transport"
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

function isRateLimit(metadata: GraphErrorMetadata): boolean {
  if (metadata.httpStatus === 429) return true;
  if (
    metadata.graphCode === 4 ||
    metadata.graphCode === 17 ||
    metadata.graphCode === 32 ||
    metadata.graphCode === 613
  ) {
    return true;
  }
  if (metadata.graphSubcode === 2534025) return true;

  return false;
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

  // 4. Retryable transport errors
  if (
    metadata.category === "graph_transport" ||
    metadata.httpStatus === 502 ||
    metadata.httpStatus === 503 ||
    metadata.httpStatus === 504
  ) {
    return "retryable_transport";
  }

  // 5. Permanent client or Graph errors
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
