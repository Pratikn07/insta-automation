import { graph } from "../meta/graphClient.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { describeGraphError } from "./eventLogger.js";

export interface IgUserLite {
  id: string;
  username: string | null;
  name: string | null;
  audienceSegment: string | null;
  isFollower: boolean | null;
  followerCount: number | null;
  isVerified: boolean | null;
}

export interface FollowState {
  isFollower: boolean | null;
  followerCount: number | null;
  isVerified: boolean | null;
}

function toLite(r: {
  id: string;
  username: string | null;
  name: string | null;
  audienceSegment: string | null;
  isFollower: boolean | null;
  followerCount: number | null;
  isVerified: boolean | null;
}): IgUserLite {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    audienceSegment: r.audienceSegment,
    isFollower: r.isFollower,
    followerCount: r.followerCount,
    isVerified: r.isVerified,
  };
}

/**
 * Clear a stored origin verdict when the identity it was derived from changed.
 *
 * The verdict is a judgement about a specific name/username pair. When either
 * changes, the stored answer describes a person who no longer presents under
 * that name, so it is retired and the enrichment worker re-derives it. Returned
 * as an update fragment so it rides the caller's existing upsert rather than
 * adding a second write.
 */
function originResetIfIdentityChanged(
  existing: { username: string | null; name: string | null } | null,
  username: string | null,
  name: string | null,
): Record<string, null> {
  if (!existing) return {};
  if (existing.username === username && existing.name === name) return {};
  return {
    inferredOrigin: null,
    originConfidence: null,
    originEvidence: null,
    // Retired together with the verdict. Leaving the method behind described a
    // row as classified by a prompt version that no longer had a verdict to
    // show for it, which only stayed harmless because `resolveAudienceOrigin`
    // also tests the verdict itself.
    originMethod: null,
    // Null here is what makes the enrichment worker pick the row up again.
    originCheckedAt: null,
    audienceSegment: null,
  };
}

/**
 * Store a username we already KNOW (comment webhooks include `from.username` for
 * free — no API call needed). Upsert + stamp resolvedAt. Never throws.
 */
export async function rememberUsername(
  igUserId: string,
  username?: string | null,
  name?: string | null,
): Promise<void> {
  if (!username) return;
  try {
    const existing = await prisma.igUser.findUnique({
      where: { id: igUserId },
      select: { username: true, name: true },
    });
    await prisma.igUser.upsert({
      where: { id: igUserId },
      create: { id: igUserId, username, name: name ?? null, resolvedAt: new Date() },
      update: {
        username,
        name: name ?? null,
        resolvedAt: new Date(),
        ...originResetIfIdentityChanged(existing, username, name ?? null),
      },
    });
  } catch {
    logger.error(
      { errorCode: "remember_username_failed", igUserId },
      "rememberUsername failed",
    );
  }
}

/**
 * Resolve a DM sender's profile — username/name AND follow intel
 * (is_user_follow_business, follower_count, is_verified_user) in a single Graph
 * call. Follow status is volatile and only readable in a messaging context, so we
 * refresh it on every resolve (even when the username is still cache-fresh).
 *
 * Never throws — on failure we record a stub (so we don't hammer the API) and
 * return nulls, so callers fall back to the numeric id and a neutral follow state.
 */
export async function resolveUsername(igUserId: string): Promise<IgUserLite> {
  try {
    const { data } = await graph.get<{
      username?: string;
      name?: string;
      is_user_follow_business?: boolean;
      follower_count?: number;
      is_verified_user?: boolean;
    }>(`/${igUserId}`, {
      params: { fields: "username,name,is_user_follow_business,follower_count,is_verified_user" },
    });

    const username = data.username ?? null;
    const name = data.name ?? null;
    const isFollower = data.is_user_follow_business ?? null;
    const followerCount = data.follower_count ?? null;
    const isVerified = data.is_verified_user ?? null;

    const existing = await prisma.igUser.findUnique({
      where: { id: igUserId },
      select: { username: true, name: true },
    });

    const row = await prisma.igUser.upsert({
      where: { id: igUserId },
      create: {
        id: igUserId,
        username,
        name,
        resolvedAt: username ? new Date() : null,
        isFollower,
        followerCount,
        isVerified,
        followCheckedAt: new Date(),
      },
      update: {
        username,
        name,
        resolvedAt: username ? new Date() : undefined,
        isFollower,
        followerCount,
        isVerified,
        followCheckedAt: new Date(),
        ...originResetIfIdentityChanged(existing, username, name),
      },
    });

    return toLite(row);
  } catch (err) {
    // Use describeGraphError (NOT raw err) — the raw axios error embeds the access
    // token in err.config.params, which would leak into stdout / Railway logs.
    // code 230 = "User consent required" (commenter who never DM'd us), 9010 = dead IGSID.
    logger.warn({ ...describeGraphError(err), igUserId }, "resolveUsername failed — leaving profile unresolved");
    try {
      const row = await prisma.igUser.upsert({
        where: { id: igUserId },
        create: { id: igUserId, username: null, name: null, resolvedAt: null },
        update: {},
      });
      return toLite(row);
    } catch {
      return {
        id: igUserId,
        username: null,
        name: null,
        audienceSegment: null,
        isFollower: null,
        followerCount: null,
        isVerified: null,
      };
    }
  }
}

/** Read the cached follow state for a user (no API call). */
export async function getFollowState(igUserId: string): Promise<FollowState> {
  const row = await prisma.igUser.findUnique({ where: { id: igUserId } });
  return {
    isFollower: row?.isFollower ?? null,
    followerCount: row?.followerCount ?? null,
    isVerified: row?.isVerified ?? null,
  };
}

/**
 * Batch-load IgUser rows for a set of ids (read side / API). Returns a map keyed
 * by igUserId. Missing ids simply won't be in the map.
 */
export async function getIgUsers(ids: string[]): Promise<Record<string, IgUserLite>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const rows = await prisma.igUser.findMany({ where: { id: { in: unique } } });
  const map: Record<string, IgUserLite> = {};
  for (const r of rows) map[r.id] = toLite(r);
  return map;
}
