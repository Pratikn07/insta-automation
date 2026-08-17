import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  Resource,
  UpcomingAutomation,
  UpcomingAutomationsResponse,
  UpcomingAutomationStatus,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type EditorState = {
  id: string | null;
  keyword: string;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
};

const EMPTY_EDITOR: EditorState = {
  id: null,
  keyword: "",
  resourceId: "",
  publicReply: "",
  gateMessage: "",
  active: true,
};

const STATUS: Record<UpcomingAutomationStatus, { label: string; tone: string }> = {
  waiting: { label: "Waiting for post", tone: "border-sky-400/30 text-sky-300" },
  needs_attention: { label: "Needs attention", tone: "border-amber-400/30 text-amber-300" },
  cancelled: { label: "Cancelled", tone: "border-muted text-muted-foreground" },
  bound: { label: "Bound", tone: "border-emerald-400/30 text-emerald-300" },
};

const ERROR_LABELS: Record<string, string> = {
  caption_instruction_missing: "The published caption has no Comment KEYWORD instruction.",
  caption_instruction_mismatch: "The published caption uses a different keyword.",
  caption_instruction_ambiguous: "The published caption contains more than one Comment KEYWORD instruction.",
  media_keyword_conflict: "This post already has a different keyword configuration.",
  multiple_media_matches: "More than one new post matched this setup, so nothing was attached.",
};

function editorFor(row: UpcomingAutomation): EditorState {
  return {
    id: row.id,
    keyword: row.triggerWord,
    resourceId: row.resourceId,
    publicReply: row.publicReply,
    gateMessage: row.gateMessage,
    active: row.active,
  };
}

function mutationMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The setup could not be saved.";
}

export function UpcomingAutomations({ resources }: { resources: Resource[] }) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [cancelling, setCancelling] = useState<UpcomingAutomation | null>(null);

  const query = useQuery<UpcomingAutomationsResponse>({
    queryKey: ["upcoming-automations"],
    queryFn: () => api<UpcomingAutomationsResponse>("/upcoming-automations"),
    refetchInterval: (state) => state.state.data?.discoveryEnabled ? 60_000 : false,
  });

  // A disappearing Upcoming row means binding may have completed. Refresh both
  // published sources so the real Instagram card and its ordinary keyword can
  // replace the local setup without a page reload.
  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    void queryClient.invalidateQueries({ queryKey: ["content"] });
    void queryClient.invalidateQueries({ queryKey: ["keywords"] });
  }, [query.dataUpdatedAt, queryClient]);

  const save = useMutation({
    mutationFn: async (state: EditorState) => {
      const body = {
        keyword: state.keyword.trim().toUpperCase(),
        resourceId: state.resourceId,
        publicReply: state.publicReply,
        gateMessage: state.gateMessage,
        active: state.active,
      };
      return state.id
        ? api<UpcomingAutomation>(`/upcoming-automations/${state.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api<UpcomingAutomation>("/upcoming-automations", {
            method: "POST",
            body: JSON.stringify(body),
          });
    },
    onSuccess: async () => {
      setEditor(null);
      await queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] });
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<UpcomingAutomation>(`/upcoming-automations/${id}/cancel`, { method: "POST" }),
    onSuccess: async () => {
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] });
    },
  });

  const retry = useMutation({
    mutationFn: (id: string) =>
      api<UpcomingAutomation>(`/upcoming-automations/${id}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] }),
  });

  const error = save.error ?? cancel.error ?? retry.error;
  const automations = query.data?.automations ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card/40 p-4">
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Prepare the automation before Instagram publishes</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Instagram does not provide scheduled previews through Meta&apos;s API. These cards contain
              only the keyword and guide setup; Instagram still owns the schedule, caption, media, and music.
            </p>
          </div>
        </div>
      </div>

      {query.data && !query.data.discoveryEnabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Automatic discovery is paused</p>
            <p className="mt-0.5 text-xs text-amber-200/75">
              Setup management remains available, but posts will not bind until the backend flag is enabled.
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="brand" onClick={() => setEditor({ ...EMPTY_EDITOR })}>
          <Plus className="size-4" />
          Add upcoming setup
        </Button>
      </div>

      {editor && (
        <UpcomingEditor
          value={editor}
          resources={resources}
          busy={save.isPending}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSubmit={() => save.mutate(editor)}
        />
      )}

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {mutationMessage(error)}
        </p>
      )}

      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
        </div>
      ) : query.isError ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Couldn&apos;t load upcoming setups. <Button variant="link" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : automations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/30 px-4 py-10 text-center">
          <p className="text-sm font-medium">No upcoming setups</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add one before scheduling a Reel or feed post in Instagram.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {automations.map((row) => (
            <UpcomingCard
              key={row.id}
              row={row}
              onEdit={() => setEditor(editorFor(row))}
              onCancel={() => setCancelling(row)}
              onRetry={() => retry.mutate(row.id)}
              retrying={retry.isPending && retry.variables === row.id}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel upcoming setup?"
        description={cancelling ? `${cancelling.triggerWord} will no longer be eligible for automatic binding.` : undefined}
        confirmLabel="Cancel setup"
        destructive
        busy={cancel.isPending}
        onCancel={() => setCancelling(null)}
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)}
      />
    </div>
  );
}

function UpcomingEditor({
  value,
  resources,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: EditorState;
  resources: Resource[];
  busy: boolean;
  onChange: (value: EditorState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const tokenValid = /^[A-Za-z0-9]+$/.test(value.keyword.trim());
  const guide = resources.find((resource) => resource.id === value.resourceId);
  const guideHasMessages = (guide?._count?.messages ?? 0) > 0;
  const canSubmit =
    tokenValid &&
    guideHasMessages &&
    value.publicReply.length >= 1 &&
    value.publicReply.length <= 280 &&
    value.gateMessage.length >= 1 &&
    value.gateMessage.length <= 1000 &&
    !busy;

  return (
    <form
      className="space-y-4 rounded-lg border bg-card/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div>
        <h3 className="text-sm font-medium">{value.id ? `Edit ${value.keyword}` : "New upcoming setup"}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Put exactly <span className="font-mono">Comment KEYWORD</span> in the final Instagram caption.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="upcoming-keyword">Keyword</Label>
          <Input
            id="upcoming-keyword"
            value={value.keyword}
            maxLength={60}
            autoComplete="off"
            onChange={(event) => onChange({ ...value, keyword: event.target.value })}
          />
          {value.keyword.length > 0 && !tokenValid && (
            <p className="text-xs text-destructive">Use one word with letters and numbers only.</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="upcoming-guide">Guide</Label>
          <Select
            id="upcoming-guide"
            value={value.resourceId}
            onChange={(event) => onChange({ ...value, resourceId: event.target.value })}
          >
            <option value="">Select a guide</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id} disabled={(resource._count?.messages ?? 0) === 0}>
                {resource.name}{(resource._count?.messages ?? 0) === 0 ? " (empty)" : ""}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="upcoming-public-reply">Public reply</Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">{value.publicReply.length}/280</span>
        </div>
        <Textarea
          id="upcoming-public-reply"
          value={value.publicReply}
          maxLength={280}
          onChange={(event) => onChange({ ...value, publicReply: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="upcoming-gate-message">Gate message</Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">{value.gateMessage.length}/1000</span>
        </div>
        <Textarea
          id="upcoming-gate-message"
          value={value.gateMessage}
          maxLength={1000}
          onChange={(event) => onChange({ ...value, gateMessage: event.target.value })}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <div>
          <p className="text-sm">Active after binding</p>
          <p className="text-xs text-muted-foreground">Turn off to attach the keyword in a paused state.</p>
        </div>
        <Switch
          checked={value.active}
          onCheckedChange={(active) => onChange({ ...value, active })}
          aria-label="Active after binding"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Close</Button>
        <Button type="submit" variant="brand" disabled={!canSubmit}>
          {busy ? "Saving…" : value.id ? "Save changes" : "Create setup"}
        </Button>
      </div>
    </form>
  );
}

function UpcomingCard({
  row,
  onEdit,
  onCancel,
  onRetry,
  retrying,
}: {
  row: UpcomingAutomation;
  onEdit: () => void;
  onCancel: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const status = STATUS[row.status];
  const editable = row.status === "waiting" || row.status === "needs_attention";

  return (
    <article className="space-y-4 rounded-lg border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-base font-semibold">{row.triggerWord}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{row.resource.name}</p>
        </div>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", status.tone)}>
          {status.label}
        </span>
      </div>

      {row.errorCode && (
        <div className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
          {ERROR_LABELS[row.errorCode] ?? `Needs review: ${row.errorCode}`}
        </div>
      )}

      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Public reply</dt>
          <dd className="mt-0.5 whitespace-pre-wrap">{row.publicReply}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Gate message</dt>
          <dd className="mt-0.5 whitespace-pre-wrap">{row.gateMessage}</dd>
        </div>
        <div className="flex items-center justify-between border-t pt-2 text-muted-foreground">
          <dt>Created</dt>
          <dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.createdAt))}</dd>
        </div>
      </dl>

      {editable && (
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
          {row.status === "needs_attention" && (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} aria-label={`Retry ${row.triggerWord}`}>
              <RotateCcw className="size-3.5" />
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${row.triggerWord}`}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label={`Cancel ${row.triggerWord}`}>
            <Trash2 className="size-3.5" /> Cancel
          </Button>
        </div>
      )}
    </article>
  );
}
