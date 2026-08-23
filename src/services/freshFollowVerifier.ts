import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { graph } from "../meta/graphClient.js";

export const FRESH_FOLLOW_UNAVAILABLE_ERROR_CODES = [
  "fresh_follow_read_failed",
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
  logger.warn({ errorCode, igUserId }, "Fresh follow check unavailable");
  return { source: "unavailable", isFollower: null, checkedAt: new Date(), errorCode };
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
  } catch {
    return unavailable(igUserId, "fresh_follow_read_failed");
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
