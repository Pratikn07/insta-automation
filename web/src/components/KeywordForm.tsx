import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, Images } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Keyword, MediaKind, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type SequenceMode = "new" | "existing";

/** When set, the keyword is being attached to one specific post (from the Content page). */
export interface MediaContext {
  mediaId: string;
  kind: MediaKind;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
}

// Wording + icon per post kind, so the form never calls a carousel a reel.
const KIND = {
  reel: { icon: Film, noun: "reel" },
  carousel: { icon: Images, noun: "carousel" },
} as const;

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
          // Attach to one post when invoked from the Content page; otherwise global.
          ...(mediaContext && {
            mediaId: mediaContext.mediaId,
            mediaCaption: mediaContext.caption,
            mediaPermalink: mediaContext.permalink,
          }),
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
        toast.error(
          mediaContext
            ? `That keyword is already attached to this ${KIND[mediaContext.kind].noun}`
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
        {mediaContext && <MediaContextCard media={mediaContext} />}

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

function MediaContextCard({ media }: { media: MediaContext }) {
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
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <KindIcon className="size-3" />
          Attaching to this {noun}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm">
          {media.caption?.trim() || "No caption"}
        </p>
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
