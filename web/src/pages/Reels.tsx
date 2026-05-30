import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Film, Plus, Tag, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Keyword, Reel, ReelsPage, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/EmptyState";
import { KeywordForm } from "@/components/KeywordForm";
import { cn } from "@/lib/utils";

export function Reels() {
  const reelsQ = useQuery<ReelsPage>({
    queryKey: ["reels"],
    queryFn: () => api<ReelsPage>("/media/reels"),
  });
  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: () => api<Keyword[]>("/keywords"),
  });
  const resourcesQ = useQuery<Resource[]>({
    queryKey: ["resources"],
    queryFn: () => api<Resource[]>("/resources"),
  });

  const [selected, setSelected] = useState<Reel | null>(null);

  // Group keywords by the reel they're attached to, so each card can show a
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

  const isLoading = reelsQ.isLoading || keywordsQ.isLoading || resourcesQ.isLoading;
  const reels = reelsQ.data?.items ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Reels</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a reel and attach a keyword. Comments on that reel trigger its sequence.
        </p>
      </div>

      {reelsQ.isError ? (
        <EmptyState
          icon={<Film className="size-5" />}
          title="Couldn't load reels"
          description="Instagram didn't return your reels. The access token may have expired — try again shortly."
          action={
            <Button variant="outline" onClick={() => reelsQ.refetch()}>
              Retry
            </Button>
          }
        />
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
          ))}
        </div>
      ) : reels.length === 0 ? (
        <EmptyState
          icon={<Film className="size-5" />}
          title="No reels found"
          description="Once the account has reels, they'll show up here ready for keywords."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {reels.map((reel, i) => (
            <motion.button
              key={reel.id}
              type="button"
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: i * 0.03 }}
              onClick={() => setSelected(reel)}
              className="group text-left"
            >
              <ReelThumb reel={reel} count={keywordsByMedia.get(reel.id)?.length ?? 0} />
            </motion.button>
          ))}
        </div>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Reel"
        description="Keywords attached to this reel. Comments matching them trigger a DM."
      >
        {selected && (
          <ReelDrawer
            reel={selected}
            keywords={keywordsByMedia.get(selected.id) ?? []}
            resources={resourcesQ.data ?? []}
          />
        )}
      </Drawer>
    </div>
  );
}

function ReelThumb({ reel, count }: { reel: Reel; count: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card/40 transition-colors group-hover:border-foreground/30">
      <div className="relative aspect-[9/16] bg-accent">
        {reel.thumbnailUrl ? (
          <img
            src={reel.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Film className="size-6" />
          </div>
        )}
        <div className="absolute right-2 top-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur",
              count > 0
                ? "bg-brand-gradient text-white"
                : "bg-black/55 text-white/90",
            )}
          >
            <Tag className="size-2.5" />
            {count}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 px-2.5 py-2 text-xs text-muted-foreground">
        {reel.caption?.trim() || "No caption"}
      </p>
    </div>
  );
}

function ReelDrawer({
  reel,
  keywords,
  resources,
}: {
  reel: Reel;
  keywords: Keyword[];
  resources: Resource[];
}) {
  const [attaching, setAttaching] = useState(false);

  if (attaching) {
    return (
      <KeywordForm
        initial={null}
        resources={resources}
        onClose={() => setAttaching(false)}
        mediaContext={{
          mediaId: reel.id,
          caption: reel.caption,
          permalink: reel.permalink,
          thumbnailUrl: reel.thumbnailUrl,
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-lg border bg-card/40">
        <div className="flex gap-3 p-3">
          <div className="aspect-[9/16] w-24 shrink-0 overflow-hidden rounded bg-accent">
            {reel.thumbnailUrl ? (
              <img src={reel.thumbnailUrl} alt="" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <Film className="size-5" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-4 text-sm">{reel.caption?.trim() || "No caption"}</p>
            {reel.permalink && (
              <a
                href={reel.permalink}
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
          <h3 className="text-sm font-medium">
            Keywords{" "}
            <span className="text-muted-foreground">({keywords.length})</span>
          </h3>
          <Button size="sm" variant="brand" onClick={() => setAttaching(true)}>
            <Plus className="size-4" />
            Attach keyword
          </Button>
        </div>

        {keywords.length === 0 ? (
          <div className="rounded-md border border-dashed bg-card/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No keywords on this reel yet. Attach one to start automating replies.
          </div>
        ) : (
          <ul className="space-y-2">
            {keywords.map((k) => (
              <li
                key={k.id}
                className="flex items-center gap-3 rounded-md border bg-card/40 p-3"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded bg-brand-gradient/15">
                  <Tag className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{k.keyword}</span>
                    {!k.active && (
                      <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
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
