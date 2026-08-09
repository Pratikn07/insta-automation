import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api, apiErrorCode } from "@/lib/api";
import type { GuideDeliveryReview, GuideDeliveryReviewUnit } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const CLOSED_WINDOW_MESSAGE =
  "Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.";

function guideDeliveryReviewErrorMessage(code: string | null): string {
  switch (code) {
    case "delivery_not_found":
      return "This delivery no longer exists. Refresh the conversation.";
    case "unit_not_found":
      return "This message is no longer available for review. Refresh the conversation.";
    case "delivery_state_changed":
      return "This delivery changed before the action completed. Refresh and review its latest status.";
    case "messaging_window_closed":
      return CLOSED_WINDOW_MESSAGE;
    case "duplicate_risk_acknowledgement_required":
      return "Confirm the duplicate-delivery risk before retrying this message.";
    default:
      return "This action could not be completed. Refresh and try again.";
  }
}

type PendingAction =
  | { kind: "confirm"; unit: GuideDeliveryReviewUnit }
  | { kind: "retry"; unit: GuideDeliveryReviewUnit }
  | { kind: "cancel" };

type DialogAction = Extract<PendingAction, { kind: "retry" | "cancel" }>;

const UNIT_KIND_LABEL: Record<GuideDeliveryReviewUnit["kind"], string> = {
  text: "Text",
  image: "Image",
  file: "File",
};

export function GuideDeliveryReviewCard({
  review,
  threadId,
}: {
  review: GuideDeliveryReview;
  threadId: string;
}) {
  const queryClient = useQueryClient();
  const [dialogAction, setDialogAction] = useState<DialogAction | null>(null);
  const [errorCode, setErrorCode] = useState<string | null | undefined>(undefined);

  const action = useMutation({
    mutationFn: (pending: PendingAction) => {
      if (pending.kind === "cancel") {
        return api<void>(`/guide-deliveries/${review.id}/cancel`, { method: "POST" });
      }
      const path = `/guide-deliveries/${review.id}/units/${pending.unit.id}`;
      if (pending.kind === "confirm") {
        return api<void>(`${path}/confirm-delivered`, { method: "POST" });
      }
      return api<void>(`${path}/retry`, {
        method: "POST",
        body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
      });
    },
    onSuccess: async () => {
      setErrorCode(undefined);
      setDialogAction(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dm-thread", threadId] }),
        queryClient.invalidateQueries({ queryKey: ["dm-threads"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation-counts"] }),
      ]);
    },
    onError: (error) => {
      setErrorCode(apiErrorCode(error));
      setDialogAction(null);
    },
  });

  const uncertainUnits = review.units.filter((unit) => unit.status === "uncertain");
  const unsentUnitCount = review.units.filter((unit) => unit.status !== "sent").length;

  function unitDescription(unit: GuideDeliveryReviewUnit): string {
    return `message ${unit.position + 1} (${UNIT_KIND_LABEL[unit.kind]})`;
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="gap-1 pb-3">
        <div className="flex items-center gap-2 text-amber-300">
          <AlertTriangle className="size-4 shrink-0" />
          <h4 className="text-sm font-semibold">Delivery needs review</h4>
        </div>
        <p className="text-xs text-muted-foreground">
          {review.confirmedUnits} of {review.totalUnits} messages confirmed
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!review.sendWindowOpen && (
          <p className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-200">
            {CLOSED_WINDOW_MESSAGE}
          </p>
        )}

        {uncertainUnits.map((unit) => {
          const description = unitDescription(unit);
          const confirmDisabled =
            action.isPending || (!review.sendWindowOpen && unsentUnitCount > 1);
          return (
            <div
              key={unit.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card/60 p-3"
            >
              <p className="text-sm font-medium">
                Message {unit.position + 1} · {UNIT_KIND_LABEL[unit.kind]}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Already delivered for ${description} in delivery ${review.id}`}
                  disabled={confirmDisabled}
                  onClick={() => action.mutate({ kind: "confirm", unit })}
                >
                  Already delivered
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Retry unit for ${description} in delivery ${review.id}`}
                  disabled={action.isPending || !review.sendWindowOpen}
                  onClick={() => setDialogAction({ kind: "retry", unit })}
                >
                  Retry unit
                </Button>
              </div>
            </div>
          );
        })}

        {errorCode !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {guideDeliveryReviewErrorMessage(errorCode)}
          </p>
        )}

        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-label={`Cancel delivery ${review.id}`}
          disabled={action.isPending}
          onClick={() => setDialogAction({ kind: "cancel" })}
        >
          Cancel delivery
        </Button>
      </CardContent>

      <ConfirmDialog
        open={dialogAction?.kind === "retry"}
        title={
          dialogAction?.kind === "retry"
            ? `Retry message ${dialogAction.unit.position + 1}?`
            : "Retry message?"
        }
        description="Instagram may already have delivered this message. Retrying can send a duplicate."
        confirmLabel="Retry anyway"
        cancelLabel="Keep delivery as is"
        busy={action.isPending}
        onCancel={() => {
          if (!action.isPending) setDialogAction(null);
        }}
        onConfirm={() => {
          if (dialogAction?.kind === "retry" && !action.isPending) {
            action.mutate(dialogAction);
          }
        }}
      />

      <ConfirmDialog
        open={dialogAction?.kind === "cancel"}
        title="Cancel this delivery?"
        description="This stops the remaining messages. It cannot undo messages Instagram may already have delivered."
        confirmLabel="Cancel delivery"
        cancelLabel="Keep delivery"
        destructive
        busy={action.isPending}
        onCancel={() => {
          if (!action.isPending) setDialogAction(null);
        }}
        onConfirm={() => {
          if (dialogAction?.kind === "cancel" && !action.isPending) {
            action.mutate(dialogAction);
          }
        }}
      />
    </Card>
  );
}
