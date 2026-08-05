import type {
  FeedFollowAttributionDay,
  FeedFollowComparisonReason,
} from "./types";

export interface FeedCollectionCopy {
  label: string;
  detail: string;
  tone: "good" | "caution" | "muted";
}

export function feedMediaLabel(mediaType: string | null): string {
  if (mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (mediaType === "IMAGE") return "Image post";
  if (mediaType === "VIDEO") return "Feed video";
  return "Feed post";
}

export function feedComparisonExplanation(
  reason: FeedFollowComparisonReason | null,
): string | null {
  switch (reason) {
    case "feed_not_started":
      return "Tracking had not started on this date.";
    case "feed_tracking_partial_day":
      return "Feed-post tracking started partway through this day, so the comparison is incomplete.";
    case "feed_collection_incomplete":
      return "Some feed-post readings are incomplete, so a directional remainder cannot be calculated.";
    case "feed_multi_day_delta":
      return "At least one feed-post change covers multiple days, so it cannot be compared with one account day.";
    case "feed_counter_correction":
      return "Meta corrected at least one cumulative feed-post count, so the directional remainder is withheld.";
    case "account_missing":
      return "Account net follower change is unavailable for this date.";
    case "account_provisional":
      return "Account net follower change is still settling and may be revised by Meta.";
    case "account_not_one_day":
      return "Account data does not represent a settled one-day comparison.";
    case null:
      return null;
  }
}

function countLabel(count: number, state: string): string {
  return `${count} ${state}`;
}

function uncertaintyDetail(day: FeedFollowAttributionDay): string {
  const parts: string[] = [];
  if (day.unavailablePosts > 0) parts.push(countLabel(day.unavailablePosts, "unavailable"));
  if (day.failedPosts > 0) parts.push(countLabel(day.failedPosts, "failed"));
  if (day.missingPosts > 0) parts.push(countLabel(day.missingPosts, "missing"));

  if (parts.length === 0) return "No complete feed-post reading was captured.";
  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}.`;
}

export function feedCollectionCopy(day: FeedFollowAttributionDay): FeedCollectionCopy {
  if (day.collectionStatus === "not_started") {
    return {
      label: "Before tracking",
      detail: "Tracking had not started, so historical feed-post follows were not fabricated.",
      tone: "muted",
    };
  }

  if (day.collectionStatus === "complete") {
    return {
      label: "Complete",
      detail: `Meta returned follow counts for all ${day.eligiblePosts} eligible feed posts.`,
      tone: "good",
    };
  }

  const uncertainty = uncertaintyDetail(day);
  if (day.collectionStatus === "partial") {
    return {
      label: "Partial collection",
      detail: `${day.successfulPosts} of ${day.eligiblePosts} posts captured; ${uncertainty}`,
      tone: "caution",
    };
  }

  return {
    label: "Collection unavailable",
    detail: `No usable readings for ${day.eligiblePosts} eligible feed posts; ${uncertainty}`,
    tone: "caution",
  };
}
