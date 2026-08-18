import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert, Layers, MessageSquare, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, apiRead, ApiError } from "@/lib/api";
import type { Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, LoadFailed } from "@/components/EmptyState";

export function Sequences() {
  const qc = useQueryClient();
  const resourcesQ = useQuery<Resource[]>({
    queryKey: ["resources"],
    queryFn: ({ signal }) => apiRead<Resource[]>("/resources", { signal }),
  });

  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Resource | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/resources/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Sequence deleted");
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["keywords"] });
      setConfirmDelete(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Delete failed"),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Sequences</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The DMs that get sent after a follower replies DONE.
          </p>
        </div>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New sequence
        </Button>
      </div>

      {resourcesQ.isError ? (
        <LoadFailed what="your sequences" onRetry={() => void resourcesQ.refetch()} />
      ) : resourcesQ.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (resourcesQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Layers className="size-5" />}
          title="No sequences yet"
          description="A sequence is a list of DMs (text, image, PDF) sent in order after the user replies DONE."
          action={
            <Button variant="brand" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Create sequence
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          <AnimatePresence initial={false}>
            {resourcesQ.data!.map((r, i) => (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, delay: i * 0.03 }}
              >
                <SequenceCard
                  r={r}
                  onDelete={() => setConfirmDelete(r)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title="New sequence"
        description="Give it a name and a short description. You'll add the DMs next."
      >
        {creating && <CreateSequenceForm onClose={() => setCreating(false)} />}
      </Drawer>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete "${confirmDelete?.name}"?`}
        description={
          (confirmDelete?._count?.keywords ?? 0) > 0
            ? `This sequence is used by ${confirmDelete?._count?.keywords} keyword${confirmDelete?._count?.keywords === 1 ? "" : "s"}. Deleting it will leave them without a target.`
            : "All steps in this sequence will be removed."
        }
        destructive
        confirmLabel="Delete"
        busy={deleteMutation.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
      />
    </div>
  );
}

function SequenceCard({ r, onDelete }: { r: Resource; onDelete: () => void }) {
  const stepCount = r._count?.messages ?? 0;
  const kwCount = r._count?.keywords ?? 0;
  return (
    <Card className="group transition-all hover:shadow-lg hover:-translate-y-0.5">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <Link to={`/sequences/${r.id}`} className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-md bg-brand-gradient/15 text-foreground">
                <Layers className="size-4" />
              </div>
              <h3 className="truncate font-semibold tracking-tight">{r.name}</h3>
            </div>
            {r.description && (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{r.description}</p>
            )}
            {(r.invalidMessageCount ?? 0) > 0 && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                <CircleAlert className="size-3.5" />
                {r.invalidMessageCount} {r.invalidMessageCount === 1 ? "message needs" : "messages need"} attention
              </span>
            )}
          </Link>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Delete sequence"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {stepCount} {stepCount === 1 ? "step" : "steps"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Tag className="size-3.5" />
            {kwCount} {kwCount === 1 ? "keyword" : "keywords"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateSequenceForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      api<Resource>("/resources", {
        method: "POST",
        body: JSON.stringify({ name, description: description || null }),
      }),
    onSuccess: () => {
      toast.success("Sequence created");
      qc.invalidateQueries({ queryKey: ["resources"] });
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Create failed"),
  });

  const canSave = name.trim().length > 0 && !createMutation.isPending;

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) createMutation.mutate();
      }}
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Toddler Activity Guide"
            autoFocus
            required
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Internal note — what this sequence is for."
            rows={3}
            maxLength={500}
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2 border-t pt-5">
        <Button type="button" variant="ghost" onClick={onClose} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" disabled={!canSave}>
          {createMutation.isPending ? "Creating…" : "Create sequence"}
        </Button>
      </div>
    </form>
  );
}
