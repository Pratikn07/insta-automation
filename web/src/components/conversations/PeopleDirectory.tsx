import { useQuery } from "@tanstack/react-query";
import { Users as UsersIcon, User, Search } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { UserDirItem } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, LoadFailed } from "@/components/EmptyState";
import { FollowBadge } from "@/components/FollowBadge";
import { displayUser } from "@/lib/utils";

/**
 * People: the same conversations, indexed by person instead of by event.
 *
 * This was the /users page. It is a lens rather than a destination because it is
 * not a different subject — `users.routes.ts` builds the directory from
 * Conversation.igUserId, and clicking a row opens the same UserLineage drawer a
 * conversation row opens. Two rail entries for one dataset made the reader choose
 * an entry point before knowing which one held their answer.
 *
 * It is a lens where DM recovery is not, and the line between them is what the
 * control does, not how related the data is: everything in this filter row reads
 * what already happened. Nothing here sends.
 */
export function PeopleDirectory({ onSelect }: { onSelect: (igUserId: string) => void }) {
  const [q, setQ] = useState("");

  const usersQ = useQuery<{ items: UserDirItem[] }>({
    queryKey: ["users", q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      return api<{ items: UserDirItem[] }>(`/users?${params.toString()}`);
    },
  });

  const items = usersQ.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by @username or name…"
          className="w-full rounded-md border bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:border-foreground/40"
        />
      </div>

      {usersQ.isError ? (
        <LoadFailed what="the directory" onRetry={() => void usersQ.refetch()} />
      ) : usersQ.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UsersIcon className="size-5" />}
          title={q ? "No matches" : "No people yet"}
          description={
            q
              ? "Try a different name or username."
              : "When people comment or DM your keywords, they'll show up here."
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((u) => (
            <li key={u.igUserId}>
              <Card className="group transition-colors hover:bg-accent/40">
                <CardContent className="p-0">
                  <button
                    type="button"
                    onClick={() => onSelect(u.igUserId)}
                    className="flex w-full items-center gap-4 p-4 text-left"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <User className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {displayUser(u.igUserId, u)}
                      </div>
                      {u.name && (
                        <div className="truncate text-xs text-muted-foreground">{u.name}</div>
                      )}
                      <FollowBadge user={u} showPending className="mt-1" />
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {u.conversationCount} {u.conversationCount === 1 ? "trigger" : "triggers"}
                    </span>
                  </button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
