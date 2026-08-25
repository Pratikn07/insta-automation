import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { graph } from "../meta/graphClient.js";
import { describeGraphError } from "./eventLogger.js";

// Graph error codes that mean "our credentials are broken", not "this parent's
// status could not be read". 190 is an invalid/expired/invalidated access token;
// 10 and the 200-299 band are permission/scope losses. All of them fail every
// call at once, so they earn a distinct, louder error code than transient noise.
const AUTH_FAILURE_GRAPH_CODES = new Set([10, 190]);
function isAuthFailureCode(code: number | null): boolean {
  if (code === null) return false;
  return AUTH_FAILURE_GRAPH_CODES.has(code) || (code >= 200 && code <= 299);
}

export const FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES = [
  "fresh_follow_read_failed",
  "fresh_follow_auth_failed",
  "fresh_follow_invalid_response",
  "fresh_follow_cache_write_failed",
] as const;

type FreshFollowUnavailableErrorCode =
  (typeof FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES)[number];

export type FreshFollowResult =
  | { source: "meta_live"; isFollower: boolean; checkedAt: Date }
  | {
      source: "unavailable";
      isFollower: null;
      checkedAt: Date;
      errorCode: FreshFollowUnavailableErrorCode;
    };

type FollowProfileResponse = { is_user_follow_business?: unknown };

function unavailable(
  igUserId: string,
  errorCode: FreshFollowUnavailableErrorCode,
): FreshFollowResult {
  // Do not include a caught Graph/Axios error here. Its request config can hold
  // the access token, and this boundary is intentionally limited to stable data.
  // A credential failure is an operator emergency (it fails EVERY parent), so it
  // logs at error; everything else stays a warning.
  if (errorCode === "fresh_follow_auth_failed") {
    logger.error({ errorCode, igUserId }, "Fresh follow check failed on credentials");
  } else {
    logger.warn({ errorCode, igUserId }, "Fresh follow check unavailable");
  }
  return { source: "unavailable", isFollower: null, checkedAt: new Date(), errorCode };
}

/**
 * A Graph read failure, classified as either a credential emergency or transient noise.
 *
 * `describeGraphError` is the same allowlist-only extractor the Graph clients log through,
 * so the caught error object never leaves this function — only its numeric `graphCode` is
 * read. That keeps the access token in the error's request config from reaching a log.
 */
function classifyReadFailure(error: unknown): FreshFollowUnavailableErrorCode {
  const { graphCode } = describeGraphError(error);
  return isAuthFailureCode(graphCode) ? "fresh_follow_auth_failed" : "fresh_follow_read_failed";
}

/**
 * Read the current follow Boolean from Meta for an authorization decision.
 *
 * A cached `IgUser.isFollower` value is never read: a Graph response and the
 * matching cache write must both succeed before callers receive `meta_live`.
 */
export async function resolveFollowStatusFresh(igUserId: string): Promise<FreshFollowResult> {
  let data: FollowProfileResponse;
  try {
    ({ data } = await graph.get<FollowProfileResponse>(`/${igUserId}`, {
      params: { fields: "is_user_follow_business" },
    }));
  } catch (error) {
    return unavailable(igUserId, classifyReadFailure(error));
  }

  const isFollower = data?.is_user_follow_business;
  if (typeof isFollower !== "boolean") {
    return unavailable(igUserId, "fresh_follow_invalid_response");
  }

  const checkedAt = new Date();
  try {
    await prisma.igUser.upsert({
      where: { id: igUserId },
      create: { id: igUserId, isFollower, followCheckedAt: checkedAt },
      update: { isFollower, followCheckedAt: checkedAt },
    });
  } catch {
    return unavailable(igUserId, "fresh_follow_cache_write_failed");
  }

  return { source: "meta_live", isFollower, checkedAt };
}
