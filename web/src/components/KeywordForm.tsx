import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Images } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiRead, apiMutation, ApiError } from "@/lib/api";
import { DEFAULT_PUBLIC_REPLY } from "@/lib/automationCopy";
import { useOperationId } from "@/lib/useOperationId";
import type { Keyword, MediaKind, MediaPage, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type SequenceMode = "new" | "existing";

/**
 * The post this keyword belongs to. Always required to CREATE a keyword — a
 * keyword scopes to exactly one post, so there is no global option anymore. When
 * the form is opened without one (the Keywords page's "New keyword"), a picker
 * collects it before the rest of the form appears.
 */
export interface MediaContext {
  mediaId: string;
  kind: MediaKind;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  /** The post's IG publish timestamp; persisted so cold DMs can rank by post date. */
  postedAt: string | null;
}

// Wording + icon per post kind, so the form never calls a carousel a reel.
const KIND = {
  reel: { icon: Film, noun: "reel" },
  carousel: { icon: Images, noun: "carousel" },
} as const;

const KEYWORD_PHRASE = /^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)?$/;

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
  publicReply: DEFAULT_PUBLIC_REPLY,
  gateMessage: "Reply DONE to receive your guide.",
  active: true,
};

export function KeywordForm({
  initial,
  resources,
  onClose,
  mediaContext,
}: {
  initial: Keyword | null;
  resources: Resource[];
  onClose: () => void;
  mediaContext?: MediaContext;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The post this keyword will belong to: handed in by the Content page, or
  // chosen here when the form was opened cold. Editing an existing keyword never
  // needs it — the post is already recorded on the row and stays put.
  const [picked, setPicked] = useState<MediaContext | null>(null);
  const media = mediaContext ?? picked;
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

  // Two creates can happen in one attempt, so each owns its own stable UUID. If
  // the keyword create fails after the sequence create succeeded, repeating the
  // attempt replays the same sequence rather than making a second one.
  const { operationId: newSequenceId, renew: renewNewSequenceId } = useOperationId();
  const { operationId: newKeywordId, renew: renewNewKeywordId } = useOperationId();

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{ keyword: Keyword; createdSequence: boolean }> => {
      if (initial) {
        const updated = await apiMutation<Keyword>(`/keywords/${initial.id}`, {
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
        const seq = await apiMutation<Resource>("/resources", {
          method: "POST",
          operationId: newSequenceId,
          body: JSON.stringify({
            id: newSequenceId,
            name: form.newSequenceName.trim(),
            description: null,
          }),
        });
        resourceId = seq.id;
        createdSequence = true;
      }

      const created = await apiMutation<Keyword>("/keywords", {
        method: "POST",
        operationId: newKeywordId,
        body: JSON.stringify({
          id: newKeywordId,
          keyword: form.keyword,
          resourceId,
          publicReply: form.publicReply,
          gateMessage: form.gateMessage,
          active: form.active,
          // Always present on create: the API requires mediaId, so a keyword
          // cannot be created without the post it belongs to.
          ...(media && {
            mediaId: media.mediaId,
            mediaCaption: media.caption,
            mediaPermalink: media.permalink,
            mediaPostedAt: media.postedAt,
          }),
        }),
      });
      return { keyword: created, createdSequence };
    },
    onSuccess: ({ keyword, createdSequence }) => {
      renewNewSequenceId();
      renewNewKeywordId();
      toast.success(initial ? "Keyword updated" : "Keyword created");
      qc.invalidateQueries({ queryKey: ["keywords"] });
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      onClose();
      if (createdSequence) {
        navigate(`/guides/${keyword.resourceId}`);
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          media
            ? `That keyword is already attached to this ${KIND[media.kind].noun}`
            : "That keyword already exists",
        );
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

  const keywordValid = KEYWORD_PHRASE.test(form.keyword.trim());

  const canSave =
    keywordValid &&
    sequenceValid &&
    form.publicReply.trim().length > 0 &&
    form.gateMessage.trim().length > 0 &&
    !saveMutation.isPending;

  // A new keyword must belong to a post before anything else is worth filling in,
  // so the picker replaces the form rather than sitting inside it. Editing skips
  // this entirely: the post is already on the row.
  if (!initial && !media) {
    return <PostPicker onPick={setPicked} onCancel={onClose} />;
  }

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) saveMutation.mutate();
      }}
    >
      <div className="space-y-5">
        {media && (
          <MediaContextCard
            media={media}
            // Only a freshly picked post can be swapped — a post handed in from
            // the Content page is the context you navigated from, and an existing
            // keyword's post is fixed.
            onChange={!initial && !mediaContext ? () => setPicked(null) : undefined}
          />
        )}

        <Field
          label="Keyword"
          hint="Use one or two letters-and-numbers words. People comment the exact phrase to trigger."
        >
          <Input
            value={form.keyword}
            onChange={(e) => setForm((f) => ({ ...f, keyword: e.target.value }))}
            placeholder="RECIPE"
            autoFocus
            required
          />
        </Field>

        <div className="space-y-2">
          <Label>Guide</Label>
          {initial ? (
            <Select
              value={form.resourceId}
              onChange={(e) => setForm((f) => ({ ...f, resourceId: e.target.value }))}
              required
            >
              <option value="" disabled>
                Pick a guide
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
                  subtitle="Build a fresh guide"
                />
                <ModeButton
                  active={form.sequenceMode === "existing"}
                  onClick={() => setForm((f) => ({ ...f, sequenceMode: "existing" }))}
                  title="Use existing"
                  subtitle={resources.length > 0 ? `${resources.length} available` : "None yet"}
                  disabled={resources.length === 0}
                />
              </div>
              {form.sequenceMode === "new" ? (
                <Input
                  value={form.newSequenceName}
                  onChange={(e) => setForm((f) => ({ ...f, newSequenceName: e.target.value }))}
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
                    Pick a guide
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
                  ? "We'll create the guide and drop you into the editor to add steps."
                  : "Reuse an existing guide — useful for spelling variations of the same trigger."}
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
            placeholder={DEFAULT_PUBLIC_REPLY}
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

function MediaContextCard({
  media,
  onChange,
}: {
  media: MediaContext;
  onChange?: () => void;
}) {
  const { icon: KindIcon, noun } = KIND[media.kind];
  return (
    <div className="flex gap-3 rounded-md border bg-card/40 p-3">
      <div className="size-14 shrink-0 overflow-hidden rounded bg-accent">
        {media.thumbnailUrl ? (
          <img src={media.thumbnailUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <KindIcon className="size-5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <KindIcon className="size-3" />
            Attaching to this {noun}
          </div>
          {onChange && (
            <button
              type="button"
              onClick={onChange}
              className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Change
            </button>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm">{media.caption?.trim() || "No caption"}</p>
      </div>
    </div>
  );
}

/**
 * Choose the post a new keyword belongs to.
 *
 * Reuses /media/content (the same endpoint and 5-min cache the Content page
 * uses), and shows each post's existing keyword count so it is obvious which
 * posts are already configured.
 */
function PostPicker({
  onPick,
  onCancel,
}: {
  onPick: (m: MediaContext) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const mediaQ = useQuery<MediaPage>({
    queryKey: ["content"],
    queryFn: ({ signal }) => apiRead<MediaPage>("/media/content", { signal }),
  });
  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: ({ signal }) => apiRead<Keyword[]>("/keywords", { signal }),
  });

  const countByMedia = useMemo(() => {
    const map = new Map<string, number>();
    for (const k of keywordsQ.data ?? []) {
      if (k.mediaId) map.set(k.mediaId, (map.get(k.mediaId) ?? 0) + 1);
    }
    return map;
  }, [keywordsQ.data]);

  const items = useMemo(() => {
    const all = mediaQ.data?.items ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((m) => (m.caption ?? "").toLowerCase().includes(q)) : all;
  }, [mediaQ.data, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3">
        <div>
          <Label>Which post?</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            A keyword belongs to one post, so its guide is only sent to people who comment on
            that post.
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search captions…"
          autoFocus
        />
      </div>

      <div className="mt-4 flex-1 overflow-y-auto">
        {mediaQ.isError ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Couldn't load your posts. The access token may have expired.
          </p>
        ) : mediaQ.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading posts…</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {query ? "No post matches that caption." : "No posts found."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((m) => {
              const { icon: KindIcon, noun } = KIND[m.kind];
              const count = countByMedia.get(m.id) ?? 0;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onPick({
                        mediaId: m.id,
                        kind: m.kind,
                        caption: m.caption,
                        permalink: m.permalink,
                        thumbnailUrl: m.thumbnailUrl,
                        postedAt: m.timestamp,
                      })
                    }
                    className="flex w-full items-center gap-3 rounded-md border bg-card/40 p-2 text-left transition-colors hover:border-foreground/30 hover:bg-accent/30"
                  >
                    <div className="size-11 shrink-0 overflow-hidden rounded bg-accent">
                      {m.thumbnailUrl ? (
                        <img src={m.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <div className="flex size-full items-center justify-center text-muted-foreground">
                          <KindIcon className="size-4" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm">{m.caption?.trim() || "No caption"}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <KindIcon className="size-3" />
                        {noun}
                        {count > 0 && ` · ${count} keyword${count === 1 ? "" : "s"}`}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex justify-end border-t pt-4">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
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
