import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCw, Unlock } from "lucide-react";
import { apiErrorCode, apiMutation } from "@/lib/api";
import type { GuideAccessReview } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const ERROR_GUIDANCE: Record<string, string> = {
  access_attempt_not_found: "This request already changed. Refresh the conversation.",
  access_attempt_delivering:
    "A guide delivery may already be in progress. Resolve that delivery first.",
  access_attempt_needs_review:
    "Instagram did not confirm whether the refreshed action was sent. Do not repeat it automatically.",
  messaging_window_closed:
    "Instagram's messaging window has closed. A fresh message from the parent is required.",
  owner_auth_required: "Your session expired. Sign in again to resolve this request.",
};

export function GuideAccessReviewCard({
  threadId,
  review,
}: {
  threadId: string;
  review: GuideAccessReview;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"resend" | "release" | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dm-thread", threadId] }),
      queryClient.invalidateQueries({ queryKey: ["dm-threads"] }),
      queryClient.invalidateQueries({ queryKey: ["funnels", "guide-access-metrics"] }),
    ]);
  }

  function settled(error: unknown) {
    setErrorCode(error ? (apiErrorCode(error) ?? "unknown") : null);
    setDialog(null);
    void refresh();
  }

  const resend = useMutation({
    mutationFn: () =>
      apiMutation<void>(
        `/guide-deliveries/access/${review.conversationId}/resend-action`,
        {
          method: "POST",
          body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
        },
      ),
    retry: false,
    onSettled: (_data, error) => settled(error),
  });
  const release = useMutation({
    mutationFn: () =>
      apiMutation<void>(`/guide-deliveries/access/${review.conversationId}/release`, {
        method: "POST",
        body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
      }),
    retry: false,
    onSettled: (_data, error) => settled(error),
  });
  const busy = resend.isPending || release.isPending;
  const message = errorCode
    ? (ERROR_GUIDANCE[errorCode] ?? "That action did not complete. Refresh the conversation.")
    : null;

  return (
    <Card className="border-caution/40">
      <CardContent className="space-y-3 p-4">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <AlertCircle className="size-4 text-caution" />
            Guide access needs review
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {review.resourceName} · {review.followCheckCount} access checks
          </p>
        </div>
        {!review.messagingWindowOpen ? (
          <p className="text-xs text-muted-foreground">
            Instagram&apos;s messaging window has closed. Wait for a fresh parent message.
          </p>
        ) : null}
        {review.lastFollowResult === "follower" ? (
          <p className="text-xs text-muted-foreground">
            A delivery may already have started. Resolve the delivery review instead.
          </p>
        ) : null}
        {message ? <p role="alert" className="text-xs text-destructive">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!review.canResendAction || busy}
            onClick={() => setDialog("resend")}
          >
            <RotateCw className="mr-2 size-3.5" />
            Resend action
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!review.canRelease || busy}
            onClick={() => setDialog("release")}
          >
            <Unlock className="mr-2 size-3.5" />
            Release request
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={dialog === "resend"}
        title="Send a fresh action?"
        description="The earlier action may already have reached this parent. Send one fresh opening only if you accept that it can appear twice. The guide still requires a live follow check."
        confirmLabel="Send fresh action"
        busy={resend.isPending}
        onConfirm={() => resend.mutate()}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "release"}
        title="Release this request?"
        description="This removes the blocked request without sending anything. The parent's next message starts a new access check and may repeat an earlier prompt."
        confirmLabel="Release request anyway"
        busy={release.isPending}
        onConfirm={() => release.mutate()}
        onCancel={() => setDialog(null)}
      />
    </Card>
  );
}
