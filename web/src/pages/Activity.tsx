import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon } from "lucide-react";
import { useState } from "react";
import { apiRead } from "@/lib/api";
import type { Stats } from "@/lib/types";
import { AutomationHealthStrip } from "@/components/activity/AutomationHealthStrip";
import { cn, displayUser, type IgUserLite } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState, LoadFailed } from "@/components/EmptyState";
import { UserLineage } from "@/components/UserLineage";
import { EventRow, type EventLogItem } from "./Conversations";

interface EventsPage {
  items: EventLogItem[];
  users: Record<string, IgUserLite>;
  nextCursor: string | null;
}

// Pull the user id an event refers to (stored inside payload as senderId/fromId).
function eventUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { senderId?: unknown; fromId?: unknown };
  if (typeof p.senderId === "string") return p.senderId;
  if (typeof p.fromId === "string") return p.fromId;
  return null;
}

// Kinds worth filtering by from the global feed. "All" shows everything.
const KIND_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "webhook_received", label: "Webhooks" },
  { value: "comment_received", label: "Comments" },
  { value: "message_received", label: "Inbound DMs" },
  { value: "dm_failed", label: "Gate DM failed" },
  { value: "sequence_failed", label: "Sequence failed" },
  { value: "error", label: "Errors" },
];

export function Activity() {
  const [kind, setKind] = useState<string>("all");
  const [lineageUser, setLineageUser] = useState<string | null>(null);

  const eventsQ = useInfiniteQuery({
    queryKey: ["activity", kind],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (kind !== "all") params.set("kind", kind);
      if (pageParam) params.set("cursor", pageParam);
      return apiRead<EventsPage>(`/stats/events?${params.toString()}`, { signal });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // Same key as elsewhere, so this shares one cached fetch across pages.
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: ({ signal }) => apiRead<Stats>("/stats", { signal }),
  });

  const items = eventsQ.data?.pages.flatMap((p) => p.items) ?? [];
  const users: Record<string, IgUserLite> = Object.assign(
    {},
    ...(eventsQ.data?.pages.map((p) => p.users ?? {}) ?? []),
  );
  const isLoading = eventsQ.isPending;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Activity</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every event the system records — incoming webhooks, comments, DMs, and failures
          (including DMs we couldn't deliver). The full diagnostic feed.
        </p>
      </div>

      <AutomationHealthStrip stats={statsQ.data} isLoading={statsQ.isLoading} />

      <div className="flex flex-wrap items-center gap-2">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setKind(f.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              kind === f.value
                ? "border-foreground/40 bg-accent/40 text-foreground"
                : "text-muted-foreground hover:bg-accent/20",
            )}
            type="button"
          >
            {f.label}
          </button>
        ))}
      </div>

      {eventsQ.isError ? (
        <LoadFailed what="the event log" onRetry={() => void eventsQ.refetch()} />
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon className="size-5" />}
          title="No events yet"
          description="System events will appear here as comments and DMs come in."
        />
      ) : (
        <ol className="relative space-y-3 border-l border-border pl-5">
          {items.map((e) => {
            const uid = eventUserId(e.payload);
            const label = uid ? displayUser(uid, users[uid]) : null;
            return (
              <EventRow
                key={e.id}
                event={e}
                showKindRaw
                userLabel={label}
                userId={uid}
                onUserClick={(id) => setLineageUser(id)}
              />
            );
          })}
        </ol>
      )}

      {eventsQ.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="ghost"
            onClick={() => eventsQ.fetchNextPage()}
            disabled={eventsQ.isFetchingNextPage}
          >
            {eventsQ.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <Drawer
        open={lineageUser !== null}
        onClose={() => setLineageUser(null)}
        title="User journey"
      >
        {lineageUser && <UserLineage igUserId={lineageUser} />}
      </Drawer>
    </div>
  );
}
