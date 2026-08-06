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
  actionErrorMessage?: string | null;
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
  follow_up_not_ready: "This follow-up is not ready yet.",
  follow_up_window_closed: "The Instagram reply window has closed.",
  prompt_policy_outdated: "This draft uses an older prompt policy and can no longer be used.",
  not_pending: "This draft can't be sent.",
};

export function ReplyDraftCard(props: ReplyDraftCardProps) {
  const { thread, draft, sendEnabled, mutationPending } = props;
  // null means pristine: keep following server hydration for this same draft ID.
  // Once the owner types, their local copy wins over background refetches.
  const [localText, setLocalText] = useState<string | null>(null);
  const [confirmedNotDelivered, setConfirmedNotDelivered] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The parent keys this card by draft id, so a new revision gets fresh editor
  // state while a refetch of the same revision never discards in-progress typing.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const now = new Date(nowMs);
  const text = localText ?? draft.workingText ?? draft.suggestedText ?? "";
  const gate = approvalGate({ thread, draft, text, sendEnabled, mutationPending, now });
  const stale = isStale(thread, draft);
  const drafting = draft.status === "queued" || draft.status === "generating";
  const uncertain = draft.status === "send_uncertain";
  const failedSend = draft.status === "send_failed";
  const followUp = draft.kind === "engagement_follow_up";
  const expired =
    draft.status === "expired" ||
    (followUp && draft.expiresAt !== null && now >= new Date(draft.expiresAt));
  const cancelled = followUp && draft.status === "superseded";
  const terminal = expired || cancelled;
  const policyOutdated = !draft.promptPolicyCurrent;
  const canEdit = draft.status === "pending_approval" && !stale && !terminal && !policyOutdated;
  const canRegenerate =
    (draft.status === "pending_approval" || draft.status === "generation_failed") &&
    !stale &&
    !terminal &&
    !policyOutdated;
  const visibleStatus = expired ? "expired" : draft.status;

  return (
    <Card className="border-brand/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5" />
            {draftStatusLabel(visibleStatus, draft.kind)}
            {draft.revision > 1 && <span className="opacity-60">· v{draft.revision}</span>}
          </span>
          {draft.confidence && !drafting && (
            <span className="text-xs text-muted-foreground">
              confidence: {draft.confidence}
            </span>
          )}
        </div>

        {followUp && draft.status === "queued" && (
          <p className="text-xs text-muted-foreground">
            Eligible at {new Date(draft.eligibleAt).toLocaleString()} ·{" "}
            {formatCountdown(new Date(draft.eligibleAt).getTime() - nowMs)}
          </p>
        )}

        {followUp && draft.expiresAt && (
          <p className="text-xs text-muted-foreground">
            Send by {new Date(draft.expiresAt).toLocaleString()}
          </p>
        )}

        {followUp && (
          <p className="text-xs text-muted-foreground">
            {draft.promptVersion === null
              ? "Prompt policy unavailable"
              : `Prompt policy v${draft.promptVersion}`}
          </p>
        )}

        {followUp && draft.sourceGuide && (
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <p>
              Following up on <strong className="text-foreground">{draft.sourceGuide.name}</strong>
              {draft.sourceGuide.keyword ? ` · ${draft.sourceGuide.keyword}` : ""}
              {draft.sourceGuide.kind ? ` · ${draft.sourceGuide.kind}` : ""}
            </p>
            {draft.sourceGuide.description && <p className="mt-1">{draft.sourceGuide.description}</p>}
          </div>
        )}

        {props.actionErrorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{props.actionErrorMessage}</span>
          </div>
        )}

        {policyOutdated && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>This draft uses an older prompt policy and can no longer be used.</span>
          </div>
        )}

        {expired && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>The Instagram reply window has closed.</span>
          </div>
        )}

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
            {followUp && draft.status === "queued"
              ? "Waiting to write…"
              : followUp
                ? "Writing follow-up…"
                : "Writing a suggestion…"}
          </p>
        ) : draft.workingText || draft.suggestedText ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setLocalText(e.target.value)}
              onBlur={() => {
                const trimmed = text.trim();
                if (canEdit && trimmed !== (draft.workingText ?? "")) props.onEdit(trimmed);
              }}
              rows={4}
              disabled={!canEdit}
              className="w-full resize-y rounded-md border bg-transparent p-3 text-sm outline-none focus:border-foreground/40 disabled:opacity-60"
              aria-label={followUp ? "Follow-up draft" : "Reply draft"}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{draft.rationale}</span>
              <span className={text.trim().length > MAX_REPLY_LENGTH ? "text-destructive" : ""}>
                {text.trim().length}/{MAX_REPLY_LENGTH}
              </span>
            </div>
          </>
        ) : null}

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

        {!sendEnabled && !terminal && !drafting && (
          <p className="text-xs text-muted-foreground">
            Sending is turned off for this environment.
          </p>
        )}

        {terminal || drafting ? null : (uncertain || failedSend) && !policyOutdated ? (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmedNotDelivered}
                onChange={(e) => setConfirmedNotDelivered(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I checked Instagram — this {followUp ? "follow-up" : "reply"} was not delivered.
              </span>
            </label>
            <Button
              variant="brand"
              disabled={!confirmedNotDelivered || mutationPending || !sendEnabled || expired}
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
              onClick={() => props.onApprove(text.trim())}
            >
              {mutationPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Send className="mr-2 size-4" />
              )}
              Approve &amp; Send
            </Button>
            {canRegenerate && (
              <Button variant="outline" disabled={mutationPending} onClick={props.onRegenerate}>
                <RotateCw className="mr-2 size-4" />
                Try another
              </Button>
            )}
            {(draft.status === "pending_approval" || draft.status === "generation_failed") && (
              <Button variant="ghost" disabled={mutationPending} onClick={props.onDismiss}>
                <Trash2 className="mr-2 size-4" />
                Dismiss
              </Button>
            )}
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

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "Ready now";
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `Ready in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Ready in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `Ready in ${hours}h`;
}
