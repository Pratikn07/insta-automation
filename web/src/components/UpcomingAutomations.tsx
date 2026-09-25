import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
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
import { DEFAULT_PUBLIC_REPLY } from "@/lib/automationCopy";
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

/** Same two-way choice KeywordForm offers, so it is one control rather than two. */
type GuideMode = "new" | "existing";

type EditorState = {
  id: string | null;
  keyword: string;
  guideMode: GuideMode;
  /** Used when guideMode is "existing". */
  resourceId: string;
  /** Used when guideMode is "new". */
  newGuideName: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
};

const EMPTY_EDITOR: EditorState = {
  id: null,
  keyword: "",
  // New by default. A first-time setup has no guide to pick, and the reel flow
  // makes the same assumption.
  guideMode: "new",
  resourceId: "",
  newGuideName: "",
  publicReply: DEFAULT_PUBLIC_REPLY,
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

/**
 * Why nothing attached, in words that say what to change.
 *
 * Each reads as a fragment after the guide name, and each states the consequence
 * rather than only the cause: "uses a different keyword" leaves her to go and find
 * out which one, when the word she reserved is right here.
 *
 * The two caption cases name that word directly. They can, without re-parsing the
 * caption in the browser, because both codes mean the same thing by definition —
 * the published caption does not carry `Comment <triggerWord>`.
 */
function errorStory(errorCode: string, triggerWord: string): string {
  switch (errorCode) {
    case "caption_instruction_mismatch":
      return `its caption doesn't say "Comment ${triggerWord}", so nothing is attached`;
    case "caption_instruction_missing":
      return `its caption has no "Comment ${triggerWord}" line, so nothing is attached`;
    case "caption_instruction_ambiguous":
      return "its caption asks for more than one keyword, so nothing is attached";
    case "media_keyword_conflict":
      return "that post already has a different keyword, so this one wasn't added";
    case "multiple_media_matches":
      return "more than one new post matched, so nothing was attached";
    case "guide_has_no_steps":
      return "the guide has no steps yet, so nothing was attached — add them and retry";
    default:
      return `needs review: ${errorCode}`;
  }
}

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
        ? `${guide} · ${errorStory(row.errorCode, row.triggerWord)}`
        : `${guide} · needs review`;
  }
}

function editorFor(row: UpcomingAutomation): EditorState {
  return {
    id: row.id,
    keyword: row.triggerWord,
    // Editing an existing setup never creates a guide: it already has one.
    guideMode: "existing",
    resourceId: row.resourceId,
    newGuideName: "",
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
  const navigate = useNavigate();
  // One identity per create attempt. Renewed only after a create succeeds, so a
  // repeat of the same attempt reaches the same row rather than making a new one.
  // The guide gets its own, because a retry must not create a second guide either.
  const { operationId: newSetupId, renew: renewNewSetupId } = useOperationId();
  const { operationId: newGuideId, renew: renewNewGuideId } = useOperationId();

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
    mutationFn: async (
      state: EditorState,
    ): Promise<{ row: UpcomingAutomation; createdGuideId: string | null }> => {
      if (state.id) {
        const row = await apiMutation<UpcomingAutomation>(
          `/upcoming-automations/${state.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              keyword: state.keyword.trim().toUpperCase(),
              resourceId: state.resourceId,
              publicReply: state.publicReply,
              gateMessage: state.gateMessage,
              active: state.active,
            }),
          },
        );
        return { row, createdGuideId: null };
      }

      // A brand-new guide is created first, empty, then the setup points at it.
      // Two calls rather than one because the setup needs an id to reference, and
      // the guide's steps are written afterwards in the editor — the same order
      // KeywordForm uses.
      let resourceId = state.resourceId;
      let createdGuideId: string | null = null;
      if (state.guideMode === "new") {
        const guide = await apiMutation<Resource>("/resources", {
          method: "POST",
          operationId: newGuideId,
          body: JSON.stringify({
            id: newGuideId,
            name: state.newGuideName.trim(),
            description: null,
          }),
        });
        resourceId = guide.id;
        createdGuideId = guide.id;
      }

      // The id travels in the body and, via operationId, in Idempotency-Key. The
      // route compares them and refuses if they disagree.
      const row = await apiMutation<UpcomingAutomation>("/upcoming-automations", {
        method: "POST",
        operationId: newSetupId,
        body: JSON.stringify({
          id: newSetupId,
          keyword: state.keyword.trim().toUpperCase(),
          resourceId,
          publicReply: state.publicReply,
          gateMessage: state.gateMessage,
          active: state.active,
        }),
      });
      return { row, createdGuideId };
    },
    onSuccess: async ({ createdGuideId }, state) => {
      if (!state.id) {
        renewNewSetupId();
        renewNewGuideId();
      }
      setEditor(null);
      await queryClient.invalidateQueries({ queryKey: ["upcoming-automations"] });
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
      // Straight into the editor to write the steps, because an empty guide is
      // the one thing that stops this setup from ever attaching.
      if (createdGuideId) navigate(`/guides/${createdGuideId}`);
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

  /**
   * With nothing pending this is one line, not a section.
   *
   * It sits above the grid so a needs-attention row is visible without scrolling.
   * That only works if the empty state costs nothing — a heading plus a paragraph
   * of explanation would push 197 posts down every single visit to say "there is
   * nothing here". The explanation belongs with the rows it explains.
   */
  const quiet =
    !query.isLoading && !query.isError && automations.length === 0 && !editor;

  if (quiet) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Scheduled a post that isn&apos;t here yet?{" "}
        <button
          type="button"
          onClick={() => setEditor({ ...EMPTY_EDITOR })}
          className="text-signal underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
        >
          Set up its keyword in advance
        </button>
      </p>
    );
  }

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

      {/*
        One slot, four branches, one rule — and it is `line`, not ink. The rule
        opens the LIST, not the section: "Set up in advance" above already opens
        that, and the rows below carry `border-b-line`, so this is the head of
        that ruled list and has to weigh the same as its own rows. Ink here would
        make the list's first hairline heavier than the heading that names it.

        Every branch names its colour. The base layer sets `border-color` on `*`,
        so a bare `border-t` ships at --color-border (#EBE8DF) — 1.12:1 on the
        page ground, which separates nothing. That was the bug here; see
        home/KpiTile.tsx for the same defect and the same fix. Do not drop the
        `-line` suffix, and do not let one branch keep a bare `border-t` while
        its siblings are named: a list that rules itself only while loading is
        worse than one that never does.
      */}
      {query.isLoading ? (
        <div className="space-y-2 border-t border-t-line pt-3">
          <Skeleton className="h-8 rounded-md" />
          <Skeleton className="h-8 rounded-md" />
        </div>
      ) : query.isError ? (
        <p className="border-t border-t-line py-4 text-[13px] text-muted-foreground">
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
        // Reached only with the editor open on a first setup — the quiet one-line
        // form above handles every other empty case.
        <p className="border-t border-t-line py-3.5 text-[13px] text-muted-foreground">
          Nothing set up yet. Fill in the form above and it will wait here for its post.
        </p>
      ) : (
        <ul className="border-t border-t-line">
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
    // Narrow: a fixed three-line stack — word and chip, then the reason, then the
    // actions. Letting one flex row wrap put the chip in a different place on every
    // row, because each row's sentence is a different length.
    // Wide: one row, which is what a list of four short columns wants to be.
    <li
      className={cn(
        // Named, and named `line`: these rows are the body of the ruled list the
        // `border-t-line` above opens, so the head and the rows must be one
        // weight. Bare, they shipped at #EBE8DF / 1.12:1 and the list read as
        // unseparated paragraphs.
        "grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b border-b-line py-3",
        "sm:flex sm:gap-x-4 sm:gap-y-0",
      )}
    >
      <span className="font-mono text-sm font-medium tracking-[0.01em] sm:w-[8.5rem] sm:shrink-0">
        {row.triggerWord}
      </span>

      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 justify-self-end rounded-full px-2 py-0.5 text-[11.5px] font-medium",
          "sm:order-3 sm:justify-self-auto",
          tone,
        )}
      >
        <Icon className="size-3" aria-hidden />
        {label}
      </span>

      <span className="col-span-2 text-[13px] text-muted-foreground sm:order-2 sm:col-span-1 sm:min-w-[16rem] sm:flex-1">
        {rowStory(row)}
      </span>

      <span className="col-span-2 flex shrink-0 items-center gap-1 sm:order-4 sm:col-span-1">
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
  const tokenValid = /^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)?$/.test(value.keyword.trim());
  /**
   * A named new guide is enough; it does not need steps yet.
   *
   * The steps are written in the editor immediately afterwards, and the binder
   * refuses to attach an empty guide when the post publishes — so the check that
   * used to live here has moved to where it can actually be enforced.
   */
  const guideChosen =
    value.guideMode === "new"
      ? value.newGuideName.trim().length > 0
      : value.resourceId.length > 0;
  const canSubmit =
    tokenValid &&
    guideChosen &&
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
          <span className="font-mono">
            Comment {value.keyword.trim().replace(/\s+/g, " ").toUpperCase() || "KEYWORD"}
          </span>{" "}
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
            <p className="text-xs text-urgent">
              Use one or two words with letters and numbers only.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="upcoming-guide">Guide</Label>
          {value.id ? (
            // Editing: the guide already exists, so there is nothing to create.
            <Select
              id="upcoming-guide"
              value={value.resourceId}
              onChange={(event) => onChange({ ...value, resourceId: event.target.value })}
            >
              <option value="">Select a guide</option>
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                  {(resource._count?.messages ?? 0) === 0 ? " (no steps yet)" : ""}
                </option>
              ))}
            </Select>
          ) : (
            <>
              {/* The same pair KeywordForm shows, so this is one control the owner
                  already knows rather than a second way of choosing a guide. */}
              <div className="grid grid-cols-2 gap-2">
                <GuideModeButton
                  active={value.guideMode === "new"}
                  onClick={() => onChange({ ...value, guideMode: "new" })}
                  title="Create new"
                  subtitle="Build a fresh guide"
                />
                <GuideModeButton
                  active={value.guideMode === "existing"}
                  onClick={() => onChange({ ...value, guideMode: "existing" })}
                  title="Use existing"
                  subtitle={resources.length > 0 ? `${resources.length} available` : "None yet"}
                  disabled={resources.length === 0}
                />
              </div>
              {value.guideMode === "new" ? (
                <Input
                  id="upcoming-guide"
                  value={value.newGuideName}
                  maxLength={120}
                  placeholder="Sleep Reset Guide"
                  onChange={(event) => onChange({ ...value, newGuideName: event.target.value })}
                />
              ) : (
                <Select
                  id="upcoming-guide"
                  value={value.resourceId}
                  onChange={(event) => onChange({ ...value, resourceId: event.target.value })}
                >
                  <option value="">Select a guide</option>
                  {resources.map((resource) => (
                    <option key={resource.id} value={resource.id}>
                      {resource.name}
                      {(resource._count?.messages ?? 0) === 0 ? " (no steps yet)" : ""}
                    </option>
                  ))}
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                {value.guideMode === "new"
                  ? "We'll create the guide and drop you into the editor to add steps."
                  : "A guide with no steps yet is fine — it just has to have them before the post publishes."}
              </p>
            </>
          )}
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
          placeholder={DEFAULT_PUBLIC_REPLY}
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

/**
 * One half of the create-new / use-existing pair.
 *
 * Deliberately the same shape as ModeButton in KeywordForm rather than an import:
 * that one is a local helper in a large file, and lifting it into a shared module
 * is a refactor of a working page that this change does not need. If a third
 * caller appears, that is the moment to extract it.
 */
function GuideModeButton({
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
      aria-pressed={active}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition-colors",
        active ? "border-signal bg-signal-soft" : "border-line hover:border-foreground/30",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <div className="text-[13px] font-medium">{title}</div>
      <div className={cn("mt-0.5 text-[11.5px]", active ? "text-signal" : "text-muted-foreground")}>
        {subtitle}
      </div>
    </button>
  );
}
