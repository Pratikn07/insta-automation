import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Tag, Trash2, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Keyword, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

type SequenceMode = "new" | "existing";

interface KeywordFormState {
  keyword: string;
  sequenceMode: SequenceMode;
  newSequenceName: string;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
}

const emptyForm: KeywordFormState = {
  keyword: "",
  sequenceMode: "new",
  newSequenceName: "",
  resourceId: "",
  publicReply: "Check your DMs! 💌",
  gateMessage: "Reply DONE to receive your guide.",
  active: true,
};

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

function KeywordForm({
  initial,
  resources,
  onClose,
}: {
  initial: Keyword | null;
  resources: Resource[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<KeywordFormState>(() =>
    initial
      ? {
          keyword: initial.keyword,
          sequenceMode: "existing",
          newSequenceName: "",
          resourceId: initial.resourceId,
          publicReply: initial.publicReply,
          gateMessage: initial.gateMessage,
          active: initial.active,
        }
      : { ...emptyForm },
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{ keyword: Keyword; createdSequence: boolean }> => {
      if (initial) {
        const updated = await api<Keyword>(`/keywords/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            keyword: form.keyword,
            resourceId: form.resourceId,
            publicReply: form.publicReply,
            gateMessage: form.gateMessage,
            active: form.active,
          }),
        });
        return { keyword: updated, createdSequence: false };
      }

      let resourceId = form.resourceId;
      let createdSequence = false;
      if (form.sequenceMode === "new") {
        const seq = await api<Resource>("/resources", {
          method: "POST",
          body: JSON.stringify({
            name: form.newSequenceName.trim(),
            description: null,
          }),
        });
        resourceId = seq.id;
        createdSequence = true;
      }

      const created = await api<Keyword>("/keywords", {
        method: "POST",
        body: JSON.stringify({
          keyword: form.keyword,
          resourceId,
          publicReply: form.publicReply,
          gateMessage: form.gateMessage,
          active: form.active,
        }),
      });
      return { keyword: created, createdSequence };
    },
    onSuccess: ({ keyword, createdSequence }) => {
      toast.success(initial ? "Keyword updated" : "Keyword created");
      qc.invalidateQueries({ queryKey: ["keywords"] });
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      onClose();
      if (createdSequence) {
        navigate(`/sequences/${keyword.resourceId}`);
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("That keyword already exists");
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Save failed");
    },
  });

  const sequenceValid = initial
    ? form.resourceId.length > 0
    : form.sequenceMode === "new"
      ? form.newSequenceName.trim().length > 0
      : form.resourceId.length > 0;

  const canSave =
    form.keyword.trim().length > 0 &&
    sequenceValid &&
    form.publicReply.trim().length > 0 &&
    form.gateMessage.trim().length > 0 &&
    !saveMutation.isPending;

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) saveMutation.mutate();
      }}
    >
      <div className="space-y-5">
        <Field label="Keyword" hint="Auto-uppercased. People comment this exactly to trigger.">
          <Input
            value={form.keyword}
            onChange={(e) => setForm((f) => ({ ...f, keyword: e.target.value }))}
            placeholder="RECIPE"
            autoFocus
            required
          />
        </Field>

        <div className="space-y-2">
          <Label>Sequence</Label>
          {initial ? (
            <Select
              value={form.resourceId}
              onChange={(e) => setForm((f) => ({ ...f, resourceId: e.target.value }))}
              required
            >
              <option value="" disabled>
                Pick a sequence
              </option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r._count ? ` — ${r._count.messages} step${r._count.messages === 1 ? "" : "s"}` : ""}
                </option>
              ))}
            </Select>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ModeButton
                  active={form.sequenceMode === "new"}
                  onClick={() => setForm((f) => ({ ...f, sequenceMode: "new" }))}
                  title="Create new"
                  subtitle="Build a fresh DM flow"
                />
                <ModeButton
                  active={form.sequenceMode === "existing"}
                  onClick={() => setForm((f) => ({ ...f, sequenceMode: "existing" }))}
                  title="Use existing"
                  subtitle={
                    resources.length > 0
                      ? `${resources.length} available`
                      : "None yet"
                  }
                  disabled={resources.length === 0}
                />
              </div>
              {form.sequenceMode === "new" ? (
                <Input
                  value={form.newSequenceName}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, newSequenceName: e.target.value }))
                  }
                  placeholder="Toddler Activity Guide"
                  required
                  maxLength={120}
                />
              ) : (
                <Select
                  value={form.resourceId}
                  onChange={(e) => setForm((f) => ({ ...f, resourceId: e.target.value }))}
                  required
                >
                  <option value="" disabled>
                    Pick a sequence
                  </option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r._count
                        ? ` — ${r._count.messages} step${r._count.messages === 1 ? "" : "s"}`
                        : ""}
                    </option>
                  ))}
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                {form.sequenceMode === "new"
                  ? "We'll create the sequence and drop you into the editor to add steps."
                  : "Reuse an existing sequence — useful for spelling variations of the same trigger."}
              </p>
            </>
          )}
        </div>

        <Field
          label="Public reply"
          hint="What you reply on the comment, visible to everyone. Keep it teasing."
        >
          <Input
            value={form.publicReply}
            onChange={(e) => setForm((f) => ({ ...f, publicReply: e.target.value }))}
            placeholder="Check your DMs! 💌"
            required
            maxLength={280}
          />
        </Field>

        <Field
          label="Gate DM"
          hint="The first private DM. Asks them to reply DONE so we can send the rest (and unlocks 24h window)."
        >
          <Textarea
            value={form.gateMessage}
            onChange={(e) => setForm((f) => ({ ...f, gateMessage: e.target.value }))}
            placeholder="Reply DONE and I'll send your guide!"
            required
            maxLength={1000}
            rows={3}
          />
        </Field>

        <div className="flex items-center justify-between rounded-md border bg-card/40 p-3">
          <div>
            <Label className="text-xs">Active</Label>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {form.active ? "Listening for new comments." : "Paused — comments will be ignored."}
            </p>
          </div>
          <Switch
            checked={form.active}
            onCheckedChange={(active) => setForm((f) => ({ ...f, active }))}
          />
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t pt-5">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saveMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" disabled={!canSave}>
          {saveMutation.isPending
            ? "Saving…"
            : initial
              ? "Save changes"
              : form.sequenceMode === "new"
                ? "Create & add steps"
                : "Create keyword"}
        </Button>
      </div>
    </form>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  subtitle,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border bg-card/40 p-3 text-left transition-colors",
        active && "border-foreground/40 bg-accent/40",
        !active && !disabled && "hover:bg-accent/20",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
