import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, RotateCw, Trash2 } from "lucide-react";
import { api, apiErrorCode } from "@/lib/api";
import type {
  GuideDeliveryReview,
  GuideDeliveryReviewUnit,
  GuideDeliveryReviewUnitStatus,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * The owner's resolution surface for a guide delivery the automation could not
 * finish by itself.
 *
 * Three things make this card different from the draft card beside it. It never
 * shows content — only which message number, of what kind, in what state — because
 * the decision is about delivery, not about wording, and the server deliberately
 * withholds snapshots. Retry is the only action guarded by a dialog, because retry
 * is the only action that can produce a duplicate on a real person's phone. And
 * every enabled/disabled state mirrors what the server would actually accept, so a
 * button never promises a transition that would come back rejected.
 */
export const CLOSED_WINDOW_MESSAGE =
  "Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.";

/**
 * Stable server codes, mapped to what the owner can do about them. Anything
 * unmapped falls back to a plain statement rather than an HTTP status.
 */
const ERROR_GUIDANCE: Record<string, string> = {
  delivery_not_found: "This delivery no longer exists. Refresh the conversation.",
  unit_not_found: "This message is no longer part of the delivery. Refresh the conversation.",
  delivery_state_changed:
    "This delivery changed while you were reviewing it. Refresh to see its current state.",
  messaging_window_closed: CLOSED_WINDOW_MESSAGE,
  duplicate_risk_acknowledgement_required:
    "Retrying needs the duplicate risk confirmed. Open Retry unit again.",
  owner_auth_required: "Your session expired. Sign in again to resolve this delivery.",
};

const UNIT_STATUS_LABEL: Record<GuideDeliveryReviewUnitStatus, string> = {
  pending: "Not sent yet",
  sending: "Sending",
  sent: "Delivered",
  retryable: "Queued to retry",
  failed: "Failed",
  uncertain: "Outcome unknown",
  cancelled: "Cancelled",
};

export function GuideDeliveryReviewCard({
  threadId,
  review,
}: {
  threadId: string;
  review: GuideDeliveryReview;
}) {
  const queryClient = useQueryClient();
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pendingRetryUnitId, setPendingRetryUnitId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dm-thread", threadId] }),
      queryClient.invalidateQueries({ queryKey: ["dm-threads"] }),
      queryClient.invalidateQueries({ queryKey: ["conversation-counts"] }),
    ]);
  }

  function onSettledAction(error: unknown) {
    // A rejection is recorded, never retried: the first request may already have
    // reached Instagram, so a second one is the owner's decision alone.
    setErrorCode(error ? (apiErrorCode(error) ?? "unknown") : null);
    void refreshAll();
  }

  const confirmDelivered = useMutation({
    mutationFn: (unitId: string) =>
      api<void>(`/guide-deliveries/${review.id}/units/${unitId}/confirm-delivered`, {
        method: "POST",
      }),
    retry: false,
    onSettled: (_data, error) => onSettledAction(error),
  });

  const retryUnit = useMutation({
    mutationFn: (unitId: string) =>
      api<void>(`/guide-deliveries/${review.id}/units/${unitId}/retry`, {
        method: "POST",
        body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
      }),
    retry: false,
    onSettled: (_data, error) => onSettledAction(error),
  });

  const cancelDelivery = useMutation({
    mutationFn: () => api<void>(`/guide-deliveries/${review.id}/cancel`, { method: "POST" }),
    retry: false,
    onSettled: (_data, error) => onSettledAction(error),
  });

  const busy = confirmDelivered.isPending || retryUnit.isPending || cancelDelivery.isPending;

  // The server accepts a unit action only while the delivery still says
  // needs_review and the unit is still uncertain. Once it has sealed the delivery
  // as failed, both unit actions would come back rejected, so neither is offered.
  const sealed = review.status === "failed";
  const canConfirm = !sealed && !busy;
  const canRetry = !sealed && review.sendWindowOpen && !busy;
  const windowClosed = sealed || !review.sendWindowOpen;

  const message = errorCode
    ? (ERROR_GUIDANCE[errorCode] ?? "That action did not complete. Refresh the conversation.")
    : null;

  return (
    <Card className="border-caution/40">
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <AlertCircle className="size-4 text-caution" />
            {sealed ? "Delivery failed" : "Delivery needs review"}
          </div>
          <p className="text-xs text-muted-foreground">
            {review.confirmedUnits} of {review.totalUnits} messages confirmed
          </p>
        </div>

        {windowClosed && <p className="text-xs text-muted-foreground">{CLOSED_WINDOW_MESSAGE}</p>}

        <ul className="space-y-1.5">
          {review.units.map((unit) => (
            <UnitRow
              key={unit.id}
              unit={unit}
              canConfirm={canConfirm}
              canRetry={canRetry}
              onConfirm={() => confirmDelivered.mutate(unit.id)}
              onRetry={() => setPendingRetryUnitId(unit.id)}
            />
          ))}
        </ul>

        {message && (
          <p role="alert" className="text-xs text-destructive">
            {message}
          </p>
        )}

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmingCancel(true)}
        >
          <Trash2 className="mr-2 size-3.5" />
          Cancel delivery
        </Button>
      </CardContent>

      <ConfirmDialog
        open={pendingRetryUnitId !== null}
        title="Retry this message?"
        description="Instagram may have already delivered this message — its outcome was never confirmed. Retrying can send it a second time."
        confirmLabel="Retry anyway"
        busy={retryUnit.isPending}
        onConfirm={() => {
          if (pendingRetryUnitId) retryUnit.mutate(pendingRetryUnitId);
          setPendingRetryUnitId(null);
        }}
        onCancel={() => setPendingRetryUnitId(null)}
      />

      <ConfirmDialog
        open={confirmingCancel}
        title="Cancel this delivery?"
        description="Messages already delivered stay delivered. Everything still unsent is cancelled and will not be sent later."
        confirmLabel="Cancel delivery anyway"
        destructive
        busy={cancelDelivery.isPending}
        onConfirm={() => {
          cancelDelivery.mutate();
          setConfirmingCancel(false);
        }}
        onCancel={() => setConfirmingCancel(false)}
      />
    </Card>
  );
}

/**
 * One message in the plan. Actions appear only on an uncertain unit, because that
 * is the only state the server will act on — a sent unit needs nothing and a
 * pending one resolves by itself once the delivery resumes.
 */
function UnitRow({
  unit,
  canConfirm,
  canRetry,
  onConfirm,
  onRetry,
}: {
  unit: GuideDeliveryReviewUnit;
  canConfirm: boolean;
  canRetry: boolean;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const undecided = unit.status === "uncertain";
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        {/* Wire positions are zero-based; owners count from one. */}
        <span className="text-xs font-medium">Message {unit.position + 1}</span>
        <span className="text-xs text-muted-foreground">{unit.kind}</span>
        <span className="truncate text-xs text-muted-foreground">
          {UNIT_STATUS_LABEL[unit.status]}
        </span>
      </div>
      {undecided && (
        <div className="flex shrink-0 gap-1.5">
          <Button variant="outline" size="sm" disabled={!canConfirm} onClick={onConfirm}>
            <Check className="mr-1.5 size-3.5" />
            Already delivered
          </Button>
          <Button variant="outline" size="sm" disabled={!canRetry} onClick={onRetry}>
            <RotateCw className="mr-1.5 size-3.5" />
            Retry unit
          </Button>
        </div>
      )}
    </li>
  );
}
