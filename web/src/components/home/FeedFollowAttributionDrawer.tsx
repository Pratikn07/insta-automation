import { ExternalLink, ImageOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  feedCollectionCopy,
  feedComparisonExplanation,
  feedMediaLabel,
  safeInstagramPermalink,
  type FeedCollectionCopy,
} from "@/lib/feedFollowAttribution";
import { formatSignedCount } from "@/lib/followerFlow";
import type {
  FeedFollowAttributedPost,
  FeedFollowAttributionDay,
  FeedFollowAttributionResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface FeedFollowAttributionDrawerProps {
  day: string | null;
  data: FeedFollowAttributionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
}

// This is an abstract Pacific day key; UTC formatting prevents browser date shifting.
const longDay = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
});

function formatDayKey(day: string): string {
  return longDay.format(new Date(`${day}T00:00:00Z`));
}

function formatPublishedAt(value: string | null): string | null {
  if (value === null) return null;
  return shortDay.format(new Date(value));
}

function SummaryValue({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {value === null ? "Unavailable" : formatSignedCount(value)}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function CollectionStatus({ copy }: { copy: FeedCollectionCopy }) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        copy.tone === "good" && "border-signal bg-signal-soft",
        copy.tone === "caution" && "border-caution bg-caution-soft",
        copy.tone === "muted" && "bg-muted/30",
      )}
    >
      <p className="text-sm font-medium">{copy.label}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.detail}</p>
    </div>
  );
}

function PostThumbnail({ post }: { post: FeedFollowAttributedPost }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!post.thumbnailUrl || failedUrl === post.thumbnailUrl) {
    return (
      <div className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <ImageOff className="size-5" aria-hidden="true" />
        <span className="sr-only">No thumbnail available</span>
      </div>
    );
  }

  return (
    <img
      src={post.thumbnailUrl}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedUrl(post.thumbnailUrl)}
      className="size-20 shrink-0 rounded-lg bg-muted object-cover"
    />
  );
}

function PostRow({ post }: { post: FeedFollowAttributedPost }) {
  const publishedAt = formatPublishedAt(post.postedAt);
  const permalink = safeInstagramPermalink(post.permalink);
  return (
    <article className="rounded-xl border p-4">
      <div className="flex gap-4">
        <PostThumbnail post={post} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-medium leading-snug">
                {post.caption?.trim() || "Untitled feed post"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {feedMediaLabel(post.mediaType)}
                {publishedAt ? ` · Published ${publishedAt} Pacific` : ""}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-lg font-semibold tabular-nums">{formatSignedCount(post.delta)}</p>
              <p className="text-[11px] text-muted-foreground">
                {post.spanDays > 1
                  ? `attributed across ${post.spanDays} days`
                  : "attributed follows this day"}
              </p>
            </div>
          </div>
          {/* A card footer inside a card, so `line` — never ink. Its ground is
              the drawer's --color-card (#FFFEF9), not the page, and `line`
              measures 1.68:1 there. Named because the base layer sets
              `border-color` on `*`: bare, this was #EBE8DF at 1.21:1 on card and
              the follows count read as a loose line under the caption rather
              than as the post's footer. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-t-line pt-3">
            <span className="text-xs font-medium text-foreground">
              {post.follows} lifetime follows
            </span>
            {permalink && (
              <a
                href={permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Open on Instagram
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function EmptyContributors({ day }: { day: FeedFollowAttributionDay }) {
  if (day.collectionStatus === "complete" && day.attributedFeedFollows === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center">
        <p className="text-sm font-medium">Meta attributed no feed-post follows on this day.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          All eligible feed posts were checked successfully.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed p-6 text-center">
      <p className="text-sm font-medium">No contributing feed posts can be confirmed.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The collection status above explains why this is unavailable rather than zero.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-live="polite">
      <p className="text-sm text-muted-foreground">Loading feed attribution…</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-20" />
      <Skeleton className="h-32" />
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-5">
      <p className="text-sm font-medium">Could not load feed attribution</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The chart data is still available. Try this one-day diagnostic again.
      </p>
      <Button className="mt-4" size="sm" variant="outline" type="button" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ScopeNote() {
  return (
    <aside className="rounded-xl bg-muted/35 p-4 text-xs leading-relaxed text-muted-foreground">
      <p>
        Feed-post follows are gross follows credited by Meta; account change is net follows minus
        unfollows. The remainder is a directional diagnostic, not an exact source count.
      </p>
      <p className="mt-2 font-medium text-foreground">
        Reels and Stories are not included in this feed-post attribution.
      </p>
    </aside>
  );
}

function AttributionContent({ day }: { day: FeedFollowAttributionDay }) {
  const comparisonDetail = feedComparisonExplanation(day.comparisonReason);
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Follower attribution summary">
        <SummaryValue
          label="Account net change"
          value={day.accountNetAdds}
          detail="Follows minus unfollows"
        />
        <SummaryValue
          label="Attributed to feed posts"
          value={day.attributedFeedFollows}
          detail="Gross follows credited by Meta"
        />
        <SummaryValue
          label="Directional remainder"
          value={day.netResidualAfterFeed}
          detail={comparisonDetail ?? "Net account change minus gross feed attribution"}
        />
      </section>

      <CollectionStatus copy={feedCollectionCopy(day)} />

      <section aria-labelledby="feed-contributors-heading">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 id="feed-contributors-heading" className="text-sm font-semibold">
              Contributing feed posts
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">Largest attributed increase first</p>
          </div>
          <span className="text-xs text-muted-foreground">
            {day.posts.length} {day.posts.length === 1 ? "post" : "posts"}
          </span>
        </div>
        {day.posts.length > 0 ? (
          <div className="space-y-3">
            {day.posts.map((post) => (
              <PostRow key={post.mediaId} post={post} />
            ))}
          </div>
        ) : (
          <EmptyContributors day={day} />
        )}
      </section>

    </div>
  );
}

export function FeedFollowAttributionDrawer({
  day,
  data,
  isLoading,
  isError,
  onRetry,
  onClose,
}: FeedFollowAttributionDrawerProps) {
  const selected = data?.days[0];
  const titleDay = day ? formatDayKey(day) : "Selected day";

  return (
    <Drawer
      open={day !== null}
      onClose={onClose}
      modal={false}
      title={titleDay}
      description="Feed-post follow attribution"
      widthClass="w-full max-w-xl"
    >
      <div className="space-y-5">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState onRetry={onRetry} />
        ) : selected ? (
          <AttributionContent day={selected} />
        ) : (
          <div className="rounded-xl border border-dashed p-6 text-center">
            <p className="text-sm font-medium">Attribution is unavailable for this date.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No day record was returned, so this cannot be treated as zero.
            </p>
          </div>
        )}
        <ScopeNote />
      </div>
    </Drawer>
  );
}
