import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatAbsolute } from "../../lib/utils";
import { useEffect, useState } from "react";
import { ApiError, recoveryApi } from "../../lib/api";
import { STILL_CONFIRMING_MESSAGE, isUnknownOutcome } from "../../lib/unknownOutcome";
import type { RecoveryReminderDetail } from "../../lib/types";
import { recoveryStatusView } from "./dmRecoveryViewModel";

/**
 * Shown when the worker changed the row between load and click.
 *
 * A 409 is not an error the owner can fix by trying again — the reminder they
 * were looking at no longer exists in that state. Saying so and refetching is
 * the only honest response; a generic failure would invite a retry that must
 * also fail.
 */
export const RECOVERY_CONFLICT_MESSAGE =
  "This reminder changed before your action. Refreshing…";

/** How long the conflict message stays up before the stale view is dismissed. */
const CONFLICT_CLOSE_DELAY_MS = 1500;

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

export function DmRecoveryDrawer({
  id,
  onClose,
  onOpenUser,
}: {
  id: string;
  onClose: () => void;
  onOpenUser?: (igUserId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [conflicted, setConflicted] = useState(false);

  // The row is gone in the shape the owner acted on, so the stale view is closed
  // rather than left showing controls that can only 409 again.
  useEffect(() => {
    if (!conflicted) return;
    const timer = setTimeout(onClose, CONFLICT_CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conflicted, onClose]);

  const detailQ = useQuery<RecoveryReminderDetail>({
    queryKey: ["recovery-reminders", "detail", id],
    queryFn: ({ signal }) => recoveryApi.detail(id, { signal }),
  });

  // Both actions can lose a race with the worker, so the whole recovery tree is
  // invalidated rather than patched: the server's answer is the only one that
  // counts, and a stale badge next to a changed row is worse than a refetch.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["recovery-reminders"] });

  // A lost race is a different outcome from a failed request: one is the
  // worker having moved on, the other is worth retrying.
  const onConflict = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) setConflicted(true);
  };

  const cancelM = useMutation({
    mutationFn: () => recoveryApi.cancel(id),
    onError: onConflict,
    onSettled: () => {
      setConfirmingCancel(false);
      return refresh();
    },
  });

  const reviewM = useMutation({
    mutationFn: () => recoveryApi.markReviewed(id),
    onError: onConflict,
    onSettled: refresh,
  });

  // An unknown outcome is not a failure and must not offer a retry: this action
  // publishes a public comment, and the request may already have done so. The whole
  // recovery tree is refetched on settle, so the server's state is what appears.
  const unresolved = [cancelM, reviewM].some((m) => isUnknownOutcome(m.error));
  const retryableError = unresolved
    ? undefined
    : [cancelM, reviewM].find((m) => m.error instanceof ApiError && m.error.status !== 409);

  if (detailQ.isPending) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (detailQ.isError || !detailQ.data) {
    return <div className="p-4 text-sm text-urgent">Couldn’t load this reminder.</div>;
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
          {" · "}
          {row.media.permalink ? (
            <a href={row.media.permalink} className="underline" target="_blank" rel="noreferrer">
              View post
            </a>
          ) : (
            <span>Original post unavailable</span>
          )}
        </p>
        {state.actionState ? (
          <p className="label-caps text-foreground">{state.actionState}</p>
        ) : null}
        <p className="font-medium">{state.label}</p>
        <p className="text-xs text-muted-foreground">{state.description}</p>
      </header>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What happened
        </h3>

        {row.comment ? (
          <p className="rounded-md border px-3 py-2 text-xs">
            <span className="text-muted-foreground">Comment · {formatAbsolute(row.comment.receivedAt)}</span>
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
              <span className="shrink-0 text-muted-foreground">{formatAbsolute(entry.at)}</span>
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

      {row.triggerKind === "settings_blocked" && row.settingsEvidence ? (
        <section className="space-y-2 rounded-md border px-3 py-2 text-xs">
          <h3 className="font-semibold">Verified settings evidence</h3>
          {row.settingsEvidence.status === "missing" ? (
            <p className="text-urgent">
              Verification evidence missing. This legacy reminder cannot establish which controlled
              Graph signature justified the settings-specific copy.
            </p>
          ) : (
            <>
              <p>
                <span className="text-muted-foreground">Status · </span>
                <span className={row.settingsEvidence.status === "current" ? "text-signal" : "text-urgent"}>
                  {row.settingsEvidence.status}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">Version · </span>
                {row.settingsEvidence.version} · {row.settingsEvidence.graphCode}:
                {row.settingsEvidence.graphSubcode}
              </p>
              <p>
                <span className="text-muted-foreground">Verified · </span>
                {row.settingsEvidence.verifiedAt
                  ? formatAbsolute(row.settingsEvidence.verifiedAt)
                  : "unknown"}
                {row.settingsEvidence.validUntil
                  ? ` · valid until ${formatAbsolute(row.settingsEvidence.validUntil)}`
                  : null}
              </p>
              <p className="break-all">
                <span className="text-muted-foreground">Evidence · </span>
                {row.settingsEvidence.evidenceReference}
              </p>
              <p className="break-all text-muted-foreground">
                SHA-256 · {row.settingsEvidence.evidenceSha256}
              </p>
              {row.settingsEvidence.status !== "current" ? (
                <p className="text-urgent">
                  This evidence is {row.settingsEvidence.status}; new settings-specific reminders are blocked.
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {conflicted ? (
        <p role="status" className="rounded-md border border-caution bg-caution-soft px-3 py-2 text-xs text-caution">
          {RECOVERY_CONFLICT_MESSAGE}
        </p>
      ) : unresolved ? (
        <div role="alert" className="rounded-md border border-caution bg-caution-soft px-3 py-2 text-xs">
          <p className="text-caution">{STILL_CONFIRMING_MESSAGE}</p>
          <p className="mt-1 text-muted-foreground">
            Nothing was retried. This reminder will show its real state once confirmed.
          </p>
        </div>
      ) : retryableError ? (
        <div role="alert" className="rounded-md border border-urgent bg-urgent-soft px-3 py-2 text-xs">
          <p className="text-urgent">Couldn’t complete that action.</p>
          <button
            type="button"
            onClick={() => retryableError.mutate()}
            className="mt-2 rounded-md border px-2 py-1 hover:bg-accent/20"
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.canCancel || state.canMarkReviewed || onOpenUser ? (
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
          {onOpenUser ? (
            <button
              type="button"
              onClick={() => onOpenUser(row.igUserId)}
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent/20"
            >
              View user journey
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
        // alertdialog, not dialog: this confirms a destructive action, and it
        // lives inside the Drawer, which is already the modal. Two nested
        // aria-modal regions leave a screen reader with no single answer to
        // "what am I in", so the modality stays on the Drawer alone.
        <div
          role="alertdialog"
          aria-label="Cancel this reminder?"
          className="rounded-lg border bg-background p-3"
        >
          <p className="text-sm font-medium">Cancel this reminder?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This prevents a future public-comment attempt. It cannot remove a comment that Instagram
            already accepted.
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
