import { useQuery } from "@tanstack/react-query";
import { Users as UsersIcon, User, Search } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { UserDirItem } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, LoadFailed } from "@/components/EmptyState";
import { UserLineage } from "@/components/UserLineage";
import { FollowBadge } from "@/components/FollowBadge";
import { displayUser } from "@/lib/utils";

export function Users() {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<UserDirItem | null>(null);

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
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Users</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone who triggered a keyword. Click a user to see their full journey —
          comment, gate DM, replies, and the sequence we delivered.
        </p>
      </div>

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
          title={q ? "No matches" : "No users yet"}
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
                    onClick={() => setSelected(u)}
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

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? displayUser(selected.igUserId, selected) : undefined}
        description={selected?.name ?? selected?.igUserId}
      >
        {selected && <UserLineage igUserId={selected.igUserId} />}
      </Drawer>
    </div>
  );
}
