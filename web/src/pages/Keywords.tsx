import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Tag, Trash2, MessageSquare, Film, Globe } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Keyword, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { KeywordForm } from "@/components/KeywordForm";

export function Keywords() {
  const qc = useQueryClient();
  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: () => api<Keyword[]>("/keywords"),
  });
  const resourcesQ = useQuery<Resource[]>({
    queryKey: ["resources"],
    queryFn: () => api<Resource[]>("/resources"),
  });

  const [editing, setEditing] = useState<Keyword | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Keyword | null>(null);
  const drawerOpen = creating || editing !== null;

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<Keyword>(`/keywords/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
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
    mutationFn: (id: string) => api(`/keywords/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Keyword deleted");
      qc.invalidateQueries({ queryKey: ["keywords"] });
      setConfirmDelete(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    },
  });

  const isLoading = keywordsQ.isLoading || resourcesQ.isLoading;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Keywords</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Words people comment on a reel to trigger a DM sequence.
          </p>
        </div>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New keyword
        </Button>
      </div>

      {isLoading ? (
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
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {keywordsQ.data!.map((k, i) => (
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
                  onToggle={(active) => toggleMutation.mutate({ id: k.id, active })}
                  onEdit={() => setEditing(k)}
                  onDelete={() => setConfirmDelete(k)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
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

function ScopeBadge({ k }: { k: Keyword }) {
  if (!k.mediaId) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Globe className="size-2.5" />
        Global
      </span>
    );
  }

  const label = k.mediaCaption?.trim().slice(0, 24) || "Reel";
  const badge = (
    <span className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-brand-gradient/40 bg-brand-gradient/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground">
      <Film className="size-2.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );

  if (!k.mediaPermalink) return badge;
  return (
    <a
      href={k.mediaPermalink}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={k.mediaCaption ?? "Open reel"}
    >
      {badge}
    </a>
  );
}
