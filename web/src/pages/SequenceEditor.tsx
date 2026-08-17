import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Plus,
  Trash2,
  Type as TypeIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { MessageType, Resource, ResourceMessage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadFailed } from "@/components/EmptyState";
import { MediaUpload } from "@/components/MediaUpload";
import { PhoneMockup } from "@/components/PhoneMockup";
import { SaveStatus } from "@/components/SaveStatus";
import { cn } from "@/lib/utils";
import { messageBudget } from "@/lib/messageLimits";

const STEP_TYPES: { value: MessageType; label: string; icon: typeof TypeIcon }[] = [
  { value: "text", label: "Text", icon: TypeIcon },
  { value: "image", label: "Image", icon: ImageIcon },
  { value: "pdf", label: "PDF", icon: FileText },
];

export function SequenceEditor() {
  const { id } = useParams<{ id: string }>();
  const resourceQ = useQuery<Resource>({
    queryKey: ["resource", id],
    queryFn: () => api<Resource>(`/resources/${id}`),
    enabled: !!id,
  });

  const messagesQ = useQuery<ResourceMessage[]>({
    queryKey: ["resource-messages", id],
    queryFn: () => api<ResourceMessage[]>(`/messages/by-resource/${id}`),
    enabled: !!id,
  });

  const isLoading = resourceQ.isLoading || messagesQ.isLoading;

  // A failed fetch used to fall through to "Sequence not found", which reads as
  // "this was deleted" when it means "the API did not answer".
  if (resourceQ.isError || messagesQ.isError) {
    return (
      <LoadFailed
        what="this sequence"
        onRetry={() => {
          void resourceQ.refetch();
          void messagesQ.refetch();
        }}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!id || !resourceQ.data) {
    return (
      <div className="border-t pt-4">
        <p className="text-[13px] text-muted-foreground">Sequence not found.</p>
        <Button variant="ghost" asChild className="mt-2 -ml-3">
          <Link to="/sequences">
            <ArrowLeft className="size-4" />
            Back to Sequences
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <SequenceEditorForm
      key={resourceQ.data.id}
      id={id}
      resource={resourceQ.data}
      initialMessages={messagesQ.data ?? []}
    />
  );
}

function SequenceEditorForm({
  id,
  resource,
  initialMessages,
}: {
  id: string;
  resource: Resource;
  initialMessages: ResourceMessage[];
}) {
  const qc = useQueryClient();

  const [name, setName] = useState(resource.name);
  const [description, setDescription] = useState(resource.description ?? "");
  const [items, setItems] = useState<ResourceMessage[]>(initialMessages);

  const [confirmDelete, setConfirmDelete] = useState<ResourceMessage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // All editing mutations share this key so <SaveStatus> can reflect their
  // combined state as one "Saving… / All changes saved" indicator.
  const saveKey = ["sequence-save", id];

  const renameMutation = useMutation({
    mutationKey: saveKey,
    mutationFn: () =>
      api<Resource>(`/resources/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description: description || null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource", id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Save failed"),
  });

  const reorderMutation = useMutation({
    mutationKey: saveKey,
    mutationFn: ({ orderedIds }: { orderedIds: string[]; previous: ResourceMessage[] }) =>
      api<ResourceMessage[]>(`/messages/reorder/${id}`, {
        method: "POST",
        body: JSON.stringify({ messageIds: orderedIds }),
      }),
    onError: (err, { previous }) => {
      toast.error(err instanceof ApiError ? err.message : "Reorder failed");
      setItems(previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["resource-messages", id] }),
  });

  const addMutation = useMutation({
    mutationKey: saveKey,
    mutationFn: (type: MessageType) =>
      api<ResourceMessage>("/messages", {
        method: "POST",
        body: JSON.stringify({
          resourceId: id,
          type,
          ...(type === "text" ? { body: "New step — edit me." } : {}),
          ...(type === "image" ? { mediaUrl: "https://placehold.co/600x400/EBE8DF/66665F?text=Upload+image" } : {}),
          ...(type === "pdf" ? { mediaUrl: "https://placehold.co/600x400/EBE8DF/66665F?text=Upload+PDF" } : {}),
        }),
      }),
    onSuccess: (next) => {
      setItems((current) => [...current, next].sort((a, b) => a.order - b.order));
      qc.invalidateQueries({ queryKey: ["resource-messages", id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["resource", id] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Add step failed"),
  });

  const deleteMutation = useMutation({
    mutationKey: saveKey,
    mutationFn: (mid: string) => api(`/messages/${mid}`, { method: "DELETE" }),
    onSuccess: (_result, mid) => {
      setItems((current) => current.filter((message) => message.id !== mid));
      qc.invalidateQueries({ queryKey: ["resource-messages", id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["resource", id] });
      setConfirmDelete(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Delete failed"),
  });

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((m) => m.id === active.id);
    const newIndex = items.findIndex((m) => m.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    reorderMutation.mutate({ orderedIds: next.map((m) => m.id), previous: items });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/sequences" aria-label="Back">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (
                  name.trim() &&
                  (name !== resource.name ||
                    (description || null) !== (resource.description ?? null))
                ) {
                  renameMutation.mutate();
                }
              }}
              className="h-auto border-transparent bg-transparent px-0 text-2xl font-medium tracking-tight focus-visible:ring-0"
              placeholder="Sequence name"
            />
            {id && <SaveStatus sequenceId={id} />}
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              if ((description || null) !== (resource.description ?? null)) {
                renameMutation.mutate();
              }
            }}
            rows={1}
            placeholder="Internal note — what this sequence is for."
            className="resize-none border-transparent bg-transparent px-0 text-[13px] text-muted-foreground focus-visible:ring-0"
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="label-caps">Steps</h3>
            <div className="flex gap-1">
              {STEP_TYPES.map(({ value, label, icon: Icon }) => (
                <Button
                  key={value}
                  size="sm"
                  variant="outline"
                  onClick={() => addMutation.mutate(value)}
                  disabled={addMutation.isPending}
                >
                  <Icon className="size-3.5" />
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {items.length === 0 ? (
            <div className="border-t py-10 text-center">
              <Plus className="mx-auto size-5 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-[13px] font-medium">No steps yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a Text, Image, or PDF step to start building this sequence.
              </p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext items={items.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-2">
                  {items.map((m, i) => (
                    <SortableStep
                      key={m.id}
                      step={m}
                      index={i}
                      onChange={(next) => {
                        setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)));
                      }}
                      onDelete={() => setConfirmDelete(m)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>

        <aside className="lg:sticky lg:top-4 self-start">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="label-caps">Preview</h3>
            <span className="label-caps">After DONE reply</span>
          </div>
          <PhoneMockup steps={items} />
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove this step?"
        description="Other steps will shift up to fill the gap."
        destructive
        confirmLabel="Remove"
        busy={deleteMutation.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
      />
    </div>
  );
}

function SortableStep({
  step,
  index,
  onChange,
  onDelete,
}: {
  step: ResourceMessage;
  index: number;
  onChange: (next: ResourceMessage) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const qc = useQueryClient();
  const savedBody = useRef(step.body);

  const patchMutation = useMutation({
    mutationKey: ["sequence-save", step.resourceId],
    mutationFn: (data: Partial<Pick<ResourceMessage, "body" | "mediaUrl">>) =>
      api<ResourceMessage>(`/messages/${step.id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (_next, data) => {
      if (data.body !== undefined) savedBody.current = data.body ?? null;
      qc.invalidateQueries({ queryKey: ["resource-messages", step.resourceId] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const Icon =
    step.type === "text" ? TypeIcon : step.type === "image" ? ImageIcon : FileText;

  const budget = messageBudget(step.body ?? "");

  return (
    <li ref={setNodeRef} style={style}>
      <motion.div layout>
        <Card className={cn("transition-shadow", isDragging && "shadow-2xl")}>
          <CardContent className="flex items-start gap-3 p-4">
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="mt-1 cursor-grab text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
              aria-label="Drag to reorder"
            >
              <GripVertical className="size-4" />
            </button>
            <div className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-signal-soft text-signal">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="label-caps">Step {index + 1} · {step.type}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={onDelete}
                  aria-label="Delete step"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              {(step.type === "image" || step.type === "pdf") && (
                <div className="space-y-2">
                  <Label>{step.type === "image" ? "Image" : "PDF"}</Label>
                  <MediaUpload
                    kind={step.type}
                    value={step.mediaUrl}
                    onChange={(url) => {
                      onChange({ ...step, mediaUrl: url });
                      patchMutation.mutate({ mediaUrl: url });
                    }}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label>
                    {step.type === "text" ? "Message" : "Caption (optional)"}
                  </Label>
                  {/* Characters. This read bytes for one day, which would have
                      shown "1,005 / 1,000 — over" on the first step of a guide
                      that delivers to ~194 people a month. See
                      lib/messageLimits.ts for what settled it. */}
                  <span
                    className={cn(
                      "label-caps tabular-nums",
                      budget.level === "over" && "text-urgent",
                    )}
                    aria-live="polite"
                  >
                    {budget.chars.toLocaleString()} / {budget.limit.toLocaleString()} characters
                  </span>
                </div>
                <Textarea
                  value={step.body ?? ""}
                  onChange={(e) => onChange({ ...step, body: e.target.value })}
                  onBlur={() => {
                    const value = step.body ?? "";
                    const next = value.trim() ? value : null;
                    if (next !== savedBody.current) patchMutation.mutate({ body: next });
                  }}
                  rows={step.type === "text" ? 3 : 2}
                  placeholder={
                    step.type === "text"
                      ? "What you want them to read."
                      : "Optional caption sent with the file."
                  }
                  className={cn(budget.level === "over" && "border-urgent")}
                />
                {budget.level === "over" && (
                  <p className="text-xs leading-relaxed text-urgent">
                    {budget.over.toLocaleString()} characters over Instagram&rsquo;s limit — this
                    step will not send.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </li>
  );
}
