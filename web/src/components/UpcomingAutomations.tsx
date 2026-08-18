import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { apiMutation, apiRead } from "@/lib/api";
import { useOperationId } from "@/lib/useOperationId";
import { outcomeMessage } from "@/lib/unknownOutcome";
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

/**
 * The four states, on paper.
 *
 * The values these replaced (`text-sky-300`, `text-emerald-300`, `text-amber-300`
 * and friends) were chosen for a dark shell this console no longer has. On the
 * `#fffef9` card they measure between 1.2:1 and 1.7:1 — not dim, unreadable.
 *
 * Each pair is an existing semantic token whose contrast is already recorded in
 * index.css, and each carries an icon, so state never depends on colour alone.
 * `Attached` rather than `Bound`: the database calls it bound, she is attaching a
 * keyword to a post.
 */
const STATUS: Record<
  UpcomingAutomationStatus,
  { label: string; tone: string; Icon: typeof CalendarClock }
> = {
  waiting: {
    label: "Waiting",
    tone: "bg-caution-soft text-caution",
    Icon: CalendarClock,
  },
  needs_attention: {
    label: "Needs attention",
    tone: "bg-urgent-soft text-urgent",
    Icon: AlertTriangle,
  },
  bound: {
    label: "Attached",
    tone: "bg-signal-soft text-signal",
    Icon: Check,
  },
  cancelled: {
    label: "Cancelled",
    tone: "bg-muted text-muted-foreground",
    Icon: Trash2,
  },
};

const ERROR_LABELS: Record<string, string> = {
  caption_instruction_missing: "The published caption has no Comment KEYWORD instruction.",
  caption_instruction_mismatch: "The published caption uses a different keyword.",
  caption_instruction_ambiguous:
    "The published caption contains more than one Comment KEYWORD instruction.",
  media_keyword_conflict: "This post already has a different keyword configuration.",
  multiple_media_matches: "More than one new post matched this setup, so nothing was attached.",
};

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "2 hours ago" for a receipt row. Hours are the useful unit inside a 24h window. */
function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.round((then - Date.now()) / 60_000);
  if (minutes > -60) return relative.format(Math.min(minutes, -1), "minute");
  return relative.format(Math.round(minutes / 60), "hour");
}

/**
 * The one sentence under the word: what this setup is waiting for, or why nothing
 * happened. Its job is to be readable without opening anything.
 */
function rowStory(row: UpcomingAutomation): string {
  const guide = row.resource.name;
  switch (row.status) {
    case "waiting":
      return `${guide} · waiting for the post to publish`;
    case "bound":
      return `${guide} · attached itself ${timeAgo(row.boundAt) ?? "just now"}`;
    case "cancelled":
      return `${guide} · cancelled ${timeAgo(row.cancelledAt) ?? "just now"}`;
    case "needs_attention":
      return row.errorCode
        ? `${guide} · ${ERROR_LABELS[row.errorCode] ?? `needs review: ${row.errorCode}`}`
        : `${guide} · needs review`;
  }
}

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

function definiteMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The setup could not be saved.";
}

export function UpcomingAutomations({ resources }: { resources: Resource[] }) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [cancelling, setCancelling] = useState<UpcomingAutomation | null>(null);
  // One identity per create attempt. Renewed only after a create succeeds, so a
  // repeat of the same attempt reaches the same row rather than making a new one.
  const { operationId: newSetupId, renew: renewNewSetupId } = useOperationId();

  const query = useQuery<UpcomingAutomationsResponse>({
    queryKey: ["upcoming-automations"],
    queryFn: ({ signal }) =>
      apiRead<UpcomingAutomationsResponse>("/upcoming-automations", { signal }),
    refetchInterval: (state) => (state.state.data?.discoveryEnabled ? 60_000 : false),
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
      const fields = {
        keyword: state.keyword.trim().toUpperCase(),
        resourceId: state.resourceId,
        publicReply: state.publicReply,
        gateMessage: state.gateMessage,
        active: state.active,
      };
      if (state.id) {
        return apiMutation<UpcomingAutomation>(`/upcoming-automations/${state.id}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        });
      }
      // The id travels in the body and, via operationId, in Idempotency-Key. The
      // route compares them and refuses if they disagree.
      return apiMutation<UpcomingAutomation>("/upcoming-automations", {
        method: "POST",
        operationId: newSetupId,
        body: JSON.stringify({ id: newSetupId, ...fields }),
      });
    },
    onSuccess: async (_row, state) => {
      if (!state.id) renewNewSetupId();
      setEditor(null);
      await queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] });
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      apiMutation<UpcomingAutomation>(`/upcoming-automations/${id}/cancel`, { method: "POST" }),
    onSuccess: async () => {
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] });
    },
    // An unknown outcome is not a failure. The list refetches either way, and that
    // read — not this response — is what settles whether the cancel landed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] }),
  });

  const retry = useMutation({
    mutationFn: (id: string) =>
      apiMutation<UpcomingAutomation>(`/upcoming-automations/${id}/retry`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] }),
  });

  const error = save.error ?? cancel.error ?? retry.error;
  const automations = query.data?.automations ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-medium">Set up in advance</h2>
        <Button size="sm" variant="outline" onClick={() => setEditor({ ...EMPTY_EDITOR })}>
          <Plus className="size-4" />
          {automations.length > 0 ? "Set up another" : "Set up a keyword in advance"}
        </Button>
      </div>

      <p className="max-w-[68ch] text-[13px] text-muted-foreground">
        Instagram doesn&apos;t let us see your scheduled queue. Each of these waits for a post
        whose caption contains its word — the word is how we recognise the post — and then
        attaches itself.
      </p>

      {query.data && !query.data.discoveryEnabled && (
        <div className="flex items-start gap-2 rounded-md bg-caution-soft px-3 py-2.5 text-[13px] text-caution">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Automatic attaching is paused</p>
            <p className="mt-0.5 text-xs">
              You can still edit these, but no post will attach itself while it is off — and a
              word reserved here will not fall back to an older post&apos;s keyword either.
            </p>
          </div>
        </div>
      )}

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
        <p
          role="alert"
          className="rounded-md bg-urgent-soft px-3 py-2 text-[13px] text-urgent"
        >
          {outcomeMessage(error, definiteMessage(error))}
        </p>
      )}

      {query.isLoading ? (
        <div className="space-y-2 border-t pt-3">
          <Skeleton className="h-8 rounded-md" />
          <Skeleton className="h-8 rounded-md" />
        </div>
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load these — the API did not answer. This is a connection problem, not
          an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : automations.length === 0 ? (
        // Not an empty state — the door. Content has no header action, so hiding
        // this line entirely would leave her no way to make her first one.
        <p className="border-t py-3.5 text-[13px] text-muted-foreground">
          Scheduled a post that isn&apos;t here yet?{" "}
          <button
            type="button"
            onClick={() => setEditor({ ...EMPTY_EDITOR })}
            className="text-signal underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Set up its keyword in advance
          </button>
        </p>
      ) : (
        <ul className="border-t">
          {automations.map((row) => (
            <UpcomingRow
              key={row.id}
              row={row}
              onEdit={() => setEditor(editorFor(row))}
              onCancel={() => setCancelling(row)}
              onRetry={() => retry.mutate(row.id)}
              retrying={retry.isPending && retry.variables === row.id}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel this setup?"
        description={
          cancelling
            ? `${cancelling.triggerWord} will stop waiting for a post. Nothing already attached is affected.`
            : undefined
        }
        confirmLabel="Cancel setup"
        destructive
        busy={cancel.isPending}
        onCancel={() => setCancelling(null)}
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)}
      />
    </section>
  );
}

/**
 * One setup as a row, not a card.
 *
 * Content is already a grid of image cards. A second card system directly beneath
 * gives the page two competing grids, so this is a list: rules and dividers, which
 * is what DESIGN.md asks for when the thing is a list of things.
 */
function UpcomingRow({
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
  const { label, tone, Icon } = STATUS[row.status];
  const editable = row.status === "waiting" || row.status === "needs_attention";

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 sm:flex-nowrap">
      <span className="w-[8.5rem] shrink-0 font-mono text-sm font-medium tracking-[0.01em]">
        {row.triggerWord}
      </span>

      <span className="min-w-[16rem] flex-1 text-[13px] text-muted-foreground">
        {rowStory(row)}
      </span>

      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
          tone,
        )}
      >
        <Icon className="size-3" aria-hidden />
        {label}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        {row.status === "needs_attention" && (
          <Button
            size="sm"
            variant="brand"
            onClick={onRetry}
            disabled={retrying}
            aria-label={`Retry ${row.triggerWord}`}
          >
            <RotateCcw className="size-3.5" />
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        )}
        {editable && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onEdit}
              aria-label={`Edit ${row.triggerWord}`}
            >
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              aria-label={`Cancel ${row.triggerWord}`}
            >
              Cancel
            </Button>
          </>
        )}
      </span>
    </li>
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
      className="space-y-4 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div>
        <h3 className="text-sm font-medium">
          {value.id ? `Edit ${value.keyword}` : "New upcoming setup"}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The caption you publish must contain{" "}
          <span className="font-mono">Comment {value.keyword.trim().toUpperCase() || "KEYWORD"}</span>{" "}
          — that is how the post is recognised, so a different word attaches nothing.
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
            <p className="text-xs text-urgent">Use one word with letters and numbers only.</p>
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
              <option
                key={resource.id}
                value={resource.id}
                disabled={(resource._count?.messages ?? 0) === 0}
              >
                {resource.name}
                {(resource._count?.messages ?? 0) === 0 ? " (empty)" : ""}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="upcoming-public-reply">Public reply</Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {value.publicReply.length}/280
          </span>
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
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {value.gateMessage.length}/1000
          </span>
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
          <p className="text-sm">Active once attached</p>
          <p className="text-xs text-muted-foreground">
            Turn off to attach the keyword in a paused state.
          </p>
        </div>
        <Switch
          checked={value.active}
          onCheckedChange={(active) => onChange({ ...value, active })}
          aria-label="Active once attached"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Close
        </Button>
        <Button type="submit" variant="brand" disabled={!canSubmit}>
          {busy ? "Saving…" : value.id ? "Save changes" : "Create setup"}
        </Button>
      </div>
    </form>
  );
}
