import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import type { DmThreadDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { IncomingBubble, OutgoingBubble } from "@/components/ChatBubbles";
import { displayUser } from "@/lib/utils";
import { ReplyDraftCard } from "./ReplyDraftCard";
import { isVisibleDraft } from "./replyDraftView";

/**
 * The real message thread plus its approval surface.
 *
 * Every mutation invalidates the list, this detail, and the journey counts, so a
 * newer inbound arriving mid-review immediately disables approval rather than
 * letting the owner send a reply to a superseded message.
 */
export function DmThreadDrawer({
  threadId,
  sendEnabled,
  onClose,
}: {
  threadId: string | null;
  sendEnabled: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const detailQ = useQuery<DmThreadDetail>({
    queryKey: ["dm-thread", threadId],
    queryFn: () => api<DmThreadDetail>(`/dm-threads/${threadId}`),
    enabled: threadId !== null,
  });

  const thread = detailQ.data;
  const draft = thread?.draft ?? null;

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dm-threads"] }),
      queryClient.invalidateQueries({ queryKey: ["dm-thread", threadId] }),
      queryClient.invalidateQueries({ queryKey: ["conversation-counts"] }),
    ]);
  }

  function handleMutationError(error: Error) {
    if (isErrorCode(error, "follow_up_window_closed")) void refreshAll();
  }

  const draftPath = (action: string) =>
    `/ai/dm-threads/${threadId}/drafts/${draft?.id}${action}`;

  const edit = useMutation({
    mutationFn: (workingText: string) =>
      api<void>(draftPath(""), { method: "PATCH", body: JSON.stringify({ workingText }) }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const regenerate = useMutation({
    mutationFn: () => api<void>(draftPath("/regenerate"), { method: "POST" }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const dismiss = useMutation({
    mutationFn: () => api<void>(draftPath("/dismiss"), { method: "POST" }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const generate = useMutation({
    mutationFn: () => api<void>(`/ai/dm-threads/${threadId}/drafts`, { method: "POST" }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const approve = useMutation({
    mutationFn: (workingText: string) =>
      api<void>(draftPath("/approve"), { method: "POST", body: JSON.stringify({ workingText }) }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const retry = useMutation({
    mutationFn: () =>
      api<void>(draftPath("/retry-send"), {
        method: "POST",
        body: JSON.stringify({ confirmedNotDelivered: true }),
      }),
    onSuccess: refreshAll,
    onError: handleMutationError,
  });

  const mutationPending =
    edit.isPending ||
    regenerate.isPending ||
    dismiss.isPending ||
    approve.isPending ||
    retry.isPending ||
    generate.isPending;
  const windowClosedError = [
    edit.error,
    regenerate.error,
    dismiss.error,
    approve.error,
    retry.error,
    generate.error,
  ].some((error) => isErrorCode(error, "follow_up_window_closed"));
  const terminalFollowUp =
    draft?.kind === "engagement_follow_up" &&
    (draft.status === "expired" || draft.status === "superseded");

  return (
    <Drawer open={threadId !== null} onClose={onClose}>
      {!thread ? (
        <p className="p-5 text-sm text-muted-foreground">Loading conversation…</p>
      ) : (
        <div className="space-y-4 p-5">
          <div>
            <h3 className="text-base font-semibold">
              {displayUser(thread.igUserId, { username: thread.username, name: thread.name })}
            </h3>
            {thread.name && <p className="text-sm text-muted-foreground">{thread.name}</p>}
          </div>

          <div className="space-y-2">
            {thread.messages.map((m) =>
              m.direction === "inbound" ? (
                <IncomingBubble key={m.id} text={m.text ?? `[${m.type}]`} />
              ) : (
                <OutgoingBubble key={m.id} text={m.text ?? `[${m.type}]`} />
              ),
            )}
          </div>

          {isVisibleDraft(draft) && draft && (
            <ReplyDraftCard
              key={draft.id}
              thread={thread}
              draft={draft}
              sendEnabled={sendEnabled}
              mutationPending={mutationPending}
              windowClosedError={windowClosedError}
              onEdit={(t) => edit.mutate(t)}
              onRegenerate={() => regenerate.mutate()}
              onDismiss={() => dismiss.mutate()}
              onApprove={(t) => approve.mutate(t)}
              onRetry={() => retry.mutate()}
            />
          )}
          {thread.needsReply && (!isVisibleDraft(draft) || terminalFollowUp) ? (
            <Button
              variant="outline"
              disabled={mutationPending}
              onClick={() => generate.mutate()}
            >
              <Sparkles className="mr-2 size-4" />
              Draft a reply
            </Button>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function isErrorCode(error: unknown, code: string): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return (
    typeof error.body === "object" &&
    error.body !== null &&
    "error" in error.body &&
    (error.body as { error: unknown }).error === code
  );
}
