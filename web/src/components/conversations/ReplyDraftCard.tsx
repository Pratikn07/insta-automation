import { useEffect, useState } from "react";
import { AlertCircle, Check, Loader2, RotateCw, Send, Sparkles, Trash2 } from "lucide-react";
import type { DmThreadDetail, ReplyDraft } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  MAX_REPLY_LENGTH,
  approvalGate,
  draftStatusLabel,
  isStale,
} from "./replyDraftView";

/**
 * The owner's approval surface for one AI suggestion.
 *
 * Approve & Send submits EXACTLY the text visible in the editor — there is no
 * second confirmation dialog, because the text itself is the confirmation. The
 * model's original suggestion is never mutated; edits only touch the working copy.
 */
export interface ReplyDraftCardProps {
  thread: DmThreadDetail;
  draft: ReplyDraft;
  sendEnabled: boolean;
  mutationPending: boolean;
  onEdit: (workingText: string) => void;
  onRegenerate: () => void;
  onDismiss: () => void;
  onApprove: (workingText: string) => void;
  onRetry: (confirmedNotDelivered: true) => void;
}

const GATE_MESSAGE: Record<string, string> = {
  stale: "New message received — generate a new draft.",
  empty: "Write a reply before sending.",
  too_long: `Replies are limited to ${MAX_REPLY_LENGTH} characters.`,
  in_flight: "Sending…",
  send_disabled: "Sending is turned off for this environment.",
  uncertain_needs_check: "Check Instagram before retrying.",
  not_pending: "This draft can't be sent.",
};

export function ReplyDraftCard(props: ReplyDraftCardProps) {
  const { thread, draft, sendEnabled, mutationPending } = props;
  const [text, setText] = useState(draft.workingText ?? draft.suggestedText ?? "");
  const [confirmedNotDelivered, setConfirmedNotDelivered] = useState(false);

  // A new revision replaces the editor contents; an in-progress edit of the SAME
  // revision is preserved so a background refetch can't discard typing.
  useEffect(() => {
    setText(draft.workingText ?? draft.suggestedText ?? "");
  }, [draft.id]);

  const gate = approvalGate({ thread, draft, text, sendEnabled, mutationPending });
  const stale = isStale(thread, draft);
  const drafting = draft.status === "queued" || draft.status === "generating";
  const uncertain = draft.status === "send_uncertain";

  return (
    <Card className="border-brand/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5" />
            {draftStatusLabel(draft.status)}
            {draft.revision > 1 && <span className="opacity-60">· v{draft.revision}</span>}
          </span>
          {draft.confidence && !drafting && (
            <span className="text-xs text-muted-foreground">
              confidence: {draft.confidence}
            </span>
          )}
        </div>

        {stale && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>New message received — generate a new draft.</span>
          </div>
        )}

        {uncertain && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              We couldn’t confirm whether this was delivered. <strong>Check Instagram first</strong> —
              it may already have been sent.
            </span>
          </div>
        )}

        {draft.status === "generation_failed" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{draft.errorMessage ?? "The draft couldn’t be generated."}</span>
          </div>
        )}

        {drafting ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Writing a suggestion…
          </p>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => text !== (draft.workingText ?? "") && props.onEdit(text)}
              rows={4}
              disabled={draft.status === "sending"}
              className="w-full resize-y rounded-md border bg-transparent p-3 text-sm outline-none focus:border-foreground/40 disabled:opacity-60"
              aria-label="Reply draft"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{draft.rationale}</span>
              <span className={text.trim().length > MAX_REPLY_LENGTH ? "text-destructive" : ""}>
                {text.trim().length}/{MAX_REPLY_LENGTH}
              </span>
            </div>
          </>
        )}

        {Array.isArray(draft.warnings) && draft.warnings.length > 0 && (
          <ul className="space-y-1 text-xs text-amber-300">
            {(draft.warnings as string[]).map((w) => (
              <li key={w} className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}

        {uncertain ? (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmedNotDelivered}
                onChange={(e) => setConfirmedNotDelivered(e.target.checked)}
                className="mt-0.5"
              />
              <span>I checked Instagram — this reply was not delivered.</span>
            </label>
            <Button
              variant="brand"
              disabled={!confirmedNotDelivered || mutationPending || !sendEnabled}
              onClick={() => props.onRetry(true)}
            >
              {mutationPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Retry send
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="brand"
              disabled={!gate.canApprove}
              title={gate.reason ? GATE_MESSAGE[gate.reason] : undefined}
              onClick={() => props.onApprove(text)}
            >
              {mutationPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Send className="mr-2 size-4" />
              )}
              Approve &amp; Send
            </Button>
            <Button variant="outline" disabled={mutationPending} onClick={props.onRegenerate}>
              <RotateCw className="mr-2 size-4" />
              Try another
            </Button>
            <Button variant="ghost" disabled={mutationPending} onClick={props.onDismiss}>
              <Trash2 className="mr-2 size-4" />
              Dismiss
            </Button>
            {draft.status === "sent" && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
                <Check className="size-3.5" />
                Replied
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
