import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Tag, Trash2, MessageSquare, Globe } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRead, apiMutation, ApiError } from "@/lib/api";
import type { Keyword, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, LoadFailed } from "@/components/EmptyState";
import { KeywordForm } from "@/components/KeywordForm";

export function Keywords() {
  const qc = useQueryClient();
  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: ({ signal }) => apiRead<Keyword[]>("/keywords", { signal }),
  });
  const resourcesQ = useQuery<Resource[]>({
    queryKey: ["resources"],
    queryFn: ({ signal }) => apiRead<Resource[]>("/resources", { signal }),
  });

  const [editing, setEditing] = useState<Keyword | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Keyword | null>(null);
  const drawerOpen = creating || editing !== null;

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiMutation<Keyword>(`/keywords/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: ["keywords"] });
      const prev = qc.getQueryData<Keyword[]>(["keywords"]);
      qc.setQueryData<Keyword[]>(["keywords"], (old) =>
        old?.map((k) => (k.id === id ? { ...k, active } : k)) ?? [],
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["keywords"], ctx.prev);
      toast.error("Could not toggle keyword");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["keywords"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiMutation(`/keywords/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Keyword deleted");
      qc.invalidateQueries({ queryKey: ["keywords"] });
      setConfirmDelete(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    },
  });

  const isLoading = keywordsQ.isPending || resourcesQ.isPending;

  // Grouped by post, because a keyword now belongs to one post and the same word
  // can legitimately appear on several with different guides — a flat list of six
  // rows all reading "SLEEP" would be unreadable. The legacy globals get their own
  // group at the end, since they behave differently (they answer any post that has
  // no keywords of its own).
  const groups = useMemo(() => {
    const byPost = new Map<string, { label: string; permalink: string | null; items: Keyword[] }>();
    const globals: Keyword[] = [];
    for (const k of keywordsQ.data ?? []) {
      if (!k.mediaId) {
        globals.push(k);
        continue;
      }
      const g = byPost.get(k.mediaId) ?? {
        label: k.mediaCaption?.trim() || "Untitled post",
        permalink: k.mediaPermalink,
        items: [],
      };
      g.items.push(k);
      byPost.set(k.mediaId, g);
    }
    return { byPost: [...byPost.entries()], globals };
  }, [keywordsQ.data]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Keywords</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Words people comment on a post to trigger a DM sequence. Each keyword belongs to one
            post, so the same word can send a different guide per post.
          </p>
        </div>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New keyword
        </Button>
      </div>

      {keywordsQ.isError ? (
        <LoadFailed what="your keywords" onRetry={() => void keywordsQ.refetch()} />
      ) : isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (keywordsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Tag className="size-5" />}
          title="No keywords yet"
          description="Add the first word your audience will comment to trigger a DM sequence."
          action={
            <Button variant="brand" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Create keyword
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.byPost.map(([mediaId, g]) => (
            <section key={mediaId} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h3 className="truncate text-sm font-medium">{g.label}</h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {g.items.length} keyword{g.items.length === 1 ? "" : "s"}
                </span>
                {g.permalink && (
                  <a
                    href={g.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    View post
                  </a>
                )}
              </div>
              <KeywordList
                items={g.items}
                onToggle={(id, active) => toggleMutation.mutate({ id, active })}
                onEdit={setEditing}
                onDelete={setConfirmDelete}
              />
            </section>
          ))}

          {groups.globals.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium">Global (legacy)</h3>
                <span className="text-xs text-muted-foreground">
                  {groups.globals.length} keyword{groups.globals.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                These fire on any post that has no keywords of its own. Attach a keyword to a
                post and that post stops using these.
              </p>
              <KeywordList
                items={groups.globals}
                onToggle={(id, active) => toggleMutation.mutate({ id, active })}
                onEdit={setEditing}
                onDelete={setConfirmDelete}
              />
            </section>
          )}
        </div>
      )}

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? "Edit keyword" : "New keyword"}
        description={
          editing
            ? "Tweak how this trigger replies and gates the sequence."
            : "Define the word, the public reply, and the DM that asks for confirmation."
        }
      >
        {drawerOpen && (
          <KeywordForm
            initial={editing}
            resources={resourcesQ.data ?? []}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete "${confirmDelete?.keyword}"?`}
        description="This removes the keyword and any tracking against it. The sequence stays intact."
        destructive
        confirmLabel="Delete"
        busy={deleteMutation.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
      />
    </div>
  );
}

function KeywordRow({
  k,
  onToggle,
  onEdit,
  onDelete,
}: {
  k: Keyword;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="group transition-colors hover:bg-accent/40">
      <CardContent className="flex items-center gap-4 p-4">
        <button
          onClick={onEdit}
          className="flex min-w-0 flex-1 items-center gap-4 text-left"
          type="button"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-gradient/15 text-foreground">
            <Tag className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold tracking-wide">{k.keyword}</span>
              <ScopeBadge k={k} />
              {!k.active && (
                <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Paused
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              → {k.resource?.name ?? "Unknown sequence"}
              {k.resource && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <MessageSquare className="size-3" />
                  {k.resource._count.messages}{" "}
                  {k.resource._count.messages === 1 ? "step" : "steps"}
                </span>
              )}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <Switch
            checked={k.active}
            onCheckedChange={onToggle}
            aria-label={k.active ? "Pause keyword" : "Activate keyword"}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Delete keyword"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The animated row list, shared by every post group and the legacy section. */
function KeywordList({
  items,
  onToggle,
  onEdit,
  onDelete,
}: {
  items: Keyword[];
  onToggle: (id: string, active: boolean) => void;
  onEdit: (k: Keyword) => void;
  onDelete: (k: Keyword) => void;
}) {
  return (
    <ul className="space-y-2">
      <AnimatePresence initial={false}>
        {items.map((k, i) => (
          <motion.li
            key={k.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, delay: i * 0.02 }}
          >
            <KeywordRow
              k={k}
              onToggle={(active) => onToggle(k.id, active)}
              onEdit={() => onEdit(k)}
              onDelete={() => onDelete(k)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

/**
 * Marks a keyword as one of the legacy globals.
 *
 * Post-scoped keywords get nothing: the list is grouped by post, and the group
 * header already names it — repeating the caption on every row would be noise.
 */
function ScopeBadge({ k }: { k: Keyword }) {
  if (k.mediaId) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Globe className="size-2.5" />
      Global
    </span>
  );
}
