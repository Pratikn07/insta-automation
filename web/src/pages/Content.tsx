import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Film, Images, LayoutGrid, Plus, Tag, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Keyword, MediaItem, MediaKind, MediaPage, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/EmptyState";
import { KeywordForm } from "@/components/KeywordForm";
import { cn } from "@/lib/utils";

type Filter = "all" | MediaKind;

// Per-kind presentation. Reels and carousels differ only in wording and icon —
// the keyword flow behind them is identical, which is why they share one page.
const KIND = {
  reel: { icon: Film, noun: "reel", plural: "Reels" },
  carousel: { icon: Images, noun: "carousel", plural: "Carousels" },
} as const;

export function Content() {
  const mediaQ = useQuery<MediaPage>({
    queryKey: ["content"],
    queryFn: () => api<MediaPage>("/media/content"),
  });
  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: () => api<Keyword[]>("/keywords"),
  });
  const resourcesQ = useQuery<Resource[]>({
    queryKey: ["resources"],
    queryFn: () => api<Resource[]>("/resources"),
  });

  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  // Group keywords by the post they're attached to, so each card can show a
  // count and the drawer can list them — one source of truth, no extra fetch.
  const keywordsByMedia = useMemo(() => {
    const map = new Map<string, Keyword[]>();
    for (const k of keywordsQ.data ?? []) {
      if (!k.mediaId) continue;
      const list = map.get(k.mediaId) ?? [];
      list.push(k);
      map.set(k.mediaId, list);
    }
    return map;
  }, [keywordsQ.data]);

  // Memoized so `all` is a stable reference across renders — otherwise the
  // `?? []` fallback allocates a fresh array each time and re-runs everything
  // downstream of it.
  const all = useMemo(() => mediaQ.data?.items ?? [], [mediaQ.data]);
  const counts = useMemo(
    () => ({
      all: all.length,
      reel: all.filter((m) => m.kind === "reel").length,
      carousel: all.filter((m) => m.kind === "carousel").length,
    }),
    [all],
  );
  const items = useMemo(
    () => (filter === "all" ? all : all.filter((m) => m.kind === filter)),
    [all, filter],
  );

  const isLoading = mediaQ.isLoading || keywordsQ.isLoading || resourcesQ.isLoading;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Content</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a post and attach a keyword. Comments on that post trigger its sequence.
        </p>
      </div>

      {!isLoading && !mediaQ.isError && all.length > 0 && (
        <FilterTabs value={filter} onChange={setFilter} counts={counts} />
      )}

      {mediaQ.isError ? (
        <EmptyState
          icon={<LayoutGrid className="size-5" />}
          title="Couldn't load your posts"
          description="Instagram didn't return your content. The access token may have expired — try again shortly."
          action={
            <Button variant="outline" onClick={() => mediaQ.refetch()}>
              Retry
            </Button>
          }
        />
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/5] rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="size-5" />}
          title={filter === "all" ? "No posts found" : `No ${KIND[filter].plural.toLowerCase()} yet`}
          description={
            filter === "all"
              ? "Once the account has posts, they'll show up here ready for keywords."
              : `This account has no ${KIND[filter].noun}s. Switch to All to see everything.`
          }
        />
      ) : (
        <div key={filter} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item, i) => (
            <motion.button
              key={item.id}
              type="button"
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              // Stagger only the first rows. With 147 posts an uncapped i*0.03
              // would leave the last card fading in ~4s after the first.
              transition={{ duration: 0.2, delay: Math.min(i, 11) * 0.03 }}
              onClick={() => setSelected(item)}
              className="group text-left"
            >
              <MediaThumb item={item} count={keywordsByMedia.get(item.id)?.length ?? 0} />
            </motion.button>
          ))}
        </div>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? (selected.kind === "reel" ? "Reel" : "Carousel") : undefined}
        description="Keywords attached to this post. Comments matching them trigger a DM."
      >
        {selected && (
          <MediaDrawer
            item={selected}
            keywords={keywordsByMedia.get(selected.id) ?? []}
            resources={resourcesQ.data ?? []}
          />
        )}
      </Drawer>
    </div>
  );
}

function FilterTabs({
  value,
  onChange,
  counts,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
  counts: { all: number; reel: number; carousel: number };
}) {
  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "reel", label: "Reels" },
    { key: "carousel", label: "Carousels" },
  ];

  return (
    <div
      role="tablist"
      aria-label="Filter by post type"
      className="inline-flex items-center gap-1 rounded-lg border bg-card/40 p-1"
    >
      {tabs.map(({ key, label }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "relative rounded-md px-3 py-1.5 text-sm transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="content-filter-pill"
                transition={{ type: "spring", damping: 26, stiffness: 320 }}
                className="absolute inset-0 rounded-md bg-accent"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {label}
              <span
                className={cn(
                  "text-xs tabular-nums",
                  active ? "text-muted-foreground" : "text-muted-foreground",
                )}
              >
                {counts[key]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A post tile keeps its border. It is a bounded object — a picked-up, clicked,
 * filtered thing with a real edge — which is exactly the case the Bounded-Object
 * rule exists to protect. The badges over the image keep their dark scrim and
 * white text too: they sit on photography, not on paper, and a paper-coloured
 * chip would vanish against a bright thumbnail.
 */
function MediaThumb({ item, count }: { item: MediaItem; count: number }) {
  const { icon: KindIcon, noun } = KIND[item.kind];
  return (
    <div className="overflow-hidden rounded-lg border bg-card/40 transition-colors group-hover:border-foreground/30">
      {/* One aspect ratio for every kind, so a mixed grid stays a clean matrix
          and a reel doesn't change shape when you switch filters. 4:5 is
          Instagram's own grid tile; object-cover centre-crops the 9:16 frame. */}
      <div className="relative aspect-[4/5] bg-accent">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <KindIcon className="size-6" />
          </div>
        )}
        <div className="absolute left-2 top-2">
          <span
            className="inline-flex items-center rounded-sm bg-black/55 p-1 text-white/90 backdrop-blur"
            title={noun}
            aria-label={noun}
          >
            <KindIcon className="size-2.5" />
          </span>
        </div>
        <div className="absolute right-2 top-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] font-medium backdrop-blur",
              count > 0 ? "bg-signal text-background" : "bg-black/55 text-white/90",
            )}
          >
            <Tag className="size-2.5" />
            {count}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 px-2.5 py-2 text-xs text-muted-foreground">
        {item.caption?.trim() || "No caption"}
      </p>
    </div>
  );
}

function MediaDrawer({
  item,
  keywords,
  resources,
}: {
  item: MediaItem;
  keywords: Keyword[];
  resources: Resource[];
}) {
  const [attaching, setAttaching] = useState(false);
  const { icon: KindIcon, noun } = KIND[item.kind];

  if (attaching) {
    return (
      <KeywordForm
        initial={null}
        resources={resources}
        onClose={() => setAttaching(false)}
        mediaContext={{
          mediaId: item.id,
          kind: item.kind,
          caption: item.caption,
          permalink: item.permalink,
          thumbnailUrl: item.thumbnailUrl,
          // Snapshotted onto the keyword so a cold DM can rank posts by date.
          postedAt: item.timestamp,
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-lg border bg-card/40">
        <div className="flex gap-3 p-3">
          <div className="aspect-[4/5] w-24 shrink-0 overflow-hidden rounded bg-accent">
            {item.thumbnailUrl ? (
              <img src={item.thumbnailUrl} alt="" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <KindIcon className="size-5" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-4 text-sm">{item.caption?.trim() || "No caption"}</p>
            {item.permalink && (
              <a
                href={item.permalink}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3" />
                View on Instagram
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="label-caps">Keywords ({keywords.length})</h3>
          <Button size="sm" variant="brand" onClick={() => setAttaching(true)}>
            <Plus className="size-4" />
            Attach keyword
          </Button>
        </div>

        {keywords.length === 0 ? (
          <p className="border-t py-6 text-[13px] text-muted-foreground">
            No keywords on this {noun} yet. Attach one to start automating replies.
          </p>
        ) : (
          <ul className="space-y-2">
            {keywords.map((k) => (
              <li key={k.id} className="flex items-center gap-3 rounded-md border bg-card/40 p-3">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-signal-soft text-signal">
                  <Tag className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{k.keyword}</span>
                    {!k.active && (
                      <span className="rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Paused
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    → {k.resource?.name ?? "Unknown sequence"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Manage or delete keywords from the Keywords page.
        </p>
      </div>
    </div>
  );
}
