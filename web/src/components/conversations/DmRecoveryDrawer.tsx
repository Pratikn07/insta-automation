import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { recoveryApi } from "../../lib/api";
import type { RecoveryReminderDetail } from "../../lib/types";
import { recoveryStatusView } from "./dmRecoveryViewModel";

/** Narrative labels for the stored timestamps the API returns. */
const TIMELINE_LABELS: Record<string, string> = {
  created: "Journey opened",
  accepted: "Gate DM accepted",
  eligible: "Monitoring window closed",
  seen: "Seen",
  engaged: "Engaged",
  replied: "Replied",
  reacted: "Reacted",
  postback: "Tapped a button",
  attempted: "Send attempted",
  sent: "Public reminder posted",
  suppressed: "Reminder withheld",
  cancelled: "Cancelled by owner",
  reviewed: "Reviewed",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DmRecoveryDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const detailQ = useQuery<RecoveryReminderDetail>({
    queryKey: ["recovery-reminders", "detail", id],
    queryFn: () => recoveryApi.detail(id),
  });

  // Both actions can lose a race with the worker, so the whole recovery tree is
  // invalidated rather than patched: the server's answer is the only one that
  // counts, and a stale badge next to a changed row is worse than a refetch.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["recovery-reminders"] });

  const cancelM = useMutation({
    mutationFn: () => recoveryApi.cancel(id),
    onSettled: () => {
      setConfirmingCancel(false);
      return refresh();
    },
  });

  const reviewM = useMutation({
    mutationFn: () => recoveryApi.markReviewed(id),
    onSettled: refresh,
  });

  if (detailQ.isPending) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (detailQ.isError || !detailQ.data) {
    return <div className="p-4 text-sm text-rose-200">Couldn’t load this reminder.</div>;
  }

  const row = detailQ.data;
  const state = recoveryStatusView(row, new Date());
  const hasReadEvidence = row.seenAt !== null || row.engagedAt !== null;

  return (
    <div className="space-y-5 p-4 text-sm">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">
          {row.username ? `@${row.username}` : row.igUserId}
        </h2>
        <p className="text-xs text-muted-foreground">
          {row.keyword.keyword}
          {row.media.permalink ? (
            <>
              {" · "}
              <a href={row.media.permalink} className="underline" target="_blank" rel="noreferrer">
                View post
              </a>
            </>
          ) : null}
        </p>
        <p className="font-medium">{state.label}</p>
        <p className="text-xs text-muted-foreground">{state.description}</p>
      </header>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What happened
        </h3>

        {row.comment ? (
          <p className="rounded-md border px-3 py-2 text-xs">
            <span className="text-muted-foreground">Comment · {formatWhen(row.comment.receivedAt)}</span>
            <br />
            {row.comment.text ? `“${row.comment.text}”` : "(no text captured)"}
          </p>
        ) : null}

        <ol className="space-y-1">
          {row.timeline.map((entry) => (
            <li key={`${entry.kind}-${entry.at}`} className="flex justify-between gap-3 text-xs">
              <span>
                {TIMELINE_LABELS[entry.kind] ?? entry.kind}
                {entry.detail ? (
                  <span className="text-muted-foreground"> · {entry.detail}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatWhen(entry.at)}</span>
            </li>
          ))}
        </ol>

        {!hasReadEvidence ? (
          // Stated as the absence of a receipt, which is all we know. Meta gives
          // no unread signal, so no stronger claim is available.
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            No read confirmation received
          </p>
        ) : null}
      </section>

      {state.canCancel || state.canMarkReviewed ? (
        <footer className="flex flex-wrap gap-2 border-t pt-3">
          {state.canCancel ? (
            <button
              type="button"
              onClick={() => setConfirmingCancel(true)}
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent/20"
            >
              Cancel reminder
            </button>
          ) : null}
          {state.canMarkReviewed ? (
            <button
              type="button"
              onClick={() => reviewM.mutate()}
              disabled={reviewM.isPending}
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent/20 disabled:opacity-50"
            >
              Mark reviewed
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/20"
          >
            Close
          </button>
        </footer>
      ) : null}

      {confirmingCancel ? (
        <div role="dialog" aria-modal="true" className="rounded-lg border bg-background p-3">
          <p className="text-sm font-medium">Cancel this reminder?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This will prevent a future public comment on their post. It cannot remove a comment that
            has already been posted.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => cancelM.mutate()}
              disabled={cancelM.isPending}
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent/20 disabled:opacity-50"
            >
              Yes, cancel it
            </button>
            <button
              type="button"
              onClick={() => setConfirmingCancel(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/20"
            >
              Keep reminder
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
