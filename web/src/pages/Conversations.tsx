import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  MessageCircle,
  Tag,
  User,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Conversation, ConversationState, Paginated } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

type StateFilter = ConversationState | "all";

const FILTERS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "awaiting_done", label: "Awaiting DONE" },
  { value: "completed", label: "Completed" },
  { value: "expired", label: "Expired" },
];

const stateMeta: Record<ConversationState, { label: string; tone: string; Icon: typeof Clock }> = {
  awaiting_done: { label: "Awaiting DONE", tone: "text-amber-400 bg-amber-400/10", Icon: Clock },
  completed: { label: "Completed", tone: "text-emerald-400 bg-emerald-400/10", Icon: CheckCircle2 },
  expired: { label: "Expired", tone: "text-muted-foreground bg-muted/40", Icon: AlertCircle },
};

export function Conversations() {
  const [filter, setFilter] = useState<StateFilter>("all");
  const [selected, setSelected] = useState<Conversation | null>(null);

  const conversationsQ = useInfiniteQuery({
    queryKey: ["conversations", filter],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("state", filter);
      if (pageParam) params.set("cursor", pageParam);
      return api<Paginated<Conversation>>(`/conversations?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = conversationsQ.data?.pages.flatMap((p) => p.items) ?? [];
  const isLoading = conversationsQ.isLoading;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Conversations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every comment that triggered a keyword. Click a row to see the full event log.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-foreground/40 bg-accent/40 text-foreground"
                : "text-muted-foreground hover:bg-accent/20",
            )}
            type="button"
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MessageCircle className="size-5" />}
          title="No conversations yet"
          description="When someone comments a keyword on one of your reels, it shows up here."
        />
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {items.map((c, i) => (
              <motion.li
                key={c.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.3) }}
              >
                <ConversationRow c={c} onClick={() => setSelected(c)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {conversationsQ.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="ghost"
            onClick={() => conversationsQ.fetchNextPage()}
            disabled={conversationsQ.isFetchingNextPage}
          >
            {conversationsQ.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Conversation"
        description={
          selected
            ? `${selected.igUserId} · ${formatRelative(selected.createdAt)}`
            : undefined
        }
      >
        {selected && <ConversationDetail conversationId={selected.id} />}
      </Drawer>
    </div>
  );
}

function ConversationRow({ c, onClick }: { c: Conversation; onClick: () => void }) {
  const meta = stateMeta[c.state];
  return (
    <Card className="group transition-colors hover:bg-accent/40">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-4 p-4 text-left"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {c.igUserId}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Tag className="size-3" />
                {c.keyword.keyword}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatRelative(c.createdAt)}
              {c.completedAt && ` · completed ${formatRelative(c.completedAt)}`}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
              meta.tone,
            )}
          >
            <meta.Icon className="size-3" />
            {meta.label}
          </span>
        </button>
      </CardContent>
    </Card>
  );
}

interface ConversationDetailResponse {
  conversation: Conversation & {
    keyword: {
      id: string;
      keyword: string;
      resource: { id: string; name: string };
    };
  };
  events: { id: string; kind: string; payload: unknown; createdAt: string }[];
}

function ConversationDetail({ conversationId }: { conversationId: string }) {
  const detailQ = useQuery<ConversationDetailResponse>({
    queryKey: ["conversation-detail", conversationId],
    queryFn: () => api<ConversationDetailResponse>(`/conversations/${conversationId}/events`),
  });

  if (detailQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (detailQ.error || !detailQ.data) {
    return <p className="text-sm text-destructive">Could not load conversation.</p>;
  }

  const { conversation, events } = detailQ.data;
  const meta = stateMeta[conversation.state];

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-card/40 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">{conversation.igUserId}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
              meta.tone,
            )}
          >
            <meta.Icon className="size-3" />
            {meta.label}
          </span>
        </div>
        <div className="mt-3 space-y-1 text-sm">
          <DetailRow label="Keyword" value={conversation.keyword.keyword} mono />
          <DetailRow label="Sequence" value={conversation.keyword.resource.name} />
          <DetailRow label="Started" value={formatAbsolute(conversation.createdAt)} />
          {conversation.completedAt && (
            <DetailRow label="Completed" value={formatAbsolute(conversation.completedAt)} />
          )}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Event log
        </h4>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded yet.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-border pl-5">
            {events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-brand-gradient" />
                <div className="text-sm font-medium">{prettyKind(e.kind)}</div>
                <div className="text-xs text-muted-foreground">{formatAbsolute(e.createdAt)}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function prettyKind(kind: string): string {
  switch (kind) {
    case "comment_received":
      return "Comment received";
    case "keyword_matched":
      return "Keyword matched";
    case "public_reply_sent":
      return "Public reply posted";
    case "dm_sent":
      return "Gate DM sent";
    case "done_received":
      return "User replied DONE";
    case "sequence_completed":
      return "Sequence delivered";
    case "sequence_failed":
      return "Sequence failed";
    default:
      return kind.replace(/_/g, " ");
  }
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
