import { BadgeCheck, Inbox, UserCheck, UserPlus } from "lucide-react";
import type { FollowFields } from "@/lib/types";
import { formatFollowerCount } from "@/lib/utils";

/**
 * Compact follow intel for a user, resolved from their IG profile when they DM'd
 * us. Renders nothing until we've actually checked (all fields null), so legacy /
 * comment-only users don't show a misleading "not following" state.
 *
 *   ✓ follows you · 2,214 followers · ✓ verified
 *
 * Follow status is ONLY readable once a user has DM'd us (Instagram returns
 * "consent required" otherwise), so comment-only users who never replied have no
 * data. With `showPending`, those rows show a muted "awaiting DM" hint instead of
 * nothing — so a blank row reads as "no DM yet", not "broken". Off by default so
 * the lineage header stays clean.
 */
export function FollowBadge({
  user,
  className,
  showPending = false,
}: {
  user: FollowFields;
  className?: string;
  showPending?: boolean;
}) {
  const { isFollower, followerCount, isVerified } = user;
  const checked = isFollower != null || followerCount != null || isVerified != null;
  if (!checked) {
    if (!showPending) return null;
    return (
      <div
        className={`flex items-center gap-1 text-xs text-muted-foreground ${className ?? ""}`}
        title="Follow status (follows you / follower count) is only available once a user sends you a DM. This person commented but hasn't messaged yet."
      >
        <Inbox className="size-3" />
        awaiting DM
      </div>
    );
  }

  const count = formatFollowerCount(followerCount);

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${className ?? ""}`}
    >
      {isFollower === true ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-signal-soft px-1.5 py-0.5 font-medium text-signal">
          <UserCheck className="size-3" />
          follows you
        </span>
      ) : isFollower === false ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
          <UserPlus className="size-3" />
          not following
        </span>
      ) : null}

      {count && (
        <span className="text-muted-foreground">{count} followers</span>
      )}

      {isVerified && (
        <span className="inline-flex items-center gap-1 text-funnel-mark">
          <BadgeCheck className="size-3" />
          verified
        </span>
      )}
    </div>
  );
}
