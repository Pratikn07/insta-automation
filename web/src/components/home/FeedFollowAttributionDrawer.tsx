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
    // A figure cell, not a card — a rule above and the figure carrying the
    // weight, the shape KpiTile settled on. This was `rounded-xl border
    // bg-muted/20`: a 12px box (--radius-lg is 3px) on an unmeasured 20% tint of
    // the quiet fill. `line` rather than the bare default because this cell's
    // ground is the drawer's --color-card (#FFFEF9), where #EBE8DF is 1.21:1.
    <div className="border-t border-t-line pt-2.5">
      {/* Was a hand-rolled `text-xs uppercase tracking-wide` — the same drift
          label-caps exists to prevent, at 0.75rem/0.025em against its
          0.625rem/0.14em. */}
      <p className="label-caps">{label}</p>
      {value === null ? (
        // The Placeholder Is Not A Figure Rule: a stand-in for a missing number
        // is set at label scale, not figure scale. "Unavailable" at 1.5rem is a
        // hole where a value should be.
        <p className="mt-1.5 text-base font-medium text-muted-foreground">Unavailable</p>
      ) : (
        <p className="figure-small mt-1.5">{formatSignedCount(value)}</p>
      )}
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function CollectionStatus({ copy }: { copy: FeedCollectionCopy }) {
  return (
    <div
      className={cn(
        // Keeps its bounded surface: this is a status band, and DESIGN.md allows
        // 3px "on a band". The tints are the recorded status pairs, now at full
        // strength — `bg-muted/30` was an unmeasured blend, and "measure the
        // blend, not the token" is the rule it broke.
        "rounded-sm border px-3 py-2.5",
        copy.tone === "good" && "border-signal bg-signal-soft",
        copy.tone === "caution" && "border-caution bg-caution-soft",
        copy.tone === "muted" && "border-line bg-muted",
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
    // A row in a ranked list ("Largest attributed increase first"), not an
    // object — nothing here is picked up or moved, so it separates on a rule the
    // way Home's attention rows and the panel's spike days do. The rule sits on
    // top of every row but the first, so the list leaves no trailing edge.
    <article className="py-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-t-line">
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
              <p className="figure-inline">{formatSignedCount(post.delta)}</p>
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

// Sentences, not dashed cards. DESIGN.md settles this outright — "the empty
// state and the not-found state LOST their containers" because both were
// "drawn to make a paragraph look considered" — and DailyAddsChart's waiting
// state was rewritten the same way. The heading above already names the section,
// so the rule and the heading do the separating.
function EmptyContributors({ day }: { day: FeedFollowAttributionDay }) {
  if (day.collectionStatus === "complete" && day.attributedFeedFollows === 0) {
    return (
      <div>
        <p className="text-sm font-medium">Meta attributed no feed-post follows on this day.</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          All eligible feed posts were checked successfully.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium">No contributing feed posts can be confirmed.</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
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
    // Keeps a bounded surface — a failed read is the one thing in here a reader
    // must act on — and takes the treatment Home already gives its "could not
    // check" block: neutral ground, `line` edge, the attention tone carried by
    // the heading alone.
    //
    // It was `border-destructive/25 bg-destructive/5`, two unmeasured blends, and
    // DESIGN.md reserves destructive for "deletion and irreversible actions
    // only" — a request that failed is neither.
    //
    // NOT urgent-soft, which was the obvious swap. index.css scopes the -soft
    // values to STATUS BADGES, each measured against its own foreground: they
    // hold a short word in text-urgent, not a paragraph. Muted body copy on
    // urgent-soft measures 4.46:1, under the 4.5 floor — the No-Quieter-Tier
    // Rule's warning that muted has "nothing to spare". On quiet it is 4.72:1
    // and the urgent heading is 4.96:1, both measured, both clear.
    <div className="rounded-sm border border-line bg-muted p-4">
      <p className="text-sm font-medium text-urgent">Could not load feed attribution</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
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
    // Prose under a rule. `rounded-xl bg-muted/35` made a routine scope note the
    // only filled surface left in the drawer, which is the same inversion the
    // follower panel's footnote had — and 35% of the quiet fill was an
    // unmeasured tint besides.
    <aside className="border-t border-t-line pt-3 text-xs leading-relaxed text-muted-foreground">
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
            <h3 id="feed-contributors-heading" className="text-sm font-medium">
              Contributing feed posts
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">Largest attributed increase first</p>
          </div>
          <span className="text-xs text-muted-foreground">
            {day.posts.length} {day.posts.length === 1 ? "post" : "posts"}
          </span>
        </div>
        {day.posts.length > 0 ? (
          <div>
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
          <div>
            <p className="text-sm font-medium">Attribution is unavailable for this date.</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              No day record was returned, so this cannot be treated as zero.
            </p>
          </div>
        )}
        <ScopeNote />
      </div>
    </Drawer>
  );
}
