import { AlertCircle, Loader2, MessageCircle, Send, Sparkles } from "lucide-react";
import type { DmThreadRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { cn, displayUser } from "@/lib/utils";
import { draftStatusLabel, rowState } from "./replyDraftView";

/**
 * The DM list. Deliberately mirrors the existing automation-journey row shape, so
 * the page reads as one thing seen through two lenses.
 */
export interface DmThreadListProps {
  rows: DmThreadRow[];
  isLoading: boolean;
  onSelect: (row: DmThreadRow) => void;
}

const STATE_META: Record<
  ReturnType<typeof rowState>,
  { label: string; tone: string; Icon: typeof MessageCircle }
> = {
  drafting: { label: "Drafting", tone: "text-sky-400 bg-sky-400/10", Icon: Loader2 },
  draft_ready: { label: "Draft ready", tone: "text-brand bg-brand/10", Icon: Sparkles },
  needs_review: { label: "Needs review", tone: "text-amber-400 bg-amber-400/10", Icon: AlertCircle },
  send_failed: { label: "Send failed", tone: "text-destructive bg-destructive/10", Icon: AlertCircle },
  replied: { label: "Replied", tone: "text-emerald-400 bg-emerald-400/10", Icon: Send },
  automated: { label: "Automated", tone: "text-muted-foreground bg-muted/40", Icon: MessageCircle },
};

export function DmThreadList({ rows, isLoading, onSelect }: DmThreadListProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Loading conversations…
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <MessageCircle className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing needs a reply</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Real DMs appear here as they arrive, with a suggested reply for you to approve.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const state = rowState(row);
        const meta = STATE_META[state];
        const preview = row.latestMessage?.text ?? previewForType(row);
        return (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelect(row)}
            className="flex w-full items-start gap-3 rounded-lg border bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/30"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {displayUser(row.igUserId, { username: row.username, name: row.name })}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    meta.tone,
                  )}
                >
                  <meta.Icon className={cn("size-3", state === "drafting" && "animate-spin")} />
                  {row.draft?.kind === "engagement_follow_up"
                    ? draftStatusLabel(row.draft.status, row.draft.kind)
                    : meta.label}
                </span>
                {row.deliveryReviewCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                    <AlertCircle className="size-3" />
                    Delivery needs review
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{preview}</p>
              {row.draft && state !== "needs_review" && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                  {draftStatusLabel(row.draft.status, row.draft.kind)}
                  {row.draft.workingText ? ` — ${row.draft.workingText}` : ""}
                </p>
              )}
            </div>
            <time className="shrink-0 text-xs text-muted-foreground">
              {new Date(row.lastMessageAt).toLocaleDateString()}
            </time>
          </button>
        );
      })}
    </div>
  );
}

/** Meta omits text for media, so say what arrived rather than showing nothing. */
function previewForType(row: DmThreadRow): string {
  const type = row.latestMessage?.type;
  if (!type || type === "text") return "(no text)";
  return `[${type}]`;
}
