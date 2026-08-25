import { logger } from "../lib/logger.js";
import { describeGraphError, graphErrorIsAuthFailure, logEvent } from "../services/eventLogger.js";
import { graph } from "./graphClient.js";

export type TokenLivenessResult = "live" | "invalidated" | "unknown";

/**
 * Ask Meta, cheaply, whether the token still works — independent of when it expires.
 *
 * WHY THIS EXISTS. tokenHealth() reasons purely from `expires_at`, so a token
 * invalidated EARLY (a password change, a manual revoke, a security reset) reads
 * "healthy" green while every call returns code 190. That is exactly what happened
 * on 2026-08-25: the token died ~62 days before its stored expiry. The refresh
 * worker would eventually catch it, but only on a refresh-due tick (~weekly), so
 * between refreshes the failure is invisible. This probe runs every token tick and
 * closes that window to hours.
 *
 * A credential failure (Graph 190, or a 10/200-299 permission loss) is an operator
 * emergency: it fails EVERY parent's follow check at once. So it emits a single
 * `ig_token_invalidated` event — which readTokenHealth turns into a red dashboard —
 * and logs at error. A transient/non-credential error is noise and stays at debug;
 * the whole thing is non-throwing so a probe can never disturb the token tick.
 */
export async function probeTokenLiveness(): Promise<TokenLivenessResult> {
  try {
    await graph.get<{ id?: string }>("/me", { params: { fields: "id" } });
    logger.debug("token liveness probe ok");
    return "live";
  } catch (error) {
    if (!graphErrorIsAuthFailure(error)) {
      // Transient: a flaky network or a non-credential Graph error. Not an alarm —
      // the next tick re-probes. describeGraphError keeps this line token-safe.
      logger.debug({ ...describeGraphError(error) }, "token liveness probe inconclusive");
      return "unknown";
    }
    // describeGraphError is the same allowlist-only extractor the Graph clients log
    // through, so the caught error (whose request config holds the token) never
    // leaves here — only its numeric metadata does.
    const detail = describeGraphError(error);
    logger.error({ errorCode: "ig_token_invalidated", ...detail }, "Instagram token invalidated");
    await logEvent("ig_token_invalidated", { source: "liveness_probe", ...detail });
    return "invalidated";
  }
}
