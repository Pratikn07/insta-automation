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
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Plus,
  Save as SaveIcon,
  Trash2,
  Type as TypeIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, apiErrorCode, ApiError } from "@/lib/api";
import type { MessageType, Resource, ResourceMessage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MediaUpload } from "@/components/MediaUpload";
import { PhoneMockup } from "@/components/PhoneMockup";
import { SaveStatus } from "@/components/SaveStatus";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { cn } from "@/lib/utils";
import {
  countInstagramCodeUnits,
  GUIDE_MESSAGE_LIMIT_GUIDANCE,
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  INSTAGRAM_GUIDE_WARNING_AT,
  MESSAGE_BODY_TOO_LONG_ERROR,
} from "@shared/guideMessagePolicy";

const STEP_TYPES: { value: MessageType; label: string; icon: typeof TypeIcon }[] = [
  { value: "text", label: "Text", icon: TypeIcon },
  { value: "image", label: "Image", icon: ImageIcon },
  { value: "pdf", label: "PDF", icon: FileText },
];

type TextSaveTarget =
  | { kind: "resource"; name: string; description: string }
  | { kind: "message"; id: string; body: string | null };

type TextSaveResult =
  | { target: TextSaveTarget; ok: true }
  | { target: TextSaveTarget; ok: false; error: unknown };

function normalizeMessageBody(body: string | null) {
  return body?.trim() ? body : null;
}

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
      <Card>
        <CardContent className="p-8">
          <p className="text-sm text-muted-foreground">Sequence not found.</p>
          <Button variant="ghost" asChild className="mt-3">
            <Link to="/sequences">
              <ArrowLeft className="size-4" />
              Back to Sequences
            </Link>
          </Button>
        </CardContent>
      </Card>
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
  const [savedResource, setSavedResource] = useState({
    name: resource.name,
    description: resource.description ?? "",
  });
  const [savedBodies, setSavedBodies] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      initialMessages.map((message) => [message.id, normalizeMessageBody(message.body)]),
    ),
  );
  const [serverBodyTooLongIds, setServerBodyTooLongIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [saveFailed, setSaveFailed] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<ResourceMessage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // All editing mutations share this key so <SaveStatus> can reflect their
  // combined state as one "Saving… / All changes saved" indicator.
  const saveKey = ["sequence-save", id];
  const saving = useIsMutating({ mutationKey: saveKey }) > 0;
  const dirtyResource =
    name !== savedResource.name || description !== savedResource.description;
  const dirtyMessages = items.filter(
    (message) =>
      normalizeMessageBody(message.body) !== (savedBodies[message.id] ?? null),
  );
  const dirty = dirtyResource || dirtyMessages.length > 0;
  const needsAttention =
    serverBodyTooLongIds.size > 0 ||
    items.some(
      (message) =>
        countInstagramCodeUnits(message.body ?? "") > INSTAGRAM_GUIDE_TEXT_LIMIT,
    );
  const canSave = dirty && !saving && !needsAttention && name.trim().length > 0;

  const textSaveMutation = useMutation({
    mutationKey: saveKey,
    mutationFn: (targets: TextSaveTarget[]) =>
      Promise.all(
        targets.map(async (target): Promise<TextSaveResult> => {
          try {
            if (target.kind === "resource") {
              await api<Resource>(`/resources/${id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: target.name,
                  description: target.description || null,
                }),
              });
            } else {
              await api<ResourceMessage>(`/messages/${target.id}`, {
                method: "PATCH",
                body: JSON.stringify({ body: target.body }),
              });
            }
            return { target, ok: true };
          } catch (error) {
            return { target, ok: false, error };
          }
        }),
      ),
    onSuccess: (results) => {
      const successfulMessages: Extract<TextSaveTarget, { kind: "message" }>[] = [];
      const failedResults: Extract<TextSaveResult, { ok: false }>[] = [];
      let successfulResource: Extract<TextSaveTarget, { kind: "resource" }> | null = null;

      for (const result of results) {
        if (!result.ok) {
          failedResults.push(result);
          continue;
        }
        if (result.target.kind === "resource") successfulResource = result.target;
        else successfulMessages.push(result.target);
      }

      if (successfulResource) {
        setSavedResource({
          name: successfulResource.name,
          description: successfulResource.description,
        });
        qc.invalidateQueries({ queryKey: ["resource", id] });
        qc.invalidateQueries({ queryKey: ["resources"] });
      }
      if (successfulMessages.length > 0) {
        setSavedBodies((current) => {
          const next = { ...current };
          for (const target of successfulMessages) next[target.id] = target.body;
          return next;
        });
        qc.invalidateQueries({ queryKey: ["resource-messages", id] });
      }

      const bodyTooLongIds = new Set<string>();
      for (const result of failedResults) {
        if (
          result.target.kind === "message" &&
          apiErrorCode(result.error) === MESSAGE_BODY_TOO_LONG_ERROR
        ) {
          bodyTooLongIds.add(result.target.id);
        }
      }
      setServerBodyTooLongIds(bodyTooLongIds);
      setSaveFailed(failedResults.length > 0);

      const toastFailure = failedResults.find(
        (result) => apiErrorCode(result.error) !== MESSAGE_BODY_TOO_LONG_ERROR,
      );
      if (toastFailure) {
        toast.error(
          toastFailure.error instanceof ApiError ? toastFailure.error.message : "Save failed",
        );
      }
    },
  });

  const saveDrafts = useCallback(() => {
    if (!canSave) return;
    const targets: TextSaveTarget[] = [];
    if (dirtyResource) targets.push({ kind: "resource", name, description });
    for (const message of dirtyMessages) {
      targets.push({
        kind: "message",
        id: message.id,
        body: normalizeMessageBody(message.body),
      });
    }
    setSaveFailed(false);
    setServerBodyTooLongIds(new Set());
    textSaveMutation.mutate(targets);
  }, [canSave, description, dirtyMessages, dirtyResource, name, textSaveMutation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      saveDrafts();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveDrafts]);

  const blocker = useUnsavedChangesGuard(dirty || saving);

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
          ...(type === "image" ? { mediaUrl: "https://placehold.co/600x400/0a0a0a/666?text=Upload+image" } : {}),
          ...(type === "pdf" ? { mediaUrl: "https://placehold.co/600x400/0a0a0a/666?text=Upload+PDF" } : {}),
        }),
      }),
    onSuccess: (next) => {
      setItems((current) => [...current, next].sort((a, b) => a.order - b.order));
      setSavedBodies((current) => ({
        ...current,
        [next.id]: normalizeMessageBody(next.body),
      }));
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
      setSavedBodies((current) => {
        const next = { ...current };
        delete next[mid];
        return next;
      });
      setServerBodyTooLongIds((current) => {
        const next = new Set(current);
        next.delete(mid);
        return next;
      });
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
              onChange={(e) => {
                setSaveFailed(false);
                setName(e.target.value);
              }}
              className="border-transparent bg-transparent px-0 text-xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
              placeholder="Sequence name"
            />
            <div className="flex shrink-0 items-center gap-3">
              <SaveStatus
                sequenceId={id}
                dirty={dirty}
                needsAttention={needsAttention}
                saveFailed={saveFailed}
              />
              <Button size="sm" onClick={saveDrafts} disabled={!canSave}>
                <SaveIcon className="size-3.5" />
                Save changes
              </Button>
            </div>
          </div>
          <Textarea
            value={description}
            onChange={(e) => {
              setSaveFailed(false);
              setDescription(e.target.value);
            }}
            rows={1}
            placeholder="Internal note — what this sequence is for."
            className="border-transparent bg-transparent px-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0 resize-none"
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Steps
            </h3>
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
            <Card>
              <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <Plus className="size-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No steps yet</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Add a Text, Image, or PDF step to start building this sequence.
                  </p>
                </div>
              </CardContent>
            </Card>
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
                      serverBodyTooLong={serverBodyTooLongIds.has(m.id)}
                      onChange={(next) => {
                        setSaveFailed(false);
                        setServerBodyTooLongIds((current) => {
                          if (!current.has(next.id)) return current;
                          const updated = new Set(current);
                          updated.delete(next.id);
                          return updated;
                        });
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
            <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </h3>
            <span className="text-xs text-muted-foreground">After DONE reply</span>
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
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Discard unsaved changes?"
        description="Your latest sequence edits have not finished saving."
        confirmLabel="Leave without saving"
        destructive
        onCancel={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
        onConfirm={() => {
          if (blocker.state === "blocked") blocker.proceed();
        }}
      />
    </div>
  );
}

function SortableStep({
  step,
  index,
  serverBodyTooLong,
  onChange,
  onDelete,
}: {
  step: ResourceMessage;
  index: number;
  serverBodyTooLong: boolean;
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
  const body = step.body ?? "";
  const codeUnits = countInstagramCodeUnits(body);
  const overLimit = codeUnits > INSTAGRAM_GUIDE_TEXT_LIMIT;
  const warning = codeUnits >= INSTAGRAM_GUIDE_WARNING_AT && !overLimit;

  const patchMutation = useMutation({
    mutationKey: ["sequence-save", step.resourceId],
    mutationFn: (data: Pick<ResourceMessage, "mediaUrl">) =>
      api<ResourceMessage>(`/messages/${step.id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-messages", step.resourceId] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Update failed"),
  });

  const Icon =
    step.type === "text" ? TypeIcon : step.type === "image" ? ImageIcon : FileText;

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
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-gradient/15 text-foreground">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Step {index + 1} · {step.type}
                </span>
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
                <Label>
                  {step.type === "text" ? "Message" : "Caption (optional)"}
                </Label>
                <Textarea
                  value={body}
                  aria-invalid={overLimit}
                  onChange={(e) => onChange({ ...step, body: e.target.value })}
                  rows={step.type === "text" ? 3 : 2}
                  placeholder={
                    step.type === "text"
                      ? "What you want them to read."
                      : "Optional caption sent with the file."
                  }
                />
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span
                    className={cn(
                      "text-muted-foreground",
                      warning && "text-amber-600",
                      overLimit && "text-destructive",
                    )}
                  >
                    {codeUnits.toLocaleString()} / {INSTAGRAM_GUIDE_TEXT_LIMIT.toLocaleString()}
                  </span>
                  {overLimit || serverBodyTooLong ? (
                    <span className="text-destructive">{GUIDE_MESSAGE_LIMIT_GUIDANCE}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </li>
  );
}
